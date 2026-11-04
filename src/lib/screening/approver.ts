/**
 * The approver's screening, wired to storage: verdicts and exclusion lists live in Redis
 * (durableKv) so every server instance agrees, and each exclusion list version is published for
 * clients at /api/pool/exclusions?x=<id>.
 */
import "server-only";
import type { Address, PublicClient } from "viem";
import type { ApprovalScreening } from "@/lib/pool/relayer";
import { exclusionListId } from "@/lib/pool/state";
import { durableKv } from "@/lib/server/guard";
import { sanctionsList } from "./sanctions";
import { screenDeposit, type Verdict } from "./screen";

export interface PublishedExclusions {
  id: string;
  labels: string[];
  /** Why each deposit was excluded: the address that matched the list. */
  reasons: Record<string, { address: Address; list: string }>;
  at: string;
}

export function approverScreening(client: PublicClient, p: { token: Address; fromBlock: bigint; ignore: Address[]; poolRouters?: Address[] }): ApprovalScreening {
  const kv = durableKv();
  const reasons = new Map<string, Address>();
  return {
    async excluded() {
      const raw = await kv.get("asp:excluded");
      return raw ? (JSON.parse(raw) as string[]).map((l) => BigInt(l)) : [];
    },
    async verdict(deposit) {
      const key = `asp:v:${deposit.label.toString()}`;
      const cached = await kv.get(key);
      let v: Verdict;
      if (cached) {
        v = JSON.parse(cached) as Verdict;
      } else {
        const list = await sanctionsList();
        v = await screenDeposit(client, { deposit, token: p.token, list, fromBlock: p.fromBlock, ignore: p.ignore, poolRouters: p.poolRouters });
        await kv.set(key, JSON.stringify(v));
      }
      if (!v.ok) {
        reasons.set(deposit.label.toString(), v.flagged);
        // Record it right away, so the site can say so even before the next approval rule is
        // published (when nothing else is waiting, no new rule is needed).
        const raw = await kv.get("asp:excluded");
        const all = new Set(raw ? (JSON.parse(raw) as string[]) : []);
        if (!all.has(deposit.label.toString())) {
          all.add(deposit.label.toString());
          await kv.set("asp:excluded", JSON.stringify([...all].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))));
        }
      }
      return v;
    },
    async publish(labels) {
      const id = exclusionListId(labels);
      const sorted = [...labels].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String);
      const prev = await kv.get(`asp:x:${id}`);
      if (!prev) {
        const why: PublishedExclusions["reasons"] = {};
        for (const l of sorted) {
          let a = reasons.get(l);
          if (!a) {
            const cached = await kv.get(`asp:v:${l}`);
            const v = cached ? (JSON.parse(cached) as Verdict) : null;
            if (v && !v.ok) a = v.flagged;
          }
          if (a) why[l] = { address: a, list: "OFAC SDN" };
        }
        const doc: PublishedExclusions = { id, labels: sorted, reasons: why, at: new Date().toISOString() };
        await kv.set(`asp:x:${id}`, JSON.stringify(doc));
      }
      return id;
    },
  };
}

/** Every deposit excluded so far, including any not yet in a published rule. For display only. */
export async function latestExclusions(): Promise<string[]> {
  const raw = await durableKv().get("asp:excluded");
  return raw ? (JSON.parse(raw) as string[]) : [];
}

export async function publishedExclusions(id: string): Promise<PublishedExclusions | null> {
  const raw = await durableKv().get(`asp:x:${id}`);
  return raw ? (JSON.parse(raw) as PublishedExclusions) : null;
}
