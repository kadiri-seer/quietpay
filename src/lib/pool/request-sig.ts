/**
 * Signed payment requests for QuietPayPoolRouterV2 (contracts/src/QuietPayPoolRouterV2.sol).
 *
 * Each one-time pool link has its own request key (src/lib/link-keys.ts, deriveRequestKey). The
 * key signs two things, both as EIP-191 signatures over a 32-byte digest the router recomputes:
 *
 *   terms: keccak256(abi.encode(keccak256("QuietPay request v1"), chainId, router, token,
 *          requestId, amount, expiresAt))
 *   lock:  keccak256(abi.encode(keccak256("QuietPay lock v2"), chainId, pool, precommitment, refund))
 *
 * The router marks a request paid only when exactly `amount` goes into a lock signed by the same
 * key as the terms. So nobody can use a request up with less money, or by paying somewhere else,
 * and a lock someone burns by depositing into it directly doesn't use the request up: the payer
 * takes one of the request's spare locks (signed the same way, kept by QuietPay's server).
 */
import { encodeAbiParameters, getAddress, keccak256, recoverMessageAddress, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const LOCK_TYPEHASH = keccak256(toBytes("QuietPay lock v2"));
const REQUEST_TYPEHASH = keccak256(toBytes("QuietPay request v1"));

/** Receive indexes of a request's spare locks: SPARE_INDEX_BASE + link * SPARES_PER_LINK + j. */
export const SPARE_INDEX_BASE = 1n << 48n;
export const SPARES_PER_LINK = 4n;
/** How many spares a new request uploads. */
export const SPARES_UPLOADED = 3;

export interface RequestTerms {
  chainId: number;
  router: Address;
  token: Address;
  requestId: Hex; // 16 bytes
  amount: bigint;
  expiresAt: number;
}

export function requestDigest(t: RequestTerms): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes16" }, { type: "uint256" }, { type: "uint64" }],
      [REQUEST_TYPEHASH, BigInt(t.chainId), getAddress(t.router), getAddress(t.token), t.requestId, t.amount, BigInt(t.expiresAt)],
    ),
  );
}

export function lockDigest(l: { chainId: number; pool: Address; precommitment: bigint; refund: Address }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" }],
      [LOCK_TYPEHASH, BigInt(l.chainId), getAddress(l.pool), l.precommitment, getAddress(l.refund)],
    ),
  );
}

export const signDigest = (key: Hex, digest: Hex) => privateKeyToAccount(key).signMessage({ message: { raw: digest } });
export const recoverDigest = (digest: Hex, signature: Hex) => recoverMessageAddress({ message: { raw: digest }, signature }).then(getAddress);

/** Receive index of spare lock j (0-based) of link number `index`. */
export const spareIndex = (index: number | bigint, j: number | bigint) => SPARE_INDEX_BASE + BigInt(index) * SPARES_PER_LINK + BigInt(j);

/**
 * The request key behind a link: whoever signed its terms. Throws unless the link's lock was
 * signed by the same key (a link put together from someone else's parts).
 */
export async function requestKeyOf(t: RequestTerms, termsSig: Hex, lock: { pool: Address; precommitment: bigint; refund: Address; sig: Hex }): Promise<Address> {
  const key = await recoverDigest(requestDigest(t), termsSig).catch(() => null);
  const lockKey = await recoverDigest(lockDigest({ chainId: t.chainId, ...lock }), lock.sig).catch(() => null);
  if (!key || !lockKey || key !== lockKey) throw new Error("This link's signatures don't match. Don't pay it; ask the recipient to share it again.");
  return key;
}
