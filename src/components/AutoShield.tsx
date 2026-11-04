"use client";

/**
 * Moves money that landed at one-time addresses (payments to older links) into the shielded pool,
 * when you tap "Move into my balance" on Home. Nothing moves on its own. Each payment holding at
 * least the pool's minimum and the payer's gas stipend is deposited; smaller amounts stay where
 * they are and can be moved from Receive.
 */
import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { shieldOneTime } from "@/lib/pool/actions";
import { exclusionsFrom, fetchPoolEvents, reconstructNotes } from "@/lib/pool/state";
import { recordSend, stealthAccount } from "@/lib/receive";
import { paymentRemaining } from "@/lib/balance";
import { usePublicClient } from "./hooks";
import { usePoolInfo, usePoolKeys } from "./pool-hooks";
import { useSelectedNetwork } from "./Providers";
import { useVault } from "./VaultProvider";


export function useMoveIntoPool() {
  const { network } = useSelectedNetwork();
  const { vault, update } = useVault();
  const client = usePublicClient(network);
  const info = usePoolInfo(network);
  const keys = usePoolKeys();
  const queryClient = useQueryClient();
  const busy = useRef(false);
  const [state, setState] = useState<{ busy: boolean; moved: number; skipped: number } | null>(null);

  const run = useCallback(async () => {
    const v = vault;
    if (busy.current || !v || !info.data || keys.length === 0 || !network.pool || !network.token) return;
    busy.current = true;
    setState({ busy: true, moved: 0, skipped: 0 });
    let moved = 0;
    let skipped = 0;
    try {
      const candidates = v.requests.filter((r) => r.chainId === network.chain.id).flatMap((r) => r.payments.filter((p) => paymentRemaining(p) > 0n).map((p) => ({ r, p })));
      for (const { r, p } of candidates) {
        // The deposit index comes from the chain right before each deposit.
        const events = await fetchPoolEvents(client, {
          entrypoint: info.data.entrypoint,
          pool: info.data.pool,
          fromBlock: network.pool.fromBlock,
          chunkSize: network.logChunkSize,
          exclusions: exclusionsFrom(network.pool.exclusionsUrl),
        });
        const { nextDepositIndex } = reconstructNotes(keys[0], info.data.scope, events);
        const res = await shieldOneTime(client, network, info.data, { account: stealthAccount(r, p), keys: keys[0], depositIndex: nextDepositIndex }).catch(() => null);
        if (!res) {
          skipped++;
          continue;
        }
        moved++;
        await update((cur) => {
          const req = cur.requests.find((x) => x.id === r.id);
          if (!req) return cur;
          const updated = recordSend(req, p.stealthAddress, { tx: res.hash, to: info.data!.entrypoint, amount: res.amount }, 0n);
          return { ...cur, requests: cur.requests.map((x) => (x.id === updated.id ? updated : x)) };
        });
      }
    } finally {
      busy.current = false;
      setState({ busy: false, moved, skipped });
    }
    if (moved) {
      await fetch("/api/pool/approvals", { method: "POST" }).catch(() => null);
      await queryClient.invalidateQueries({ queryKey: ["pool-info"] });
      await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
      await queryClient.invalidateQueries({ queryKey: ["onchain-holdings"] });
    }
  }, [vault, info.data, keys, network, client, update, queryClient]);

  return { run, state };
}
