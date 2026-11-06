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
  encodeFunctionData,
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
import { prepareSpend } from "@/lib/one-confirmation";

/** Runtime code hash of contracts/src/QuietPayPoolRouter.sol (identical for every deployment). */
export const POOL_ROUTER_CODE_HASH = "0xb7daf1530d7c3c8c0d850f784168cae50cf45b5618abbd3c9d709b8ebc42f8b6";
/** Runtime code hash of contracts/src/QuietPayPoolRouterV2.sol (signed requests, refund checks). */
export const POOL_ROUTER_V2_CODE_HASH = "0xa46b1aca668abebfd25b2babe4bf17ba91eefa7fb117837c83ed49802b177b6a";

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
  // v2 only
  {
    type: "function",
    name: "payRequest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "bytes16" },
      { name: "amount", type: "uint256" },
      { name: "expiresAt", type: "uint64" },
      { name: "termsSig", type: "bytes" },
      { name: "precommitment", type: "uint256" },
      { name: "refund", type: "address" },
      { name: "lockSig", type: "bytes" },
    ],
    outputs: [{ name: "label", type: "uint256" }],
  },
  { type: "function", name: "requestPaid", stateMutability: "view", inputs: [{ name: "requestKey", type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "requestDigest",
    stateMutability: "view",
    inputs: [
      { name: "requestId", type: "bytes16" },
      { name: "amount", type: "uint256" },
      { name: "expiresAt", type: "uint64" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "lockDigest",
    stateMutability: "view",
    inputs: [
      { name: "precommitment", type: "uint256" },
      { name: "refund", type: "address" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "event",
    name: "RequestPaid",
    inputs: [
      { name: "requestKey", type: "address", indexed: true },
      { name: "requestId", type: "bytes16", indexed: false },
      { name: "label", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "BadDestination", inputs: [] },
  { type: "error", name: "BadSignature", inputs: [] },
  { type: "error", name: "SignerMismatch", inputs: [] },
  { type: "error", name: "ZeroRequestId", inputs: [] },
  { type: "error", name: "RequestExpired", inputs: [] },
  { type: "error", name: "RequestAlreadyPaid", inputs: [] },
] as const;

export type PoolRouterVersion = 1 | 2;

/**
 * Checks a pool router at `router`: its code is exactly one of QuietPay's published router
 * builds, bound to this network's pool, entrypoint and token. Returns its version.
 */
export async function verifyPoolRouterAt(client: PublicClient, network: NetworkConfig, router: Address): Promise<{ address: Address; version: PoolRouterVersion }> {
  if (!network.pool || !network.token) throw new VerificationError("No pool is configured.");
  const code = await client.getCode({ address: router });
  const hash = code && code !== "0x" ? keccak256(code) : null;
  const version: PoolRouterVersion | null = hash === POOL_ROUTER_V2_CODE_HASH ? 2 : hash === POOL_ROUTER_CODE_HASH ? 1 : null;
  if (!version) throw new VerificationError("The pool payment contract doesn't match QuietPay's published code. Don't pay through it.");
  const read = (functionName: "pool" | "entrypoint" | "token") => client.readContract({ address: router, abi: poolRouterAbi, functionName });
  const [pool, entrypoint, token] = await Promise.all([read("pool"), read("entrypoint"), read("token")]);
  if (getAddress(pool) !== getAddress(network.pool.pool) || getAddress(entrypoint) !== getAddress(network.pool.entrypoint) || getAddress(token) !== getAddress(network.token))
    throw new VerificationError("The pool payment contract is bound to a different pool or token. Don't pay through it.");
  return { address: getAddress(router), version };
}

/** The configured router's address and version, or null if none is configured. */
export async function verifyPoolRouterInfo(client: PublicClient, network: NetworkConfig) {
  const router = network.pool?.router;
  if (!router || !network.pool || !network.token) return null;
  return verifyPoolRouterAt(client, network, router);
}

/**
 * Checks the configured pool router before any payment through it: its code is exactly the
 * published contract, and it is bound to this network's pool, entrypoint and token. Returns its
 * address, or null if no router is configured.
 */
export async function verifyPoolRouter(client: PublicClient, network: NetworkConfig): Promise<Address | null> {
  return (await verifyPoolRouterInfo(client, network))?.address ?? null;
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
  // The first payment allows the pool router once, for any amount (it can only move tokens of
  // whoever calls it); wallets that batch calls do the approval and payment in one confirmation.
  const plan = await prepareSpend(wallet, client, {
    chain: p.network.chain,
    token: p.token,
    spender: p.router,
    amount: p.amount,
    payment: { to: p.router, data: encodeFunctionData({ abi: poolRouterAbi, functionName: "pay", args: [p.lock.precommitment, p.amount, getAddress(p.lock.refund)] }) },
  });
  if (plan.kind === "batched") return { hash: plan.hash, approveHash: null };
  const approveHash: Hash | null = plan.kind === "approved" ? plan.approveTx : null;
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

/**
 * Payer side, QuietPayPoolRouterV2: pays a signed one-time request (exactly its amount, into a
 * lock its request key signed). Approves the router first if needed, like payIntoPool.
 */
export async function payRequestIntoPool(
  wallet: WalletClient,
  client: PublicClient,
  p: {
    network: NetworkConfig;
    router: Address;
    token: Address;
    request: { requestId: Hex; amount: bigint; expiresAt: number; termsSig: Hex };
    lock: { precommitment: bigint; refund: Address; sig: Hex };
  },
): Promise<{ hash: Hash; approveHash: Hash | null }> {
  const args = [p.request.requestId, p.request.amount, BigInt(p.request.expiresAt), p.request.termsSig, p.lock.precommitment, getAddress(p.lock.refund), p.lock.sig] as const;
  const plan = await prepareSpend(wallet, client, {
    chain: p.network.chain,
    token: p.token,
    spender: p.router,
    amount: p.request.amount,
    payment: { to: p.router, data: encodeFunctionData({ abi: poolRouterAbi, functionName: "payRequest", args }) },
  });
  if (plan.kind === "batched") return { hash: plan.hash, approveHash: null };
  const approveHash: Hash | null = plan.kind === "approved" ? plan.approveTx : null;
  const { request } = await client.simulateContract({ address: p.router, abi: poolRouterAbi, functionName: "payRequest", args, account: wallet.account! });
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
