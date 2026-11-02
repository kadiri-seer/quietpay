/**
 * Pool withdrawal relayer. GET returns the relayer's terms; POST submits a withdrawal that the
 * user proved in their browser. The proof fixes the recipient, fee address and fee, so this
 * endpoint cannot change where funds go. No request data is stored or logged.
 */
import { NextResponse } from "next/server";
import { formatEther } from "viem";
import { verifyPool } from "@/lib/pool/actions";
import { quoteMinWithdrawal, relayWithdrawal, RelayRejected } from "@/lib/pool/relayer";
import { relayerContext, withPrice } from "@/lib/pool/server";
import { kv, rateLimit, readJson, withLock } from "@/lib/server/guard";
import type { RelayGuard } from "@/lib/pool/relayer";

/** Withdrawals per client per 10 minutes, and terms lookups per minute. */
const RELAYS_PER_10_MIN = 30;
const TERMS_PER_MIN = 120;

const guard: RelayGuard = {
  async claim(nullifierHash) {
    const key = `relay:nf:${nullifierHash.toString(16)}`;
    const token = await kv().acquire(key, 300);
    return token ? () => kv().release(key, token) : null;
  },
  async send(fn) {
    const r = await withLock("relayer:send", 30, 20_000, fn);
    if (!r) throw new Error("The relayer is busy. Try again shortly.");
    return r.value;
  },
};
const tooMany = () => NextResponse.json({ error: "Too many requests. Wait a few minutes and try again." }, { status: 429, headers: { "Cache-Control": "no-store" } });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  if (!(await rateLimit(req, "terms", TERMS_PER_MIN, 60))) return tooMany();
  const ctx = relayerContext();
  if (!ctx) return NextResponse.json({ available: false }, { headers: noStore });
  const balance = await ctx.client.getBalance({ address: ctx.policy.feeRecipient }).catch(() => 0n);
  const minWithdrawal = await withPrice(ctx)
    .then((p) => quoteMinWithdrawal(ctx.client, p))
    .catch(() => null);
  return NextResponse.json(
    {
      available: balance > ctx.policy.gasDrop * 2n,
      // Smallest amount whose fee covers the relay at today's gas price (token base units).
      minWithdrawal: minWithdrawal?.toString() ?? null,
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
  if (!(await rateLimit(req, "relay", RELAYS_PER_10_MIN, 600))) return tooMany();
  const read = await readJson(req, 8_000);
  if (!read.ok) return NextResponse.json({ error: read.status === 413 ? "Request too large." : "Malformed request." }, { status: read.status, headers: noStore });
  const body = read.body;
  try {
    const info = await verifyPool(ctx.client, ctx.network);
    if (!info) return NextResponse.json({ error: "No pool is configured." }, { status: 503, headers: noStore });
    const r = await relayWithdrawal(ctx.client, ctx.wallet, ctx.network, info, await withPrice(ctx), body, guard);
    return NextResponse.json(
      { hash: r.hash, recipient: r.recipient, amount: r.amount.toString(), fee: r.fee.toString(), gasDropHash: r.gasDropHash },
      { headers: noStore },
    );
  } catch (e) {
    if (e instanceof RelayRejected) {
      return NextResponse.json({ error: e.message, minWithdrawal: e.minWithdrawal?.toString() }, { status: 422, headers: noStore });
    }
    return NextResponse.json({ error: "The relayer could not submit this withdrawal. Try again shortly." }, { status: 502, headers: noStore });
  }
}
