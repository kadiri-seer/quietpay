/**
 * Published exclusion lists: deposits the approver left out of the approved set because they
 * failed sanctions screening. GET ?x=<id>, where <id> is in the onchain approval rule
 * (quietpay-asp-v2:…:x=<id>). Each version never changes, so it is cached for good; clients check
 * the labels against the id and the onchain root.
 */
import { NextResponse } from "next/server";
import { latestExclusions, publishedExclusions } from "@/lib/screening/approver";
import { rateLimit } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await rateLimit(req, "exclusions", 120, 60))) {
    return NextResponse.json({ error: "Too many requests. Wait a minute." }, { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  const id = new URL(req.url).searchParams.get("x");
  if (id === null) {
    // No id: the latest exclusions, including any not yet in an onchain rule. The site uses this
    // only to tell people a deposit won't be approved; approvals always come from the onchain rule.
    try {
      return NextResponse.json({ labels: await latestExclusions() }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ error: "Exclusion lists are temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }
  if (!/^[0-9a-f]{16}$/.test(id)) return NextResponse.json({ error: "Unknown list." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  try {
    const doc = await publishedExclusions(id);
    if (!doc) return NextResponse.json({ error: "Unknown list." }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json(doc, { headers: { "Cache-Control": "public, max-age=31536000, immutable" } });
  } catch {
    return NextResponse.json({ error: "Exclusion lists are temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
