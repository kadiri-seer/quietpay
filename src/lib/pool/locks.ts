/**
 * Signed pool locks for payments to a @username or a personal link.
 *
 * A one-time payment link carries its own lock. A username or a personal link is paid by many
 * people, so the recipient's device makes locks in advance, signs each one with its name key and
 * leaves them with QuietPay's server. A payer gets one lock per payment, checks the signature
 * against the recipient's key and pays into the pool under it.
 *
 * The server never sees any secret (a lock is a hash; the refund address is public), and it can't
 * substitute a lock of its own: the payer only accepts locks signed by the recipient's key. For a
 * personal link that key is in the link itself; for a @username it comes from the name directory.
 * What the server does learn is which pool payments belong to which username or personal link.
 *
 * Lock j of the personal range uses receive index PERSONAL_INDEX_BASE + j, apart from the locks
 * of one-time links (receive index = link number).
 */
import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PoolMasterKeys } from "./crypto";
import { receiveLock } from "./receive";

export const PERSONAL_INDEX_BASE = 1n << 40n;
const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface SignedLock {
  /** Precommitment, decimal. */
  p: string;
  /** Refund address. */
  r: Address;
  /** Signature by the recipient's name key over lockMessage(). */
  s: Hex;
}

export function lockMessage(p: { chainId: number; pool: Address; precommitment: bigint; refund: Address }): string {
  return [
    "QuietPay payment lock v1",
    `Chain: ${p.chainId}`,
    `Pool: ${getAddress(p.pool)}`,
    `Lock: ${p.precommitment.toString()}`,
    `Refund: ${getAddress(p.refund)}`,
  ].join("\n");
}

export function personalLock(keys: PoolMasterKeys, scope: bigint, j: bigint) {
  return receiveLock(keys, scope, PERSONAL_INDEX_BASE + j);
}

export async function signLock(nameKey: Hex, p: { chainId: number; pool: Address; precommitment: bigint; refund: Address }): Promise<SignedLock> {
  const account = privateKeyToAccount(nameKey);
  return { p: p.precommitment.toString(), r: getAddress(p.refund), s: await account.signMessage({ message: lockMessage(p) }) };
}

/** Checks a lock's shape and that `key` signed it for this chain and pool. Returns the lock or throws. */
export async function verifyLock(raw: unknown, p: { key: Address; chainId: number; pool: Address }): Promise<{ precommitment: bigint; refund: Address }> {
  const l = raw as Partial<SignedLock> | null;
  if (!l || typeof l.p !== "string" || !/^\d{1,78}$/.test(l.p) || typeof l.r !== "string" || !isAddress(l.r) || typeof l.s !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(l.s))
    throw new Error("The recipient's payment details are malformed.");
  const precommitment = BigInt(l.p);
  if (precommitment === 0n || precommitment >= SNARK_FIELD) throw new Error("The recipient's payment details are malformed.");
  const refund = getAddress(l.r);
  const signer = await recoverMessageAddress({ message: lockMessage({ chainId: p.chainId, pool: p.pool, precommitment, refund }), signature: l.s as Hex }).catch(() => null);
  if (!signer || getAddress(signer) !== getAddress(p.key)) throw new Error("These payment details weren't signed by the recipient. Don't pay.");
  return { precommitment, refund };
}

/* ---------------- Who to pay: a @username or a personal link ---------------- */

export type PayTarget = { kind: "name"; name: string } | { kind: "key"; key: Address };

/** "#@kadiri" or "#to=0x…" (personal link). Returns null for anything else (e.g. a request code). */
export function parsePayTarget(fragment: string): PayTarget | null {
  const f = decodeURIComponent(fragment.replace(/^#/, "").trim());
  const name = /^@([a-z0-9_]{3,20})$/i.exec(f);
  if (name) return { kind: "name", name: name[1].toLowerCase() };
  const key = /^to=(0x[0-9a-fA-F]{40})$/.exec(f);
  if (key) return { kind: "key", key: getAddress(key[1]) };
  return null;
}

export const personalLinkUrl = (origin: string, key: Address) => `${origin.replace(/\/$/, "")}/pay#to=${getAddress(key)}`;
export const usernameUrl = (origin: string, name: string) => `${origin.replace(/\/$/, "")}/pay#@${name}`;
