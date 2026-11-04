/**
 * Server storage for signed pool locks (src/lib/pool/locks.ts): Upstash Redis in production, an
 * in-memory map in development and tests.
 *
 *   qp:locks:<key>  sorted set; member = the signed lock as JSON, score = when it may next be
 *                   handed out (ms). 0 = never handed out.
 *   qp:lockn:<key>  how many locks this key has ever uploaded (the owner's devices use it to
 *                   number new locks and to know how far to look for payments).
 *
 * A lock handed to a payer is held for HOLD_MS. If the payer doesn't pay, it is handed out again
 * afterwards; a lock the pool has already accepted is dropped. When every lock is held, the one
 * held longest (at least MIN_HOLD_MS) is handed out again, so holding locks can't block payments.
 */
import "server-only";
import type { Address } from "viem";
import { upstashEnv } from "@/lib/names/store";
import type { SignedLock } from "./locks";

export const HOLD_MS = 5 * 60_000;
/** When every lock is held, the one held longest is handed out again once it's been held this long. */
export const MIN_HOLD_MS = 60_000;
export const MAX_LOCKS_PER_KEY = 500;

export interface LockStore {
  /** Adds locks (ignores ones already stored). Returns the new total ever uploaded, or null if over the cap. */
  add(key: Address, locks: SignedLock[]): Promise<number | null>;
  /** Hands out the next free lock and holds it, or null if none is free right now. */
  take(key: Address, now: number): Promise<SignedLock | null>;
  /** Removes a lock (used onchain). */
  drop(key: Address, lock: SignedLock): Promise<void>;
  counts(key: Address, now: number): Promise<{ available: number; total: number }>;
}

const setKey = (k: Address) => `qp:locks:${k.toLowerCase()}`;
const countKey = (k: Address) => `qp:lockn:${k.toLowerCase()}`;
const member = (l: SignedLock) => JSON.stringify({ p: l.p, r: l.r, s: l.s });

// Picks the lowest-scored lock that is free now and holds it, atomically. If none is free, the one
// held longest is taken over once it has been held MIN_HOLD_MS (ARGV[3] = now + HOLD - MIN_HOLD):
// someone holding every lock without paying can't stop payments, they only make them share.
const TAKE_LUA = `
local m = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 1)
if #m == 0 then
  m = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[3], 'LIMIT', 0, 1)
  if #m == 0 then return false end
end
redis.call('ZADD', KEYS[1], 'XX', ARGV[2], m[1])
return m[1]`;

// Adds locks if the set stays under the cap; bumps the uploaded counter by how many were new.
const ADD_LUA = `
if redis.call('ZCARD', KEYS[1]) + #ARGV - 1 > tonumber(ARGV[1]) then return -1 end
local added = 0
for i = 2, #ARGV do added = added + redis.call('ZADD', KEYS[1], 'NX', 0, ARGV[i]) end
return redis.call('INCRBY', KEYS[2], added)`;

class UpstashLocks implements LockStore {
  constructor(private cfg: { url: string; token: string }) {}
  private async cmd<T>(args: (string | number)[]): Promise<T> {
    const r = await fetch(this.cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
    });
    const j = (await r.json()) as { result?: T; error?: string };
    if (!r.ok || j.error) throw new Error("Lock store error");
    return j.result as T;
  }
  async add(key: Address, locks: SignedLock[]) {
    const n = await this.cmd<number>(["EVAL", ADD_LUA, 2, setKey(key), countKey(key), MAX_LOCKS_PER_KEY, ...locks.map(member)]);
    return n < 0 ? null : n;
  }
  async take(key: Address, now: number) {
    const m = await this.cmd<string | null>(["EVAL", TAKE_LUA, 1, setKey(key), now, now + HOLD_MS, now + HOLD_MS - MIN_HOLD_MS]);
    return m ? (JSON.parse(m) as SignedLock) : null;
  }
  async drop(key: Address, lock: SignedLock) {
    await this.cmd(["ZREM", setKey(key), member(lock)]);
  }
  async counts(key: Address, now: number) {
    const [available, total] = await Promise.all([
      this.cmd<number>(["ZCOUNT", setKey(key), "-inf", now]),
      this.cmd<string | null>(["GET", countKey(key)]),
    ]);
    return { available: Number(available), total: Number(total ?? 0) };
  }
}

export class MemoryLocks implements LockStore {
  private sets = new Map<string, Map<string, number>>();
  private totals = new Map<string, number>();
  private set(key: Address) {
    const k = key.toLowerCase();
    if (!this.sets.has(k)) this.sets.set(k, new Map());
    return this.sets.get(k)!;
  }
  async add(key: Address, locks: SignedLock[]) {
    const s = this.set(key);
    if (s.size + locks.length > MAX_LOCKS_PER_KEY) return null;
    let added = 0;
    for (const l of locks) {
      if (!s.has(member(l))) {
        s.set(member(l), 0);
        added++;
      }
    }
    const t = (this.totals.get(key.toLowerCase()) ?? 0) + added;
    this.totals.set(key.toLowerCase(), t);
    return t;
  }
  async take(key: Address, now: number) {
    const s = this.set(key);
    let best: [string, number] | null = null;
    for (const [m, score] of s) if (score <= now && (!best || score < best[1])) best = [m, score];
    if (!best) for (const [m, score] of s) if (score <= now + HOLD_MS - MIN_HOLD_MS && (!best || score < best[1])) best = [m, score];
    if (!best) return null;
    s.set(best[0], now + HOLD_MS);
    return JSON.parse(best[0]) as SignedLock;
  }
  async drop(key: Address, lock: SignedLock) {
    this.set(key).delete(member(lock));
  }
  async counts(key: Address, now: number) {
    let available = 0;
    for (const score of this.set(key).values()) if (score <= now) available++;
    return { available, total: this.totals.get(key.toLowerCase()) ?? 0 };
  }
}

let memory: MemoryLocks | null = null;

export function lockStore(): LockStore | null {
  const cfg = upstashEnv();
  if (cfg) return new UpstashLocks(cfg);
  if (process.env.NODE_ENV !== "production") return (memory ??= new MemoryLocks());
  return null;
}
