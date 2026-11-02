/**
 * Name reservation logic shared by the API route and tests.
 */
import "server-only";
import type { Address } from "viem";
import { checkName, ReservationError, verifyReservation } from "./names";
import type { NameStore } from "./store";

/** Claims allowed per network address per hour (counted on a scrambled, expiring id). */
export const CLAIMS_PER_HOUR = 5;
export const LOOKUPS_PER_MINUTE = 60;

async function scramble(ip: string, salt: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${ip}`));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function lookup(store: NameStore, q: { name?: string | null; key?: string | null }, ip: string, salt: string) {
  if (!(await store.allow(`l:${await scramble(ip, salt)}`, LOOKUPS_PER_MINUTE, 60))) throw new ReservationError("Too many requests. Wait a minute.", 429);
  const count = await store.count();
  if (q.key) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(q.key)) throw new ReservationError("Malformed key.");
    const mine = await store.byKey(q.key as Address);
    return { count, mine: mine ? { name: mine.name, at: mine.at } : null };
  }
  if (q.name) {
    const c = checkName(q.name);
    if (!c.ok) return { count, name: q.name, available: false, reason: c.reason };
    const taken = await store.get(c.name);
    return { count, name: c.name, available: !taken, reason: taken ? "Already reserved." : null };
  }
  return { count };
}

export async function submit(store: NameStore, raw: unknown, ip: string, salt: string, nowMs = Date.now()) {
  const req = await verifyReservation(raw, nowMs);
  if (req.action === "release") {
    const ok = await store.release(req.name, req.key);
    if (!ok) throw new ReservationError("That name isn't reserved by this key.", 404);
    return { released: req.name, count: await store.count() };
  }
  if (!(await store.allow(`c:${await scramble(ip, salt)}`, CLAIMS_PER_HOUR, 3600)))
    throw new ReservationError("Too many reservations from this network. Try again later.", 429);
  const r = await store.reserve(req.name, req.key, nowMs);
  if (r === "taken") throw new ReservationError("Someone already reserved that name.", 409);
  if (r === "has-name") throw new ReservationError("You already have a name. Release it first to pick another.", 409);
  return { reserved: req.name, at: nowMs, count: await store.count() };
}
