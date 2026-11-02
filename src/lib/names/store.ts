/**
 * Storage for name reservations: Upstash Redis (attached through Vercel) in production, an
 * in-memory map in local development and tests.
 *
 * Stored per reservation: the name, the name key's address and the time. Nothing else.
 *   qp:name:<name>  -> {"key":"0x…","at":<ms>}
 *   qp:key:<key>    -> <name>
 *   qp:count        -> number of reserved names
 *   qp:rl:<bucket>  -> short-lived rate-limit counter (expires after its window)
 */
import "server-only";
import type { Address } from "viem";

export interface Reservation {
  name: string;
  key: Address;
  at: number;
}

export type ReserveResult = "ok" | "taken" | "has-name";

export interface NameStore {
  get(name: string): Promise<Reservation | null>;
  byKey(key: Address): Promise<Reservation | null>;
  reserve(name: string, key: Address, at: number): Promise<ReserveResult>;
  release(name: string, key: Address): Promise<boolean>;
  count(): Promise<number>;
  /** Increments a counter for `bucket`; returns false once it passes `limit` within `windowSec`. */
  allow(bucket: string, limit: number, windowSec: number): Promise<boolean>;
}

const P = "qp:";
const nameKey = (n: string) => `${P}name:${n}`;
const ownerKey = (k: string) => `${P}key:${k.toLowerCase()}`;

// Atomic reserve: fails if the name is taken or the key already holds a name.
const RESERVE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return -1 end
if redis.call('SET', KEYS[1], ARGV[1], 'NX') then
  redis.call('SET', KEYS[2], ARGV[2])
  redis.call('INCR', KEYS[3])
  return 1
end
return 0`;

// Atomic release: only the key that reserved a name can release it.
const RELEASE_LUA = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('DECR', KEYS[3])
return 1`;

const RATE_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/** Finds the Upstash REST credentials Vercel added, whatever prefix the integration used. */
export function upstashEnv(): { url: string; token: string } | null {
  const env = process.env;
  const pick = (suffix: string) => {
    const k = Object.keys(env).find((x) => x === suffix || x.endsWith(`_${suffix}`));
    return k ? env[k] : undefined;
  };
  const url = pick("KV_REST_API_URL") ?? pick("UPSTASH_REDIS_REST_URL");
  const token = pick("KV_REST_API_TOKEN") ?? pick("UPSTASH_REDIS_REST_TOKEN");
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

class UpstashStore implements NameStore {
  constructor(private cfg: { url: string; token: string }) {}

  private async cmd<T>(args: (string | number)[]): Promise<T> {
    const r = await fetch(this.cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
    });
    const j = (await r.json()) as { result?: T; error?: string };
    if (!r.ok || j.error) throw new Error(`Name store error: ${j.error ?? r.status}`);
    return j.result as T;
  }

  async get(name: string) {
    const v = await this.cmd<string | null>(["GET", nameKey(name)]);
    if (!v) return null;
    const rec = JSON.parse(v) as { key: Address; at: number };
    return { name, key: rec.key, at: rec.at };
  }
  async byKey(key: Address) {
    const name = await this.cmd<string | null>(["GET", ownerKey(key)]);
    return name ? this.get(name) : null;
  }
  async reserve(name: string, key: Address, at: number): Promise<ReserveResult> {
    const r = await this.cmd<number>(["EVAL", RESERVE_LUA, 3, nameKey(name), ownerKey(key), `${P}count`, JSON.stringify({ key, at }), name]);
    return r === 1 ? "ok" : r === -1 ? "has-name" : "taken";
  }
  async release(name: string, key: Address) {
    return (await this.cmd<number>(["EVAL", RELEASE_LUA, 3, nameKey(name), ownerKey(key), `${P}count`, name])) === 1;
  }
  async count() {
    return Number((await this.cmd<string | null>(["GET", `${P}count`])) ?? 0);
  }
  async allow(bucket: string, limit: number, windowSec: number) {
    return (await this.cmd<number>(["EVAL", RATE_LUA, 1, `${P}rl:${bucket}`, windowSec])) <= limit;
  }
}

export class MemoryStore implements NameStore {
  private names = new Map<string, { key: Address; at: number }>();
  private owners = new Map<string, string>();
  private rl = new Map<string, { n: number; until: number }>();
  async get(name: string) {
    const r = this.names.get(name);
    return r ? { name, ...r } : null;
  }
  async byKey(key: Address) {
    const n = this.owners.get(key.toLowerCase());
    return n ? this.get(n) : null;
  }
  async reserve(name: string, key: Address, at: number): Promise<ReserveResult> {
    if (this.owners.has(key.toLowerCase())) return "has-name";
    if (this.names.has(name)) return "taken";
    this.names.set(name, { key, at });
    this.owners.set(key.toLowerCase(), name);
    return "ok";
  }
  async release(name: string, key: Address) {
    if (this.owners.get(key.toLowerCase()) !== name) return false;
    this.names.delete(name);
    this.owners.delete(key.toLowerCase());
    return true;
  }
  async count() {
    return this.names.size;
  }
  async allow(bucket: string, limit: number, windowSec: number) {
    const now = Date.now();
    const e = this.rl.get(bucket);
    const cur = !e || e.until < now ? { n: 0, until: now + windowSec * 1000 } : e;
    cur.n++;
    this.rl.set(bucket, cur);
    return cur.n <= limit;
  }
}

let memory: MemoryStore | null = null;

/** The configured store, an in-memory one in development, or null in production without Redis. */
export function nameStore(): NameStore | null {
  const cfg = upstashEnv();
  if (cfg) return new UpstashStore(cfg);
  if (process.env.NODE_ENV !== "production") return (memory ??= new MemoryStore());
  return null;
}
