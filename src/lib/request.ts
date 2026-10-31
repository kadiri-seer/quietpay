import { bytesToHex, type Address } from "viem";
import { EXPIRY_OPTIONS } from "@/config/networks";
import { encodePaymentLink, LINK_VERSION } from "./link";
import { createRequestKeys } from "./stealth";
import { randomBytes } from "./vault-crypto";
import type { StoredRequest } from "./vault";

/**
 * Creates a new payment request with its own fresh stealth keys. Returns the record to store
 * in the encrypted vault; `record.link` is the shareable (public) link code.
 */
export function createPaymentRequest(p: {
  chainId: number;
  token: Address;
  amount: bigint;
  decimals: number;
  symbol: string;
  expirySeconds: number;
  fromBlock: bigint;
  nowMs?: number;
}): StoredRequest {
  if (!EXPIRY_OPTIONS.some((o) => o.seconds === p.expirySeconds)) throw new Error("Unsupported expiry.");
  if (p.amount <= 0n) throw new Error("Amount must be positive.");
  const now = p.nowMs ?? Date.now();
  const keys = createRequestKeys();
  const id = bytesToHex(randomBytes(16));
  const expiresAt = Math.floor(now / 1000) + p.expirySeconds;
  const link = encodePaymentLink({
    version: LINK_VERSION,
    chainId: p.chainId,
    token: p.token,
    amount: p.amount,
    expiresAt,
    requestId: id,
    stealthMetaAddress: keys.stealthMetaAddress,
  });
  return {
    id,
    chainId: p.chainId,
    token: p.token,
    amount: p.amount.toString(),
    decimals: p.decimals,
    symbol: p.symbol,
    expiresAt,
    createdAt: now,
    fromBlock: p.fromBlock.toString(),
    link,
    keys,
    payments: [],
  };
}
