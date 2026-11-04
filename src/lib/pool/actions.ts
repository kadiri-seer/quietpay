/**
 * Shielded pool actions: verify the deployment, deposit from a one-time address, build a
 * relayed withdrawal (proof generated locally), and ragequit.
 */
import {
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import type { LocalAccount } from "viem/accounts";
import { erc20Abi } from "@/config/contracts";
import type { NetworkConfig } from "@/config/networks";
import {
  CommitmentVerifier,
  ERC1967Proxy,
  Entrypoint,
  PoseidonT3,
  PoseidonT4,
  PrivacyPoolComplex,
  WithdrawalVerifier,
} from "@/config/pool-contracts.generated";
import { VerificationError, waitForConfirmedReceipt } from "@/lib/chain";
export { SHIELD_GAS_BUDGET } from "./constants";
import { SHIELD_GAS_BUDGET } from "./constants";
import { depositSecrets, merkleProof, precommitmentHash, withdrawalSecrets, type PoolMasterKeys } from "./crypto";
import { encodeRelayData, proveRagequit, proveWithdrawal, withdrawalContext, type ArtifactLoader, type WithdrawProof, type Withdrawal } from "./prover";
import { currentApprovalSet, type PoolEvents, type PoolNote } from "./state";

/** EIP-1967 implementation slot. */
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function masked(code: Hex, masks: readonly (readonly [number, number])[]): Hex {
  const hex = code.slice(2).split("");
  for (const [start, length] of masks) for (let i = start * 2; i < (start + length) * 2; i++) hex[i] = "0";
  return `0x${hex.join("")}`;
}

async function codeMatches(client: PublicClient, address: Address, c: { maskedRuntimeCodeHash: string; masks: readonly (readonly [number, number])[] }) {
  const code = await client.getCode({ address });
  return !!code && code !== "0x" && keccak256(masked(code, c.masks)) === c.maskedRuntimeCodeHash;
}

/** The library address linked at the first reference offset, read from the deployed code. */
function linkedAddress(code: Hex, offset: number): Address {
  return getAddress(`0x${code.slice(2 + offset * 2, 2 + offset * 2 + 40)}`);
}

export interface PoolInfo {
  entrypoint: Address;
  pool: Address;
  scope: bigint;
  minimumDeposit: bigint;
  vettingFeeBPS: bigint;
  maxRelayFeeBPS: bigint;
  /** Latest approval (ASP) root. 0 if none published yet. */
  aspRoot: bigint;
  dead: boolean;
}

/**
 * Checks every pool contract against the compiled audited code before any deposit: the proxy,
 * its implementation, the pool, both verifiers and the linked Poseidon libraries, plus their
 * wiring (pool -> entrypoint, asset, verifiers; entrypoint -> pool for this token).
 */
export async function verifyPool(client: PublicClient, network: NetworkConfig): Promise<PoolInfo | null> {
  const cfg = network.pool;
  if (!cfg) return null;
  if (!network.token) throw new VerificationError("No token is configured.");
  const fail = (m: string): never => {
    throw new VerificationError(m);
  };

  if (!(await codeMatches(client, cfg.entrypoint, ERC1967Proxy))) fail("The pool entrypoint is not the expected proxy contract.");
  const slot = await client.getStorageAt({ address: cfg.entrypoint, slot: IMPLEMENTATION_SLOT });
  const impl = getAddress(`0x${(slot ?? "0x").slice(-40).padStart(40, "0")}`);
  if (!(await codeMatches(client, impl, Entrypoint))) fail("The pool entrypoint runs unexpected code.");

  const poolCode = await client.getCode({ address: cfg.pool });
  if (!poolCode || !(await codeMatches(client, cfg.pool, PrivacyPoolComplex))) fail("The pool contract is not the audited Privacy Pools code.");
  const t3 = linkedAddress(poolCode!, PrivacyPoolComplex.links.PoseidonT3[0]);
  const t4 = linkedAddress(poolCode!, PrivacyPoolComplex.links.PoseidonT4[0]);
  if (!(await codeMatches(client, t3, PoseidonT3)) || !(await codeMatches(client, t4, PoseidonT4))) fail("The pool's hash libraries are not the expected code.");

  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
  const [ep, asset, wv, rv, scope, dead] = await Promise.all([
    read<Address>(cfg.pool, PrivacyPoolComplex.abi, "ENTRYPOINT"),
    read<Address>(cfg.pool, PrivacyPoolComplex.abi, "ASSET"),
    read<Address>(cfg.pool, PrivacyPoolComplex.abi, "WITHDRAWAL_VERIFIER"),
    read<Address>(cfg.pool, PrivacyPoolComplex.abi, "RAGEQUIT_VERIFIER"),
    read<bigint>(cfg.pool, PrivacyPoolComplex.abi, "SCOPE"),
    read<boolean>(cfg.pool, PrivacyPoolComplex.abi, "dead"),
  ]);
  if (getAddress(ep) !== getAddress(cfg.entrypoint)) fail("The pool belongs to a different entrypoint.");
  if (getAddress(asset) !== getAddress(network.token)) fail("The pool holds a different token.");
  if (!(await codeMatches(client, wv, WithdrawalVerifier))) fail("The withdrawal verifier is not the ceremony verifier.");
  if (!(await codeMatches(client, rv, CommitmentVerifier))) fail("The exit verifier is not the ceremony verifier.");

  const [registered, config, aspRoot] = await Promise.all([
    read<Address>(cfg.entrypoint, Entrypoint.abi, "scopeToPool", [scope]),
    read<readonly [Address, bigint, bigint, bigint]>(cfg.entrypoint, Entrypoint.abi, "assetConfig", [network.token]),
    read<bigint>(cfg.entrypoint, Entrypoint.abi, "latestRoot").catch(() => 0n),
  ]);
  if (getAddress(registered) !== getAddress(cfg.pool) || getAddress(config[0]) !== getAddress(cfg.pool)) fail("The entrypoint does not route this token to this pool.");
  return { entrypoint: cfg.entrypoint, pool: cfg.pool, scope, minimumDeposit: config[1], vettingFeeBPS: config[2], maxRelayFeeBPS: config[3], aspRoot, dead };
}

/** Value credited to the note after the vetting fee. */
export const afterVettingFee = (amount: bigint, bps: bigint) => amount - (amount * bps) / 10_000n;

/**
 * Deposits `amount` from a one-time address into the pool: approve exactly `amount`, then
 * deposit with a precommitment derived from the user's pool keys. Gas comes from the address's
 * own ETH. Returns the deposit details read back from the receipt.
 */
export async function depositFromAccount(
  client: PublicClient,
  network: NetworkConfig,
  info: PoolInfo,
  p: { account: LocalAccount; keys: PoolMasterKeys; depositIndex: bigint; amount: bigint },
): Promise<{ hash: Hash; approveHash: Hash | null; label: bigint; commitment: bigint; value: bigint }> {
  const token = network.token!;
  if (info.dead) throw new Error("This pool no longer accepts deposits.");
  if (p.amount < info.minimumDeposit) throw new Error("That is below the pool's minimum deposit.");
  const secrets = depositSecrets(p.keys, info.scope, p.depositIndex);
  const precommitment = precommitmentHash(secrets);
  const used = (await client.readContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "usedPrecommitments", args: [precommitment] })) as boolean;
  if (used) throw new Error("Pool history is not fully loaded. Refresh and try again.");

  const wallet = createWalletClient({ account: p.account, chain: network.chain, transport: http(network.rpcUrl, { timeout: 20_000 }) });
  let approveHash: Hash | null = null;
  const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [p.account.address, info.entrypoint] });
  if (allowance < p.amount) {
    approveHash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [info.entrypoint, p.amount] });
    await waitForConfirmedReceipt(client, approveHash, { confirmations: network.confirmations });
  }
  const hash = await wallet.writeContract({
    address: info.entrypoint,
    abi: Entrypoint.abi,
    functionName: "deposit",
    args: [token, p.amount, precommitment],
  });
  const receipt = await waitForConfirmedReceipt(client, hash, { confirmations: network.confirmations });
  const ev = parseEventLogs({ abi: PrivacyPoolComplex.abi, logs: receipt.logs, eventName: "Deposited" }).find(
    (l) => getAddress(l.address) === getAddress(info.pool) && (l.args as { _precommitmentHash: bigint })._precommitmentHash === precommitment,
  );
  if (!ev) throw new Error("The deposit receipt has no matching pool deposit.");
  const a = ev.args as { _label: bigint; _commitment: bigint; _value: bigint };
  return { hash: receipt.transactionHash, approveHash, label: a._label, commitment: a._commitment, value: a._value };
}

export interface PreparedWithdrawal {
  withdrawal: Withdrawal;
  proof: WithdrawProof;
  scope: bigint;
  recipient: Address;
  amount: bigint;
  fee: bigint;
}

export class NotApprovedYetError extends Error {
  constructor() {
    super("This deposit has not been approved by the pool's approver yet.");
    this.name = "NotApprovedYetError";
  }
}

/**
 * Builds a relayed withdrawal of `amount` from `note` to `recipient`. The proof binds the
 * recipient, the relayer's fee address and the fee, so the relayer cannot redirect funds.
 */
export async function prepareWithdrawal(
  load: ArtifactLoader,
  p: {
    info: PoolInfo;
    events: PoolEvents;
    keys: PoolMasterKeys;
    note: PoolNote;
    amount: bigint;
    recipient: Address;
    feeRecipient: Address;
    feeBPS: bigint;
  },
): Promise<PreparedWithdrawal> {
  if (p.note.status !== "spendable") throw new Error("This note has nothing left to withdraw.");
  if (p.amount <= 0n || p.amount > p.note.value) throw new Error("Enter an amount up to the note's balance.");
  if (p.feeBPS > p.info.maxRelayFeeBPS) throw new Error("The relayer fee is above the pool's limit.");
  const approvals = currentApprovalSet(p.events, p.info.aspRoot);
  if (!approvals) throw new Error("The pool's approval list could not be checked against the chain.");
  if (!approvals.labels.includes(p.note.label)) throw new NotApprovedYetError();

  const withdrawal: Withdrawal = {
    processooor: p.info.entrypoint,
    data: encodeRelayData({ recipient: getAddress(p.recipient), feeRecipient: getAddress(p.feeRecipient), relayFeeBPS: p.feeBPS }),
  };
  const proof = await proveWithdrawal(load, {
    value: p.note.value,
    label: p.note.label,
    existing: p.note.secrets,
    next: withdrawalSecrets(p.keys, p.note.label, p.note.withdrawalCount),
    withdrawnValue: p.amount,
    context: withdrawalContext(withdrawal, p.info.scope),
    state: merkleProof(p.events.leaves, p.note.commitment),
    asp: merkleProof(approvals.labels, p.note.label),
  });
  return { withdrawal, proof, scope: p.info.scope, recipient: getAddress(p.recipient), amount: p.amount, fee: (p.amount * p.feeBPS) / 10_000n };
}

/** JSON-safe form for sending to the relayer. */
export function serializeWithdrawal(w: PreparedWithdrawal) {
  const s = (x: bigint) => x.toString();
  return {
    withdrawal: w.withdrawal,
    proof: {
      pA: w.proof.pA.map(s),
      pB: w.proof.pB.map((r) => r.map(s)),
      pC: w.proof.pC.map(s),
      pubSignals: w.proof.pubSignals.map(s),
    },
    scope: s(w.scope),
  };
}
export type SerializedWithdrawal = ReturnType<typeof serializeWithdrawal>;

export function relayArgs(w: SerializedWithdrawal) {
  const b = (x: string) => BigInt(x);
  return [
    { processooor: getAddress(w.withdrawal.processooor), data: w.withdrawal.data as Hex },
    {
      pA: w.proof.pA.map(b) as [bigint, bigint],
      pB: w.proof.pB.map((r) => r.map(b)) as [[bigint, bigint], [bigint, bigint]],
      pC: w.proof.pC.map(b) as [bigint, bigint],
      pubSignals: w.proof.pubSignals.map(b) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
    },
    b(w.scope),
  ] as const;
}

/**
 * Exit without approval: the original depositor (the one-time address) proves it knows the
 * note and takes the remaining value back to that same address. Public, and links nothing new.
 */
export async function ragequit(
  client: PublicClient,
  network: NetworkConfig,
  load: ArtifactLoader,
  p: { info: PoolInfo; account: LocalAccount; note: PoolNote },
): Promise<Hash> {
  if (p.note.status !== "spendable") throw new Error("This note has nothing left.");
  if (getAddress(p.note.deposit.depositor) !== getAddress(p.account.address)) throw new Error("Only the address that deposited can exit this way.");
  const proof = await proveRagequit(load, { value: p.note.value, label: p.note.label, secrets: p.note.secrets });
  const wallet = createWalletClient({ account: p.account, chain: network.chain, transport: http(network.rpcUrl, { timeout: 20_000 }) });
  const hash = await wallet.writeContract({
    address: p.info.pool,
    abi: PrivacyPoolComplex.abi,
    functionName: "ragequit",
    args: [{ pA: proof.pA, pB: proof.pB, pC: proof.pC, pubSignals: proof.pubSignals as unknown as readonly [bigint, bigint, bigint, bigint] }],
  });
  const r = await waitForConfirmedReceipt(client, hash, { confirmations: network.confirmations });
  return r.transactionHash;
}

/**
 * Moves a payment that landed at a one-time address into the pool, when it can: at least the
 * pool's minimum, and enough ETH at the address (the payer's gas stipend) for approve + deposit.
 * Returns null (and does nothing) otherwise.
 */
export async function shieldOneTime(
  client: PublicClient,
  network: NetworkConfig,
  info: PoolInfo,
  p: { account: LocalAccount; keys: PoolMasterKeys; depositIndex: bigint },
): Promise<{ hash: Hash; value: bigint; amount: bigint } | null> {
  const token = network.token!;
  if (info.dead) return null;
  const [amount, eth, fees] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [p.account.address] }),
    client.getBalance({ address: p.account.address }),
    client.estimateFeesPerGas(),
  ]);
  if (amount < info.minimumDeposit) return null;
  // Realistic cost for approve + deposit (the payer's stipend budgets SHIELD_GAS_BUDGET).
  const cost = ((SHIELD_GAS_BUDGET / 2n) * (fees.maxFeePerGas ?? 0n) * 3n) / 2n;
  if (eth < cost) return null;
  const r = await depositFromAccount(client, network, info, { ...p, amount });
  return { hash: r.hash, value: r.value, amount };
}
