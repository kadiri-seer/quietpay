"use client";

/**
 * Moves money that landed at one-time addresses (payments to older links) into the shielded pool,
 * so your balance is all pool money. While QuietPay is open and unlocked it looks at your link
 * payments every minute and deposits any that hold at least the pool's minimum and the payer's
 * gas stipend. Smaller amounts stay where they are and can be moved from Receive.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { shieldOneTime } from "@/lib/pool/actions";
import { exclusionsFrom, fetchPoolEvents, reconstructNotes } from "@/lib/pool/state";
import { recordSend, stealthAccount } from "@/lib/receive";
import { paymentRemaining } from "@/lib/balance";
import { usePublicClient } from "./hooks";
import { usePoolInfo, usePoolKeys } from "./pool-hooks";
import { useSelectedNetwork } from "./Providers";
import { useVault } from "./VaultProvider";

const EVERY_MS = 60_000;

export function AutoShield() {
  const { network } = useSelectedNetwork();
  const { status, vault, update } = useVault();
  const client = usePublicClient(network);
  const info = usePoolInfo(network);
  const keys = usePoolKeys();
  const queryClient = useQueryClient();
  const busy = useRef(false);
  const latest = useRef(vault);
  latest.current = vault;
  const ready = status === "unlocked" && !!info.data && keys.length > 0 && !!network.pool && !!network.token;

  useEffect(() => {
    if (!ready) return;
    const run = async () => {
      const v = latest.current;
      if (busy.current || !v || !info.data) return;
      const candidates = v.requests.filter((r) => r.chainId === network.chain.id).flatMap((r) => r.payments.filter((p) => paymentRemaining(p) > 0n).map((p) => ({ r, p })));
      if (candidates.length === 0) return;
      busy.current = true;
      let moved = false;
      try {
        for (const { r, p } of candidates) {
          // The deposit index comes from the chain right before each deposit.
          const events = await fetchPoolEvents(client, {
            entrypoint: info.data.entrypoint,
            pool: info.data.pool,
            fromBlock: network.pool!.fromBlock,
            chunkSize: network.logChunkSize,
            exclusions: exclusionsFrom(network.pool!.exclusionsUrl),
          });
          const { nextDepositIndex } = reconstructNotes(keys[0], info.data.scope, events);
          const res = await shieldOneTime(client, network, info.data, { account: stealthAccount(r, p), keys: keys[0], depositIndex: nextDepositIndex }).catch(() => null);
          if (!res) continue;
          moved = true;
          await update((cur) => {
            const req = cur.requests.find((x) => x.id === r.id);
            if (!req) return cur;
            const updated = recordSend(req, p.stealthAddress, { tx: res.hash, to: info.data!.entrypoint, amount: res.amount }, 0n);
            return { ...cur, requests: cur.requests.map((x) => (x.id === updated.id ? updated : x)) };
          });
        }
      } finally {
        busy.current = false;
      }
      if (moved) {
        await fetch("/api/pool/approvals", { method: "POST" }).catch(() => null);
        await queryClient.invalidateQueries({ queryKey: ["pool-info"] });
        await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
        await queryClient.invalidateQueries({ queryKey: ["onchain-holdings"] });
      }
    };
    void run();
    const t = setInterval(run, EVERY_MS);
    return () => clearInterval(t);
  }, [ready, client, network, info.data, keys, update, queryClient, vault?.requests.length]);

  return null;
}
