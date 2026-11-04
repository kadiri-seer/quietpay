/**
 * Name waitlist API.
 *   GET  ?name=kadiri   availability      GET ?key=0x…   your reservation      GET  open or not
 *   POST {action,name,key,issuedAt,signature}   reserve or release (signed by the name key)
 * Stores only the name, the name key's address and the time. No wallet addresses, no IP logs.
 */
import { NextResponse } from "next/server";
import { ReservationError } from "@/lib/names/names";
import { lookup, submit } from "@/lib/names/service";
import { nameStore } from "@/lib/names/store";
import { watchCaller } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function ipOf(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}
// Salt for scrambling IPs in rate-limit counters; never stored next to reservations.
const salt = () => process.env.NAMES_RATE_SALT || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "quietpay-dev";

function fail(e: unknown) {
  if (e instanceof ReservationError) return NextResponse.json({ error: e.message }, { status: e.status, headers: noStore });
  return NextResponse.json({ error: "Reservations are temporarily unavailable. Try again shortly." }, { status: 502, headers: noStore });
}

export async function GET(req: Request) {
  const store = nameStore();
  if (!store) return NextResponse.json({ error: "Name reservations aren't open yet." }, { status: 503, headers: noStore });
  const u = new URL(req.url);
  await watchCaller(req, "name.lookup.caller");
  try {
    return NextResponse.json(await lookup(store, { name: u.searchParams.get("name"), key: u.searchParams.get("key") }, ipOf(req), salt()), { headers: noStore });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  const store = nameStore();
  if (!store) return NextResponse.json({ error: "Name reservations aren't open yet." }, { status: 503, headers: noStore });
  if (Number(req.headers.get("content-length") ?? 0) > 2000) return NextResponse.json({ error: "Request too large." }, { status: 413, headers: noStore });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400, headers: noStore });
  }
  await watchCaller(req, "name.claim.caller");
  try {
    return NextResponse.json(await submit(store, body, ipOf(req), salt()), { headers: noStore });
  } catch (e) {
    return fail(e);
  }
}
