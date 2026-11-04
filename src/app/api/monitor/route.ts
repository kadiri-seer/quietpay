/**
 * Operator view of repeated-action alerts (src/lib/server/monitor.ts).
 *   GET with "Authorization: Bearer <MONITOR_TOKEN>"
 * Not available unless MONITOR_TOKEN is set on the host. Returns the most recent alerts only.
 */
import { NextResponse } from "next/server";
import { recentAlerts } from "@/lib/server/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function GET(req: Request) {
  const token = process.env.MONITOR_TOKEN;
  if (!token || token.length < 24) return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!same(given, token)) return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  try {
    return NextResponse.json({ alerts: await recentAlerts() }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "Alerts are unavailable right now." }, { status: 502, headers: noStore });
  }
}
