import { bytesToHex, type Address } from "viem";
import { EXPIRY_OPTIONS, OPEN_EXPIRY_OPTIONS } from "@/config/networks";
import { encodePaymentLink, type LinkKind } from "./link";
import { createRequestKeys, type RequestKeys } from "./stealth";
import { randomBytes } from "./vault-crypto";
import type { StoredRequest } from "./vault";

/**
 * Creates a new payment request. In the app, `keys` and `index` always come from the wallet-
 * derived link seed (src/lib/link-keys.ts), so the link can be recovered from the wallet alone.
 * Without them (tests only) fresh random keys are used. `record.link` is the shareable code.
 */
export function createPaymentRequest(p: {
  kind?: LinkKind;
  chainId: number;
  token: Address;
  /** Base units for fixed links; ignored (0) for open links. */
  amount: bigint;
  decimals: number;
  symbol: string;
  /** Seconds until expiry. For open links 0 means never. */
  expirySeconds: number;
  fromBlock: bigint;
  nowMs?: number;
  /** Wallet-derived keys for link number `index`. */
  keys?: RequestKeys;
  index?: number;
  /** The recipient's pool lock for this link (fixed links only): it then pays into the pool. */
  poolLock?: { precommitment: bigint; refund: Address; receiveIndex: number };
}): StoredRequest {
  if (p.poolLock && (p.kind ?? "fixed") !== "fixed") throw new Error("Only one-time links can pay into the pool.");
  const kind: LinkKind = p.kind ?? "fixed";
  const options: readonly { seconds: number }[] = kind === "fixed" ? EXPIRY_OPTIONS : OPEN_EXPIRY_OPTIONS;
  if (!options.some((o) => o.seconds === p.expirySeconds)) throw new Error("Unsupported expiry.");
  if (kind === "fixed" && p.amount <= 0n) throw new Error("Amount must be positive.");
  const amount = kind === "fixed" ? p.amount : 0n;
  const now = p.nowMs ?? Date.now();
  const keys = p.keys ?? createRequestKeys();
  const id = bytesToHex(randomBytes(16));
  const expiresAt = p.expirySeconds === 0 ? 0 : Math.floor(now / 1000) + p.expirySeconds;
  const link = encodePaymentLink({
    kind,
    chainId: p.chainId,
    token: p.token,
    amount,
    expiresAt,
    requestId: id,
    stealthMetaAddress: keys.stealthMetaAddress,
    ...(p.poolLock ? { poolLock: { precommitment: p.poolLock.precommitment, refund: p.poolLock.refund } } : {}),
  });
  return {
    id,
    kind,
    chainId: p.chainId,
    token: p.token,
    amount: amount.toString(),
    decimals: p.decimals,
    symbol: p.symbol,
    expiresAt,
    createdAt: now,
    fromBlock: p.fromBlock.toString(),
    link,
    keys,
    ...(p.index !== undefined ? { index: p.index } : {}),
    ...(p.poolLock ? { pool: { precommitment: p.poolLock.precommitment.toString(), refund: p.poolLock.refund, receiveIndex: p.poolLock.receiveIndex } } : {}),
    payments: [],
  };
}
