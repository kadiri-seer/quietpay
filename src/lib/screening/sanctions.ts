/**
 * OFAC-sanctioned crypto addresses that apply to EVM chains (any address OFAC lists as
 * "Digital Currency Address - ETH / USDT / USDC / ARB / BSC / ETC …" in 0x form).
 *
 * Sources, all derived from the official SDN list:
 *  - the official SDN.CSV from OFAC's Sanctions List Service (when reachable);
 *  - 0xB10C/ofac-sanctioned-digital-currency-addresses, regenerated daily from the official
 *    SDN XML, one file per currency;
 *  - a bundled copy (src/config/sanctioned-evm.json, `npm run sanctions:update`), used only when
 *    no live source answers, so screening never stops.
 *
 * Live results are cached for a few hours. Addresses OFAC removes drop out at the next refresh,
 * because a successful live fetch replaces the bundled copy instead of adding to it.
 */
import bundled from "@/config/sanctioned-evm.json";

const OFFICIAL_SDN_CSV = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";
const MIRROR = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_";
/** Currencies OFAC tags that use 0x addresses on EVM chains. */
const MIRROR_TAGS = ["ETH", "USDT", "USDC", "ARB", "BSC", "ETC"];
const REFRESH_MS = 6 * 3600_000;

const ADDR = /0x[0-9a-fA-F]{40}/g;

/** Addresses from a plain list (one per line), lowercased. */
export function parseAddressList(text: string): string[] {
  return [...new Set((text.match(ADDR) ?? []).map((a) => a.toLowerCase()))];
}

/** 0x addresses from the official SDN CSV's "Digital Currency Address - XXX 0x…" remarks. */
export function parseSdnCsv(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/Digital Currency Address - [A-Z0-9.]+ (0x[0-9a-fA-F]{40})/g)) out.add(m[1].toLowerCase());
  return [...out];
}

async function get(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

/** Fetches every live source; null if none answered. */
export async function fetchLiveSanctions(): Promise<{ addresses: string[]; sources: string[] } | null> {
  const sources: string[] = [];
  const all = new Set<string>();
  const official = await get(OFFICIAL_SDN_CSV);
  if (official && official.includes("Digital Currency Address")) {
    parseSdnCsv(official).forEach((a) => all.add(a));
    sources.push("OFAC SDN.CSV");
  }
  const mirror = await Promise.all(MIRROR_TAGS.map((t) => get(`${MIRROR}${t}.txt`)));
  if (mirror.every((t) => t !== null)) {
    mirror.forEach((t) => parseAddressList(t!).forEach((a) => all.add(a)));
    sources.push("0xB10C OFAC mirror");
  }
  // A broken download shouldn't quietly shrink the list: far fewer addresses than the bundled
  // copy means something went wrong, so fall back instead.
  if (!sources.length || all.size < bundled.addresses.length / 2) return null;
  return { addresses: [...all].sort(), sources };
}

export interface SanctionsList {
  has(address: string): boolean;
  size: number;
  /** "live" when a live source answered at the last refresh, otherwise "bundled". */
  source: "live" | "bundled";
  asOf: string;
}

function toList(addresses: string[], source: "live" | "bundled", asOf: string): SanctionsList {
  const set = new Set(addresses.map((a) => a.toLowerCase()));
  return { has: (a) => set.has(a.toLowerCase()), size: set.size, source, asOf };
}

export function bundledSanctions(): SanctionsList {
  return toList(bundled.addresses, "bundled", bundled.updatedAt);
}

let cached: { list: SanctionsList; at: number } | null = null;

/** The current list: live if fetched in the last few hours, refreshed when stale, bundled as a fallback. */
export async function sanctionsList(now = Date.now()): Promise<SanctionsList> {
  if (cached && now - cached.at < REFRESH_MS) return cached.list;
  const live = await fetchLiveSanctions();
  if (live) {
    cached = { list: toList(live.addresses, "live", new Date(now).toISOString()), at: now };
  } else {
    // Keep the last live list if we had one; otherwise the bundled copy. Retry sooner.
    cached = { list: cached?.list ?? bundledSanctions(), at: now - REFRESH_MS + 10 * 60_000 };
  }
  return cached.list;
}
