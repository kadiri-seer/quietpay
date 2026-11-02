/**
 * Abuse limits for the public server routes (relayer, approver): per-client rate limits and
 * short locks shared by every server instance. Uses the same Upstash Redis as the name waitlist
 * when it is connected, otherwise an in-memory fallback (per instance, best effort).
 *
 * Client IDs are salted hashes of the IP address, kept only in counters that expire.
 */
import "server-only";
import { upstashEnv } from "@/lib/names/store";

interface Kv {
  /** Increments `bucket`; false once it passes `limit` within `windowSec`. */
  allow(bucket: string, limit: number, windowSec: number): Promise<boolean>;
  /** Takes `key` for `ttlSec` if free. Returns a token to release it, or null if taken. */
  acquire(key: string, ttlSec: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const RATE_LUA = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

class UpstashKv implements Kv {
  constructor(private cfg: { url: string; token: string }) {}
  private async cmd<T>(args: (string | number)[]): Promise<T> {
    const r = await fetch(this.cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
    });
    const j = (await r.json()) as { result?: T; error?: string };
    if (!r.ok || j.error) throw new Error(`Store error: ${j.error ?? r.status}`);
    return j.result as T;
  }
  async allow(bucket: string, limit: number, windowSec: number) {
    return (await this.cmd<number>(["EVAL", RATE_LUA, 1, `qp:rl:${bucket}`, windowSec])) <= limit;
  }
  async acquire(key: string, ttlSec: number) {
    const token = crypto.randomUUID();
    const ok = await this.cmd<string | null>(["SET", `qp:lock:${key}`, token, "NX", "EX", ttlSec]);
    return ok === "OK" ? token : null;
  }
  async release(key: string, token: string) {
    await this.cmd<number>(["EVAL", RELEASE_LUA, 1, `qp:lock:${key}`, token]);
  }
  async get(key: string) {
    return this.cmd<string | null>(["GET", `qp:${key}`]);
  }
  async set(key: string, value: string) {
    await this.cmd<string>(["SET", `qp:${key}`, value]);
  }
}

class MemoryKv implements Kv {
  private rl = new Map<string, { n: number; until: number }>();
  private locks = new Map<string, { token: string; until: number }>();
  async allow(bucket: string, limit: number, windowSec: number) {
    const now = Date.now();
    const e = this.rl.get(bucket);
    const cur = !e || e.until < now ? { n: 0, until: now + windowSec * 1000 } : e;
    cur.n++;
    this.rl.set(bucket, cur);
    return cur.n <= limit;
  }
  async acquire(key: string, ttlSec: number) {
    const now = Date.now();
    const e = this.locks.get(key);
    if (e && e.until > now) return null;
    const token = crypto.randomUUID();
    this.locks.set(key, { token, until: now + ttlSec * 1000 });
    return token;
  }
  async release(key: string, token: string) {
    if (this.locks.get(key)?.token === token) this.locks.delete(key);
  }
  private data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
}

/** Redis first; if it can't be reached, this instance's memory, so the routes keep working. */
class FallbackKv implements Kv {
  constructor(
    private primary: Kv,
    private backup: Kv,
  ) {}
  allow(bucket: string, limit: number, windowSec: number) {
    return this.primary.allow(bucket, limit, windowSec).catch(() => this.backup.allow(bucket, limit, windowSec));
  }
  acquire(key: string, ttlSec: number) {
    return this.primary.acquire(key, ttlSec).catch(() => this.backup.acquire(key, ttlSec));
  }
  async release(key: string, token: string) {
    await Promise.all([this.primary.release(key, token).catch(() => undefined), this.backup.release(key, token)]);
  }
  get(key: string) {
    return this.primary.get(key).catch(() => this.backup.get(key));
  }
  set(key: string, value: string) {
    return this.primary.set(key, value).catch(() => this.backup.set(key, value));
  }
}

let memory: MemoryKv | null = null;
export function kv(): Kv {
  const cfg = upstashEnv();
  memory ??= new MemoryKv();
  return cfg ? new FallbackKv(new UpstashKv(cfg), memory) : memory;
}

/**
 * For records that must be the same on every server instance (screening verdicts and exclusion
 * lists): Redis only, never a per-instance fallback. When Redis is down this throws, and callers
 * wait and retry instead of acting on data other instances can't see.
 */
export function durableKv(): Pick<Kv, "get" | "set"> {
  const cfg = upstashEnv();
  memory ??= new MemoryKv();
  return cfg ? new UpstashKv(cfg) : memory;
}

/** A salted hash of the caller's IP address, for rate-limit counters only. */
export async function clientId(req: Request): Promise<string> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  const salt = process.env.NAMES_RATE_SALT || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "quietpay-dev";
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${ip}`));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True if this client may make another `name` request (limit per window). Fails open if the store is down. */
export async function rateLimit(req: Request, name: string, limit: number, windowSec: number): Promise<boolean> {
  try {
    return await kv().allow(`${name}:${await clientId(req)}`, limit, windowSec);
  } catch {
    return true;
  }
}

/** Runs `fn` holding `key`, waiting up to `waitMs` for it. Returns null if it stayed taken. */
export async function withLock<T>(key: string, ttlSec: number, waitMs: number, fn: () => Promise<T>): Promise<{ value: T } | null> {
  const store = kv();
  const deadline = Date.now() + waitMs;
  let token: string | null = null;
  for (;;) {
    token = await store.acquire(key, ttlSec);
    if (token || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!token) return null;
  try {
    return { value: await fn() };
  } finally {
    await store.release(key, token).catch(() => undefined);
  }
}

/** Reads a JSON body of at most `maxBytes`, whatever the Content-Length header says. */
export async function readJson(req: Request, maxBytes: number): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const text = await req.text().catch(() => null);
  if (text === null) return { ok: false, status: 400 };
  if (text.length > maxBytes) return { ok: false, status: 413 };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}
