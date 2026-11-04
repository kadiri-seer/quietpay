"use client";

/**
 * Payments waiting for the pool's approver are approved when someone asks (on testnet right away,
 * on mainnet after screening). While you have payments waiting, this asks every few seconds, so
 * they show up as spendable without visiting the Pool page.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePoolSnapshot } from "./pool-hooks";
import { useSelectedNetwork } from "./Providers";
import { useVault } from "./VaultProvider";

export function ApprovalNudge() {
  const { network } = useSelectedNetwork();
  const { status } = useVault();
  const snap = usePoolSnapshot(network);
  const queryClient = useQueryClient();
  const waiting = status === "unlocked" ? (snap.data?.notes ?? []).filter((n) => n.status === "spendable" && !n.approved && !n.excluded).length : 0;

  useEffect(() => {
    if (!waiting || !network.pool) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await fetch("/api/pool/approvals", { method: "POST" });
        const j = (await r.json().catch(() => ({}))) as { updated?: boolean };
        if (j.updated) {
          await queryClient.invalidateQueries({ queryKey: ["pool-info"] });
          await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
        }
      } catch {
        /* next tick */
      }
    };
    void tick();
    const t = setInterval(tick, 6000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [waiting, network.pool, queryClient]);

  return null;
}
