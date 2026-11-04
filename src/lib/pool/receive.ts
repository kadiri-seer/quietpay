/**
 * Receiving straight into the shielded pool (QuietPayPoolRouter).
 *
 * The recipient's device hands out "locks": a precommitment (Poseidon(nullifier, secret), from
 * the recipient's pool keys) and a refund address (also from those keys). A payer deposits into
 * the pool through the router under that lock. Only the recipient knows the secrets behind it, so
 * only the recipient can withdraw; the router records the refund address so an unapproved deposit
 * can be returned there and nowhere else.
 *
 * The recipient finds payments by matching the precommitments of its own locks against the
 * pool's public deposit events: no announcement, no server, no scanning key leaves the device.
 */
import {
  encodeAbiParameters,
  decodeAbiParameters,
  getAddress,
  keccak256,
  encodePacked,
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { erc20Abi } from "@/config/contracts";
import { Entrypoint } from "@/config/pool-contracts.generated";
import type { PreflightCheck } from "@/lib/payer";
import type { NetworkConfig } from "@/config/networks";
import { precommitmentHash, merkleProof, withdrawalSecrets, type PoolMasterKeys } from "./crypto";
import { currentApprovalSet, receiveSecrets, type PoolEvents, type PoolNote } from "./state";
import { proveRagequit, proveWithdrawal, withdrawalContext, type ArtifactLoader, type Withdrawal, type WithdrawProof } from "./prover";
import { NotApprovedYetError, type PoolInfo } from "./actions";
import { VerificationError } from "@/lib/chain";

/** Runtime code hash of contracts/src/QuietPayPoolRouter.sol (identical for every deployment). */
export const POOL_ROUTER_CODE_HASH = "0xb7daf1530d7c3c8c0d850f784168cae50cf45b5618abbd3c9d709b8ebc42f8b6";

export const poolRouterAbi = [
  { type: "function", name: "pool", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "entrypoint", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "scope", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "refundTo", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "precommitment", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "refund", type: "address" },
    ],
    outputs: [{ name: "label", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "withdrawal", type: "tuple", components: [{ name: "processooor", type: "address" }, { name: "data", type: "bytes" }] },
      {
        name: "proof",
        type: "tuple",
        components: [
          { name: "pA", type: "uint256[2]" },
          { name: "pB", type: "uint256[2][2]" },
          { name: "pC", type: "uint256[2]" },
          { name: "pubSignals", type: "uint256[8]" },
        ],
      },
    ],
    outputs: [{ name: "label", type: "uint256" }],
  },
  {
    type: "function",
    name: "ragequit",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "proof",
        type: "tuple",
        components: [
          { name: "pA", type: "uint256[2]" },
          { name: "pB", type: "uint256[2][2]" },
          { name: "pC", type: "uint256[2]" },
          { name: "pubSignals", type: "uint256[4]" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Paid",
    inputs: [
      { name: "payer", type: "address", indexed: true },
      { name: "label", type: "uint256", indexed: true },
      { name: "commitment", type: "uint256", indexed: false },
      { name: "precommitment", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "refund", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Transferred",
    inputs: [
      { name: "label", type: "uint256", indexed: true },
      { name: "commitment", type: "uint256", indexed: false },
      { name: "precommitment", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "refund", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "label", type: "uint256", indexed: true },
      { name: "refund", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "AmountMismatch", inputs: [] },
  { type: "error", name: "UnknownDeposit", inputs: [] },
  { type: "error", name: "FeeTooLarge", inputs: [] },
  { type: "error", name: "ZeroPrecommitment", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "TokenTransferFailed", inputs: [] },
  { type: "error", name: "LabelMismatch", inputs: [] },
] as const;

/**
 * Checks the configured pool router before any payment through it: its code is exactly the
 * published contract, and it is bound to this network's pool, entrypoint and token. Returns its
 * address, or null if no router is configured.
 */
export async function verifyPoolRouter(client: PublicClient, network: NetworkConfig): Promise<Address | null> {
  const router = network.pool?.router;
  if (!router || !network.pool || !network.token) return null;
  const code = await client.getCode({ address: router });
  if (!code || code === "0x" || keccak256(code) !== POOL_ROUTER_CODE_HASH) throw new VerificationError("The pool payment contract doesn't match QuietPay's published code. Don't pay through it.");
  const read = (functionName: "pool" | "entrypoint" | "token") => client.readContract({ address: router, abi: poolRouterAbi, functionName });
  const [pool, entrypoint, token] = await Promise.all([read("pool"), read("entrypoint"), read("token")]);
  if (getAddress(pool) !== getAddress(network.pool.pool) || getAddress(entrypoint) !== getAddress(network.pool.entrypoint) || getAddress(token) !== getAddress(network.token))
    throw new VerificationError("The pool payment contract is bound to a different pool or token. Don't pay through it.");
  return getAddress(router);
}

/** A lock handed to a payer. Contains nothing that lets anyone but the recipient spend. */
export interface ReceiveLock {
  index: bigint;
  precommitment: bigint;
  refund: Address;
}

/** The key for lock i's refund address. Derived from the pool keys, so it is recoverable with them. */
export function refundAccount(keys: PoolMasterKeys, scope: bigint, index: bigint): LocalAccount {
  for (let attempt = 0n; ; attempt++) {
    const k = keccak256(encodePacked(["string", "uint256", "uint256", "uint256", "uint256"], ["quietpay/pool-refund/v1", keys.masterSecret, scope, index, attempt]));
    if (secp256k1.utils.isValidPrivateKey(k.slice(2))) return privateKeyToAccount(k);
  }
}

export function receiveLock(keys: PoolMasterKeys, scope: bigint, index: bigint): ReceiveLock {
  return { index, precommitment: precommitmentHash(receiveSecrets(keys, scope, index)), refund: refundAccount(keys, scope, index).address };
}

/** What the recipient's pool balance gains from a payment of `amount` (the pool's vetting fee comes off). */
export const creditedAmount = (amount: bigint, vettingFeeBPS: bigint) => amount - (amount * vettingFeeBPS) / 10_000n;

/**
 * Checks before paying a link into the pool: the lock hasn't been used (so the link isn't paid
 * yet), the amount meets the pool minimum, and the payer has the tokens and some ETH for gas.
 */
export async function poolPayPreflight(
  client: PublicClient,
  p: { info: PoolInfo; token: Address; symbol: string; decimals: number; payer: Address; amount: bigint; lock: Pick<ReceiveLock, "precommitment" | "refund">; minGasWei?: bigint },
): Promise<{ ok: boolean; alreadyPaid: boolean; checks: PreflightCheck[] }> {
  const [used, tokenBal, ethBal] = await Promise.all([
    client.readContract({ address: p.info.entrypoint, abi: Entrypoint.abi, functionName: "usedPrecommitments", args: [p.lock.precommitment] }),
    client.readContract({ address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [p.payer] }),
    client.getBalance({ address: p.payer }),
  ]);
  const fmt = (v: bigint) => {
    const s = v.toString().padStart(p.decimals + 1, "0");
    const whole = s.slice(0, -p.decimals) || "0";
    const frac = s.slice(-p.decimals).replace(/0+$/, "");
    return `${whole}${frac ? `.${frac}` : ""} ${p.symbol}`;
  };
  const checks: PreflightCheck[] = [
    used
      ? { id: "unpaid", label: "Link not paid yet", status: "fail", detail: "This one-time link has already been paid." }
      : { id: "unpaid", label: "Link not paid yet", status: "ok" },
    p.amount >= p.info.minimumDeposit
      ? { id: "minimum", label: "Meets the pool minimum", status: "ok" }
      : { id: "minimum", label: "Meets the pool minimum", status: "fail", detail: `The pool takes ${fmt(p.info.minimumDeposit)} or more.` },
    tokenBal >= p.amount
      ? { id: "balance", label: `Enough ${p.symbol}`, status: "ok" }
      : { id: "balance", label: `Enough ${p.symbol}`, status: "fail", detail: `You have ${fmt(tokenBal)}.` },
    ethBal >= (p.minGasWei ?? 1n)
      ? { id: "gas", label: "ETH for network fees", status: "ok" }
      : { id: "gas", label: "ETH for network fees", status: "fail", detail: "Add a little ETH on this network to pay the network fee." },
  ];
  if (p.info.dead) checks.push({ id: "pool", label: "Pool open for deposits", status: "fail", detail: "The pool has been wound down." });
  return { ok: checks.every((c) => c.status !== "fail"), alreadyPaid: used, checks };
}

/** Payer side: approves the router if needed, then pays `amount` into the pool under `lock`. */
export async function payIntoPool(
  wallet: WalletClient,
  client: PublicClient,
  p: { network: NetworkConfig; router: Address; token: Address; lock: Pick<ReceiveLock, "precommitment" | "refund">; amount: bigint },
): Promise<{ hash: Hash; approveHash: Hash | null }> {
  const owner = wallet.account!.address;
  let approveHash: Hash | null = null;
  const allowance = await client.readContract({ address: p.token, abi: erc20Abi, functionName: "allowance", args: [owner, p.router] });
  if (allowance < p.amount) {
    approveHash = await wallet.writeContract({ address: p.token, abi: erc20Abi, functionName: "approve", args: [p.router, p.amount], account: wallet.account!, chain: p.network.chain });
    await client.waitForTransactionReceipt({ hash: approveHash });
  }
  const { request } = await client.simulateContract({
    address: p.router,
    abi: poolRouterAbi,
    functionName: "pay",
    args: [p.lock.precommitment, p.amount, getAddress(p.lock.refund)],
    account: wallet.account!,
  });
  const hash = await wallet.writeContract({ ...request, account: wallet.account!, chain: p.network.chain });
  return { hash, approveHash };
}

/** abi.encode(newPrecommitment, refund, feeRecipient, fee): what QuietPayPoolRouter.transfer decodes. */
export function encodeTransferData(d: { precommitment: bigint; refund: Address; feeRecipient: Address; fee: bigint }): Hex {
  return encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [d.precommitment, getAddress(d.refund), getAddress(d.feeRecipient), d.fee]);
}

export function decodeTransferData(data: Hex) {
  const [precommitment, refund, feeRecipient, fee] = decodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }], data);
  return { precommitment, refund, feeRecipient, fee };
}

/**
 * Moves `amount` from one of your approved notes into someone else's lock, in one transaction
 * through the router. The proof binds the lock, the refund address and the fee, so whoever
 * submits it (normally the relayer) can't change any of them.
 */
export async function prepareTransfer(
  load: ArtifactLoader,
  p: {
    info: PoolInfo;
    events: PoolEvents;
    keys: PoolMasterKeys;
    note: PoolNote;
    router: Address;
    amount: bigint;
    to: Pick<ReceiveLock, "precommitment" | "refund">;
    feeRecipient: Address;
    fee: bigint;
  },
): Promise<{ withdrawal: Withdrawal; proof: WithdrawProof }> {
  if (p.note.status !== "spendable") throw new Error("This note has nothing left to send.");
  if (p.amount <= 0n || p.amount > p.note.value) throw new Error("Enter an amount up to the note's balance.");
  if (p.fee >= p.amount) throw new Error("The fee is larger than the amount.");
  const approvals = currentApprovalSet(p.events, p.info.aspRoot);
  if (!approvals) throw new Error("The pool's approval list could not be checked against the chain.");
  if (!approvals.labels.includes(p.note.label)) throw new NotApprovedYetError();
  const withdrawal: Withdrawal = {
    processooor: getAddress(p.router),
    data: encodeTransferData({ precommitment: p.to.precommitment, refund: p.to.refund, feeRecipient: p.feeRecipient, fee: p.fee }),
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
  return { withdrawal, proof };
}

/** Arguments for QuietPayPoolRouter.transfer. */
export function transferArgs(t: { withdrawal: Withdrawal; proof: WithdrawProof }) {
  return [
    t.withdrawal,
    {
      pA: t.proof.pA,
      pB: t.proof.pB,
      pC: t.proof.pC,
      pubSignals: t.proof.pubSignals as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
    },
  ] as const;
}

/**
 * Returns a received payment that was never approved to its refund address. The proof can only be
 * made with the note's secrets, and the router only pays the refund address recorded when the
 * payment was made, so it doesn't matter who submits it.
 */
export async function refundUnapproved(
  wallet: WalletClient,
  load: ArtifactLoader,
  p: { network: NetworkConfig; router: Address; note: PoolNote },
): Promise<Hash> {
  if (p.note.status !== "spendable") throw new Error("This payment has nothing left to return.");
  const proof = await proveRagequit(load, { value: p.note.value, label: p.note.label, secrets: p.note.secrets });
  return wallet.writeContract({
    address: p.router,
    abi: poolRouterAbi,
    functionName: "ragequit",
    args: [{ pA: proof.pA, pB: proof.pB, pC: proof.pC, pubSignals: proof.pubSignals as unknown as readonly [bigint, bigint, bigint, bigint] }],
    account: wallet.account!,
    chain: p.network.chain,
  });
}
