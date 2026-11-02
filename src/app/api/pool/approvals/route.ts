/**
 * Publishes the pool's approval root by its public rule: every deposit at least
 * POOL_APPROVAL_DELAY_SECONDS old (0 on testnet: right away). Anyone may call it; it only sends a
 * transaction when the approved set would grow, at most once every 10 seconds.
 */
import { NextResponse } from "next/server";
import { verifyPool } from "@/lib/pool/actions";
import { refreshApprovals } from "@/lib/pool/relayer";
import { relayerContext } from "@/lib/pool/server";
import { fetchPoolEvents } from "@/lib/pool/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

export async function POST() {
  const ctx = relayerContext();
  if (!ctx) return NextResponse.json({ error: "The approver is not running." }, { status: 503, headers: noStore });
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
    if (last && now - Number(last.timestamp) < 10) {
      return NextResponse.json({ updated: false, reason: "recent" }, { headers: noStore });
    }
    const r = await refreshApprovals(ctx.client, ctx.wallet, ctx.network, info, events, { delaySeconds: ctx.approvalDelaySeconds, nowSeconds: now });
    return NextResponse.json({ updated: !!r.hash, hash: r.hash, approved: r.approved, uptoBlock: r.uptoBlock.toString() }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "Could not update approvals. Try again shortly." }, { status: 502, headers: noStore });
  }
}
