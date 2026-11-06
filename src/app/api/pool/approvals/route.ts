/**
 * Publishes the pool's approval root by its public rule: every deposit at least
 * POOL_APPROVAL_DELAY_SECONDS old (0 on testnet: right away). Anyone may call it; it only sends a
 * transaction when the approved set would grow, and on a fixed cadence: at most one root every
 * POOL_ROOT_INTERVAL_SECONDS (default 60), held back while a relay is being submitted (up to three
 * intervals). See approvalRootDecision in src/lib/pool/relayer.ts for why.
 */
import { NextResponse } from "next/server";
import { verifyPool } from "@/lib/pool/actions";
import { approvalRootDecision, refreshApprovals } from "@/lib/pool/relayer";
import { watch } from "@/lib/server/monitor";
import { relayerContext } from "@/lib/pool/server";
import { fetchPoolEvents } from "@/lib/pool/state";
import { kv, rateLimit, watchCaller, withLock } from "@/lib/server/guard";
import { approverScreening } from "@/lib/screening/approver";

/** Calls per client per minute. The site asks at most every few seconds while a deposit waits. */
const CALLS_PER_MIN = 30;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

/** Seconds between approval roots: POOL_ROOT_INTERVAL_SECONDS, 15 to 3600, default 60. */
function rootIntervalSeconds() {
  const n = Number(process.env.POOL_ROOT_INTERVAL_SECONDS ?? 60);
  return Number.isFinite(n) ? Math.min(3600, Math.max(15, Math.floor(n))) : 60;
}

export async function POST(req: Request) {
  await watchCaller(req, "approvals.caller");
  if (!(await rateLimit(req, "approvals", CALLS_PER_MIN, 60))) {
    return NextResponse.json({ error: "Too many requests. Wait a minute." }, { status: 429, headers: noStore });
  }
  const ctx = relayerContext();
  if (!ctx) return NextResponse.json({ error: "The approver is not running." }, { status: 503, headers: noStore });
  // One approval update at a time across all server instances; a call that finds one running
  // simply returns, since that update will cover its deposit too.
  const r = await withLock("approver", 90, 0, () => approve(ctx)).catch(() => ({ value: null }));
  if (!r) return NextResponse.json({ updated: false, reason: "busy" }, { headers: noStore });
  return r.value ?? NextResponse.json({ error: "Could not update approvals. Try again shortly." }, { status: 502, headers: noStore });
}

async function approve(ctx: NonNullable<ReturnType<typeof relayerContext>>) {
  try {
    const info = await verifyPool(ctx.client, ctx.network);
    if (!info) return NextResponse.json({ error: "No pool is configured." }, { status: 503, headers: noStore });
    const events = await fetchPoolEvents(ctx.client, {
      entrypoint: info.entrypoint,
      pool: info.pool,
      fromBlock: ctx.network.pool!.fromBlock,
      chunkSize: ctx.network.logChunkSize,
    });
    const last = events.rootUpdates.at(-1);
    const now = Math.floor(Date.now() / 1000);
    const intervalSec = rootIntervalSeconds();
    const busy = Number((await kv().get("relay:busy-until").catch(() => null)) ?? 0) || null;
    const decision = approvalRootDecision({ nowSec: now, lastRootAtSec: last ? Number(last.timestamp) : null, intervalSec, maxDeferSec: intervalSec * 3, relayBusyUntilSec: busy });
    if (!decision.publish) {
      return NextResponse.json({ updated: false, reason: decision.reason, retryAt: decision.retryAtSec }, { headers: noStore });
    }
    const r = await refreshApprovals(ctx.client, ctx.wallet, ctx.network, info, events, {
      delaySeconds: ctx.approvalDelaySeconds,
      nowSeconds: now,
      screening: ctx.screening
        ? approverScreening(ctx.client, {
            token: ctx.network.token!,
            fromBlock: ctx.network.announcerFromBlock ?? ctx.network.pool!.fromBlock,
            ignore: [info.pool, info.entrypoint],
            poolRouters: [ctx.network.pool!.router, ...(ctx.network.pool!.legacyRouters ?? [])].filter((a): a is `0x${string}` => !!a),
          })
        : undefined,
      // The approver signs with the relayer's key, so its transaction takes the relayer's send lock
      // (only for the send itself, not while screening).
      send: async (fn) => {
        const r = await withLock("relayer:send", 30, 20_000, fn);
        if (!r) throw new Error("The relayer is busy.");
        return r.value;
      },
    });
    if (r.hash) await watch("approvals.root", "published");
    return NextResponse.json(
      { updated: !!r.hash, hash: r.hash, approved: r.approved, excluded: r.excluded, uptoBlock: r.uptoBlock.toString() },
      { headers: noStore },
    );
  } catch {
    return NextResponse.json({ error: "Could not update approvals. Try again shortly." }, { status: 502, headers: noStore });
  }
}
