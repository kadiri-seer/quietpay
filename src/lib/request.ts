import { bytesToHex, type Address } from "viem";
import { EXPIRY_OPTIONS, OPEN_EXPIRY_OPTIONS } from "@/config/networks";
import { encodePaymentLink, type LinkKind } from "./link";
import { createRequestKeys } from "./stealth";
import { randomBytes } from "./vault-crypto";
import type { StoredRequest } from "./vault";

/**
 * Creates a new payment request with its own fresh stealth keys. Returns the record to store
 * in the encrypted vault; `record.link` is the shareable (public) link code.
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
}): StoredRequest {
  const kind: LinkKind = p.kind ?? "fixed";
  const options: readonly { seconds: number }[] = kind === "fixed" ? EXPIRY_OPTIONS : OPEN_EXPIRY_OPTIONS;
  if (!options.some((o) => o.seconds === p.expirySeconds)) throw new Error("Unsupported expiry.");
  if (kind === "fixed" && p.amount <= 0n) throw new Error("Amount must be positive.");
  const amount = kind === "fixed" ? p.amount : 0n;
  const now = p.nowMs ?? Date.now();
  const keys = createRequestKeys();
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
    payments: [],
  };
}
