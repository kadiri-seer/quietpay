/**
 * Lock API logic, shared by the route and tests.
 *
 *   take:   a payer asks for a lock for @name or a personal-link key. The server picks a free one,
 *           skips any the pool already accepted, and returns it with the key that signed it.
 *   counts: a recipient's device asks how many of its locks are free and how many it has uploaded.
 *   upload: a recipient's device adds locks; every one must be signed by the key it is filed under.
 */
import "server-only";
import { getAddress, isAddress, type Address } from "viem";
import { checkName, ReservationError } from "@/lib/names/names";
import type { NameStore } from "@/lib/names/store";
import { verifyLock, type SignedLock } from "./locks";
import { HOLD_MS, type LockStore } from "./lock-store";

export const TAKES_PER_MINUTE = 12;
/** Locks one caller may hold for one recipient at a time (a payment sent in several parts, plus retries). */
export const HOLDS_PER_RECIPIENT = 8;
export const UPLOAD_MAX = 50;

export interface LockDeps {
  locks: LockStore;
  names: NameStore;
  chainId: number;
  pool: Address;
  /** True if the pool already accepted this precommitment. */
  isUsed: (precommitment: bigint) => Promise<boolean>;
  /** Counts repeated actions (src/lib/server/monitor.ts). */
  watch?: (event: "lock.take.recipient" | "lock.take.caller" | "lock.empty.recipient" | "lock.upload.recipient", subject: string) => Promise<unknown>;
  now?: number;
}

async function scramble(ip: string, salt: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|locks|${ip}`));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveKey(d: LockDeps, q: { name?: string | null; key?: string | null }): Promise<{ key: Address; name: string | null }> {
  if (q.name) {
    const c = checkName(q.name);
    if (!c.ok) throw new ReservationError("No QuietPay user has that username.", 404);
    const r = await d.names.get(c.name);
    if (!r) throw new ReservationError("No QuietPay user has that username.", 404);
    return { key: getAddress(r.key), name: c.name };
  }
  if (q.key && isAddress(q.key)) return { key: getAddress(q.key), name: null };
  throw new ReservationError("Say who to pay.");
}

export async function takeLock(d: LockDeps, q: { name?: string | null; key?: string | null }, ip: string, salt: string) {
  if (!(await d.names.allow(`lt:${await scramble(ip, salt)}`, TAKES_PER_MINUTE, 60))) throw new ReservationError("Too many requests. Wait a minute.", 429);
  const { key, name } = await resolveKey(d, q);
  const caller = await scramble(ip, salt);
  if (!(await d.names.allow(`lh:${caller}:${key.toLowerCase()}`, HOLDS_PER_RECIPIENT, HOLD_MS / 1000)))
    throw new ReservationError("You already have a payment to this person in progress. Finish it, or wait a few minutes.", 429);
  await d.watch?.("lock.take.recipient", key.toLowerCase());
  await d.watch?.("lock.take.caller", caller);
  const now = d.now ?? Date.now();
  for (let i = 0; i < 6; i++) {
    const lock = await d.locks.take(key, now);
    if (!lock) break;
    let ok: { precommitment: bigint } | null = null;
    try {
      ok = await verifyLock(lock, { key, chainId: d.chainId, pool: d.pool });
    } catch {
      await d.locks.drop(key, lock);
      continue;
    }
    if (await d.isUsed(ok.precommitment)) {
      await d.locks.drop(key, lock);
      continue;
    }
    return { key, name, lock };
  }
  await d.watch?.("lock.empty.recipient", key.toLowerCase());
  throw new ReservationError(
    name ? `@${name} can't receive payments right now. Ask them to open QuietPay, then try again.` : "This person can't receive payments right now. Ask them to open QuietPay, then try again.",
    409,
  );
}

export async function lockCounts(d: LockDeps, key: string) {
  if (!isAddress(key)) throw new ReservationError("Malformed key.");
  return d.locks.counts(getAddress(key), d.now ?? Date.now());
}

export async function uploadLocks(d: LockDeps, raw: unknown) {
  const b = raw as { key?: unknown; locks?: unknown } | null;
  if (!b || typeof b.key !== "string" || !isAddress(b.key) || !Array.isArray(b.locks)) throw new ReservationError("Malformed request.");
  if (b.locks.length === 0 || b.locks.length > UPLOAD_MAX) throw new ReservationError(`Send between 1 and ${UPLOAD_MAX} locks.`);
  const key = getAddress(b.key);
  await d.watch?.("lock.upload.recipient", key.toLowerCase());
  const clean: SignedLock[] = [];
  for (const l of b.locks) {
    try {
      await verifyLock(l, { key, chainId: d.chainId, pool: d.pool });
    } catch {
      throw new ReservationError("Every lock must be signed by the key it is filed under.", 403);
    }
    const s = l as SignedLock;
    clean.push({ p: s.p, r: getAddress(s.r), s: s.s });
  }
  const total = await d.locks.add(key, clean);
  if (total === null) throw new ReservationError("Too many unused locks stored already.", 409);
  return { total };
}
