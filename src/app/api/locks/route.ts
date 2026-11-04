/**
 * Payment locks for @usernames and personal links (src/lib/pool/locks.ts).
 *   GET ?name=kadiri | ?key=0x…        one lock for a payer (held 15 minutes)
 *   GET ?key=0x…&counts=1              free and uploaded counts, for the recipient's devices
 *   POST {key, locks:[{p,r,s}]}        add locks, each signed by `key`
 * Stores locks (hashes and refund addresses) and their signatures. No wallet addresses, no IP logs.
 */
import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { NETWORKS } from "@/config/networks";
import { Entrypoint } from "@/config/pool-contracts.generated";
import { ReservationError } from "@/lib/names/names";
import { nameStore } from "@/lib/names/store";
import { lockStore } from "@/lib/pool/lock-store";
import { lockCounts, takeLock, uploadLocks, type LockDeps } from "@/lib/pool/lock-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const ipOf = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
const salt = () => process.env.NAMES_RATE_SALT || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "quietpay-dev";

function deps(): LockDeps | null {
  const network = NETWORKS.testnet;
  const locks = lockStore();
  const names = nameStore();
  if (!locks || !names || !network.pool?.router) return null;
  const client = createPublicClient({ chain: network.chain, transport: http(network.rpcUrl, { timeout: 10_000 }) });
  return {
    locks,
    names,
    chainId: network.chain.id,
    pool: network.pool.pool,
    isUsed: (p) => client.readContract({ address: network.pool!.entrypoint, abi: Entrypoint.abi, functionName: "usedPrecommitments", args: [p] }),
  };
}

function fail(e: unknown) {
  if (e instanceof ReservationError) return NextResponse.json({ error: e.message }, { status: e.status, headers: noStore });
  return NextResponse.json({ error: "Payments to usernames are temporarily unavailable. Try again shortly." }, { status: 502, headers: noStore });
}

export async function GET(req: Request) {
  const d = deps();
  if (!d) return NextResponse.json({ error: "Payments to usernames aren't available here." }, { status: 503, headers: noStore });
  const u = new URL(req.url);
  try {
    if (u.searchParams.get("counts")) return NextResponse.json(await lockCounts(d, u.searchParams.get("key") ?? ""), { headers: noStore });
    return NextResponse.json(await takeLock(d, { name: u.searchParams.get("name"), key: u.searchParams.get("key") }, ipOf(req), salt()), { headers: noStore });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  const d = deps();
  if (!d) return NextResponse.json({ error: "Payments to usernames aren't available here." }, { status: 503, headers: noStore });
  if (Number(req.headers.get("content-length") ?? 0) > 40_000) return NextResponse.json({ error: "Request too large." }, { status: 413, headers: noStore });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400, headers: noStore });
  }
  try {
    return NextResponse.json(await uploadLocks(d, body), { headers: noStore });
  } catch (e) {
    return fail(e);
  }
}
