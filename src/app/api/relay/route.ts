/**
 * Pool withdrawal relayer. GET returns the relayer's terms; POST submits a withdrawal that the
 * user proved in their browser. The proof fixes the recipient, fee address and fee, so this
 * endpoint cannot change where funds go. No request data is stored or logged.
 */
import { NextResponse } from "next/server";
import { formatEther } from "viem";
import { verifyPool } from "@/lib/pool/actions";
import { relayWithdrawal, RelayRejected } from "@/lib/pool/relayer";
import { relayerContext } from "@/lib/pool/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  const ctx = relayerContext();
  if (!ctx) return NextResponse.json({ available: false }, { headers: noStore });
  const balance = await ctx.client.getBalance({ address: ctx.policy.feeRecipient }).catch(() => 0n);
  return NextResponse.json(
    {
      available: balance > ctx.policy.gasDrop * 2n,
      feeRecipient: ctx.policy.feeRecipient,
      feeBPS: ctx.policy.feeBPS.toString(),
      gasDrop: ctx.policy.gasDrop.toString(),
      gasDropEth: formatEther(ctx.policy.gasDrop),
      approvalDelaySeconds: ctx.approvalDelaySeconds,
    },
    { headers: noStore },
  );
}

export async function POST(req: Request) {
  const ctx = relayerContext();
  if (!ctx) return NextResponse.json({ error: "The relayer is not running." }, { status: 503, headers: noStore });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 8_000) return NextResponse.json({ error: "Request too large." }, { status: 413, headers: noStore });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400, headers: noStore });
  }
  try {
    const info = await verifyPool(ctx.client, ctx.network);
    if (!info) return NextResponse.json({ error: "No pool is configured." }, { status: 503, headers: noStore });
    const r = await relayWithdrawal(ctx.client, ctx.wallet, ctx.network, info, ctx.policy, body);
    return NextResponse.json(
      { hash: r.hash, recipient: r.recipient, amount: r.amount.toString(), fee: r.fee.toString(), gasDropHash: r.gasDropHash },
      { headers: noStore },
    );
  } catch (e) {
    if (e instanceof RelayRejected) return NextResponse.json({ error: e.message }, { status: 422, headers: noStore });
    return NextResponse.json({ error: "The relayer could not submit this withdrawal. Try again shortly." }, { status: 502, headers: noStore });
  }
}
