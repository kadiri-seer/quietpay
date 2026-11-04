"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NetworkConfig } from "@/config/networks";
import { formatAmount } from "@/lib/amount";
import { recentActivity, type ActivityItem } from "@/lib/balance";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { usePoolSnapshot } from "@/components/pool-hooks";
import { usePaymentScan } from "@/components/scan-hooks";
import { useSelectedNetwork } from "@/components/Providers";
import { ExplorerLink, LoadingRows, Mono, Spinner, formatDateTime, shorten } from "@/components/ui";
import { useVault } from "@/components/VaultProvider";
import { VaultGate, WalletGate } from "@/components/WalletGate";

export function ActivityFlow() {
  const { network } = useSelectedNetwork();
  return (
    <div className="mx-auto max-w-xl px-4 pt-6 sm:px-6">
      <h1 className="mb-6 font-display text-[2rem] font-bold leading-[1.08] tracking-[-0.03em] text-snow sm:text-[2.6rem]">Activity</h1>
      <WalletGate network={network} purpose="Connect the wallet you use with QuietPay. Its signature unlocks your keys on this device.">
        <VaultGate>
          <Activity network={network} />
        </VaultGate>
      </WalletGate>
    </div>
  );
}

const LABEL: Record<ActivityItem["kind"], string> = {
  "pool-received": "Received",
  "pool-deposit": "Moved into your shielded balance",
  "pool-withdrawal": "Sent",
  "link-payment": "Received at a one-time address",
  sent: "Sent from a one-time address",
};

function Activity({ network }: { network: NetworkConfig }) {
  const { vault } = useVault();
  const readiness = useNetworkReadiness(network);
  const snap = usePoolSnapshot(network);
  const client = usePublicClient(network);
  const scan = usePaymentScan(network);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current || !scan.ready) return;
    ran.current = true;
    void scan.scan(false);
  }, [scan]);

  const notes = useMemo(() => snap.data?.notes ?? [], [snap.data]);
  const blocks = useMemo(() => {
    const all = new Set<bigint>();
    for (const n of notes) {
      all.add(n.deposit.blockNumber);
      for (const w of n.history) all.add(w.blockNumber);
    }
    return [...all].sort((a, b) => (a > b ? -1 : 1)).slice(0, 60);
  }, [notes]);
  const times = useQuery({
    queryKey: ["block-times", network.key, blocks.map(String).join(",")],
    enabled: blocks.length > 0,
    staleTime: Infinity,
    queryFn: async () => {
      const out: Record<string, number> = {};
      for (let i = 0; i < blocks.length; i += 10)
        await Promise.all(
          blocks.slice(i, i + 10).map(async (b) => {
            const blk = await client.getBlock({ blockNumber: b }).catch(() => null);
            if (blk) out[b.toString()] = Number(blk.timestamp) * 1000;
          }),
        );
      return out;
    },
  });
  const items = useMemo(
    () => recentActivity(notes, vault?.requests ?? [], network.chain.id, (b) => times.data?.[b.toString()], { poolEntrypoint: network.pool?.entrypoint ?? null, limit: 200 }),
    [notes, vault, network, times.data],
  );
  const token = readiness.data?.token;
  const fmt = (v: bigint) => `${formatAmount(v, token?.decimals ?? 6, { group: true })} ${token?.symbol ?? "tUSDG"}`;

  if (snap.isLoading || readiness.isLoading) return <LoadingRows label="Reading your history" rows={4} />;
  return (
    <div className="space-y-4">
      {scan.scanning && (
        <p className="flex items-center gap-2 text-xs text-haze" aria-live="polite">
          <Spinner className="h-3 w-3" /> Checking for new payments
        </p>
      )}
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-harbor px-5 py-10 text-center text-sm text-haze">
          Nothing yet.{" "}
          <Link href="/receive" className="text-signal underline underline-offset-4">
            Receive
          </Link>{" "}
          your first payment.
        </div>
      ) : (
        <ul className="divide-y divide-harbor/60 rounded-[1.25rem] border border-harbor bg-deep">
          {items.map((a) => {
            const incoming = a.kind === "pool-received" || a.kind === "link-payment";
            const outgoing = a.kind === "pool-withdrawal" || a.kind === "sent";
            return (
              <li key={`${a.kind}:${a.tx}`} className="flex items-center justify-between gap-4 px-4 py-3.5 text-sm">
                <div className="min-w-0">
                  <p className="text-snow">{LABEL[a.kind]}</p>
                  <p className="mt-0.5 text-xs text-haze">
                    {a.time !== undefined ? formatDateTime(a.time) : "Recently"}
                    {a.kind === "sent" && (
                      <>
                        {" "}
                        · to <Mono>{shorten(a.to, 4)}</Mono>
                      </>
                    )}{" "}
                    · <ExplorerLink network={network} tx={a.tx}>details</ExplorerLink>
                  </p>
                </div>
                <p className={`shrink-0 font-display font-semibold ${incoming ? "text-ok" : "text-snow"}`}>
                  {incoming ? "+" : outgoing ? "−" : ""}
                  {fmt(a.amount)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
