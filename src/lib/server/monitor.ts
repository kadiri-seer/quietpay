/**
 * Watching for repeated actions.
 *
 * Every public action the server takes (handing out payment locks, uploading locks, reserving
 * names, relaying, approving) is counted per subject in short windows. When a count passes its
 * threshold, the first time in that window, the server logs a warning and keeps the alert in a
 * short list the operator can read at /api/monitor (with MONITOR_TOKEN). Limits that actually
 * refuse requests live in the routes; this is what makes unusual activity visible.
 *
 * Subjects are a salted hash of the caller's address (never the IP itself) or a public key.
 */
import "server-only";
import { durableKv, kv } from "./guard";

export const RULES = {
  /** Payment locks handed out for one recipient. */
  "lock.take.recipient": { alertAt: 60, windowSec: 3600 },
  /** Payment locks one caller asks for (any recipient). */
  "lock.take.caller": { alertAt: 30, windowSec: 600 },
  /** A recipient asking for a lock while none is free (someone may be holding them all). */
  "lock.empty.recipient": { alertAt: 5, windowSec: 3600 },
  "lock.upload.recipient": { alertAt: 12, windowSec: 3600 },
  "name.claim.caller": { alertAt: 10, windowSec: 3600 },
  /** Gas top-ups: per receiving address, per caller, and refusals by a limit. */
  "gasdrop.recipient": { alertAt: 2, windowSec: 86400 },
  "gasdrop.caller": { alertAt: 3, windowSec: 86400 },
  "gasdrop.denied": { alertAt: 10, windowSec: 3600 },
  /** The relayer's ETH is below its minimum (top-ups stop). */
  "relayer.low-balance": { alertAt: 0, windowSec: 3600 },
  /** Approval roots deferred or published. */
  "approvals.root": { alertAt: 120, windowSec: 3600 },
  "name.lookup.caller": { alertAt: 300, windowSec: 600 },
  "relay.caller": { alertAt: 40, windowSec: 600 },
  "approvals.caller": { alertAt: 2000, windowSec: 3600 },
  /** Requests refused by a rate limit, per route and caller. */
  "limit.hit": { alertAt: 20, windowSec: 600 },
} as const;

export type MonitorEvent = keyof typeof RULES;

export interface Alert {
  event: MonitorEvent;
  subject: string;
  count: number;
  windowSec: number;
  at: string;
}

const ALERTS_KEY = "mon:alerts";
const MAX_ALERTS = 200;

/** Counts one occurrence. Never throws: monitoring must not break the action it watches. */
export async function watch(event: MonitorEvent, subject: string): Promise<number> {
  const rule = RULES[event];
  try {
    const n = await kv().count(`mon:${event}:${subject}`, rule.windowSec);
    if (n === rule.alertAt + 1) {
      const alert: Alert = { event, subject, count: n, windowSec: rule.windowSec, at: new Date().toISOString() };
      console.warn(JSON.stringify({ quietpay: "repeated-action", ...alert }));
      await record(alert);
    }
    return n;
  } catch {
    return 0;
  }
}

async function record(alert: Alert) {
  try {
    const store = durableKv();
    const raw = await store.get(ALERTS_KEY);
    const list = raw ? (JSON.parse(raw) as Alert[]) : [];
    list.unshift(alert);
    await store.set(ALERTS_KEY, JSON.stringify(list.slice(0, MAX_ALERTS)));
  } catch {
    /* the log line above still has it */
  }
}

export async function recentAlerts(): Promise<Alert[]> {
  const raw = await durableKv().get(ALERTS_KEY);
  return raw ? (JSON.parse(raw) as Alert[]) : [];
}
