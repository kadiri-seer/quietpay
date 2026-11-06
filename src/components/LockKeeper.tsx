"use client";

/**
 * Keeps enough signed pool locks on QuietPay's server for your personal link to be
 * paid (src/lib/pool/locks.ts). While QuietPay is open and unlocked it checks how many are free
 * and, below LOW, makes and uploads BATCH more from your pool keys, signed by your name key.
 * Payments to them are found by the pool snapshot, which looks through every lock made so far.
 */
import { useEffect, useRef } from "react";
import { privateKeyToAccount } from "viem/accounts";
import { personalLock, signLock } from "@/lib/pool/locks";
import { usePoolInfo, usePoolKeys, usePoolRouter } from "./pool-hooks";
import { useSelectedNetwork } from "./Providers";
import { useVault } from "./VaultProvider";

const LOW = 10;
const BATCH = 25;
const EVERY_MS = 5 * 60_000;

export async function topUpLocks(p: {
  nameKey: `0x${string}`;
  keys: Parameters<typeof personalLock>[0];
  scope: bigint;
  chainId: number;
  pool: `0x${string}`;
  localCount: number;
  fetcher?: typeof fetch;
}): Promise<{ count: number; uploaded: number } | null> {
  const f = p.fetcher ?? fetch;
  const key = privateKeyToAccount(p.nameKey).address;
  const r = await f(`/api/locks?key=${key}&counts=1`, { cache: "no-store" });
  if (!r.ok) return null;
  const c = (await r.json()) as { available: number; total: number };
  let count = Math.max(p.localCount, c.total);
  if (c.available >= LOW) return { count, uploaded: 0 };
  const locks = [];
  for (let j = count; j < count + BATCH; j++) {
    const l = personalLock(p.keys, p.scope, BigInt(j));
    locks.push(await signLock(p.nameKey, { chainId: p.chainId, pool: p.pool, precommitment: l.precommitment, refund: l.refund }));
  }
  const up = await f("/api/locks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, locks }) });
  if (!up.ok) return { count, uploaded: 0 };
  count += BATCH;
  return { count, uploaded: BATCH };
}

export function LockKeeper() {
  const { network } = useSelectedNetwork();
  const { status, vault, update } = useVault();
  const router = usePoolRouter(network);
  const info = usePoolInfo(network);
  const keys = usePoolKeys();
  const busy = useRef(false);
  const latest = useRef(vault);
  latest.current = vault;
  const ready = status === "unlocked" && !!router.data && !!info.data && keys.length > 0 && !!vault?.nameKey;
  const scope = info.data?.scope;
  const pool = info.data?.pool;

  useEffect(() => {
    if (!ready || scope === undefined || !pool) return;
    const run = async () => {
      const v = latest.current;
      if (busy.current || !v?.nameKey) return;
      busy.current = true;
      try {
        const r = await topUpLocks({ nameKey: v.nameKey, keys: keys[0], scope, chainId: network.chain.id, pool, localCount: v.lockCount ?? 0 });
        if (r && r.count !== (v.lockCount ?? 0)) await update((cur) => ({ ...cur, lockCount: Math.max(cur.lockCount ?? 0, r.count) }));
      } catch {
        /* try again on the next tick */
      } finally {
        busy.current = false;
      }
    };
    void run();
    const t = setInterval(run, EVERY_MS);
    return () => clearInterval(t);
  }, [ready, scope, pool, keys, network.chain.id, update]);

  return null;
}
