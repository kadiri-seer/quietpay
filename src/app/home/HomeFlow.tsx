"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NetworkConfig } from "@/config/networks";
import { formatAmount } from "@/lib/amount";
import { homeBalance, recentActivity, type ActivityItem } from "@/lib/balance";
import { classifyTxError } from "@/lib/tx-errors";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { usePoolSnapshot } from "@/components/pool-hooks";
import { useSelectedNetwork } from "@/components/Providers";
import { ExplorerLink, LoadingRows, Mono, Notice, PageTitle, Skeleton, Spinner, formatDateTime, shorten } from "@/components/ui";
import { useVault } from "@/components/VaultProvider";
import { VaultGate, WalletGate } from "@/components/WalletGate";

export function HomeFlow() {
  const { network } = useSelectedNetwork();
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
      <PageTitle light="Your" bold="balance">
        Everything QuietPay holds for you, in one place. Your device works it out from your keys and public chain data; no server keeps
        your balance.
      </PageTitle>
      <div className="panel p-5 sm:p-7">
        <WalletGate network={network} purpose="Connect the wallet you use with QuietPay. Its signature unlocks your keys on this device.">
          <VaultGate>
            <Home network={network} />
          </VaultGate>
        </WalletGate>
      </div>
    </div>
  );
}

function Home({ network }: { network: NetworkConfig }) {
  const { vault } = useVault();
  const readiness = useNetworkReadiness(network);
  const snap = usePoolSnapshot(network);
  const client = usePublicClient(network);
  const token = readiness.data?.token;
  const decimals = token?.decimals ?? 6;
  const symbol = token?.symbol ?? "tUSDG";
  const fmt = (v: bigint) => formatAmount(v, decimals, { group: true });

  const requests = useMemo(() => vault?.requests ?? [], [vault]);
  const notes = useMemo(() => snap.data?.notes ?? [], [snap.data]);
  const balance = useMemo(() => homeBalance(notes, requests, network.chain.id), [notes, requests, network.chain.id]);

  // Times for the most recent pool events (they only carry block numbers).
  const blocks = useMemo(() => {
    const all = new Set<bigint>();
    for (const n of notes) {
      all.add(n.deposit.blockNumber);
      for (const w of n.history) all.add(w.blockNumber);
    }
    return [...all].sort((a, b) => (a > b ? -1 : 1)).slice(0, 12);
  }, [notes]);
  const times = useQuery({
    queryKey: ["block-times", network.key, blocks.map(String).join(",")],
    enabled: blocks.length > 0,
    staleTime: Infinity,
    queryFn: async () => {
      const out: Record<string, number> = {};
      await Promise.all(
        blocks.map(async (b) => {
          const blk = await client.getBlock({ blockNumber: b }).catch(() => null);
          if (blk) out[b.toString()] = Number(blk.timestamp) * 1000;
        }),
      );
      return out;
    },
  });
  const activity = useMemo(
    () => recentActivity(notes, requests, network.chain.id, (b) => times.data?.[b.toString()], { poolEntrypoint: network.pool?.entrypoint ?? null }),
    [notes, requests, network, times.data],
  );

  const poolLoading = !!network.pool && snap.isLoading;
  if (readiness.isLoading) return <LoadingRows label={`Checking ${network.label} contracts`} rows={4} />;

  return (
    <div className="space-y-8">
      <section aria-labelledby="total-h" className="text-center sm:text-left">
        <h2 id="total-h" className="text-sm text-haze">
          Total balance
        </h2>
        <p className="mt-1 font-display text-[2.6rem] font-semibold leading-none tracking-[-0.03em] text-snow sm:text-5xl" aria-live="polite">
          {poolLoading ? (
            <Skeleton className="mx-auto h-12 w-52 sm:mx-0" />
          ) : (
            <>
              {fmt(balance.total)} <span className="text-xl text-haze sm:text-2xl">{symbol}</span>
            </>
          )}
        </p>
        {token?.isMock && <p className="mt-2 text-xs text-haze">{symbol} is a test token with no value.</p>}
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        <Tile
          title="In the pool, ready"
          value={poolLoading ? null : `${fmt(balance.pool.ready)} ${symbol}`}
          hint="Withdraw or send privately."
          href="/pool"
          action="Withdraw"
        />
        <Tile
          title="In the pool, awaiting approval"
          value={poolLoading ? null : `${fmt(balance.pool.waiting)} ${symbol}`}
          hint={network.chain.testnet ? "Approved automatically, usually within seconds." : "Checked against the sanctions list, then approved."}
          href="/pool"
          action="View"
        />
        <Tile
          title="At one-time addresses"
          value={`${fmt(balance.oneTime)} ${symbol}`}
          hint={balance.oneTimeCount ? `${balance.oneTimeCount} payment${balance.oneTimeCount === 1 ? "" : "s"} you can move.` : "Payments to reusable or small links."}
          href="/receive"
          action="Move"
        />
      </div>

      {balance.pool.notApproved > 0n && (
        <Notice tone="warn" title="Not approved">
          {fmt(balance.pool.notApproved)} {symbol} didn&apos;t pass the pool&apos;s screening, so it isn&apos;t counted above. It can only go
          back where it came from, from the{" "}
          <Link href="/pool" className="underline underline-offset-4">
            Pool page
          </Link>
          .
        </Notice>
      )}
      {snap.error && <Notice tone="bad">{classifyTxError(snap.error).message}</Notice>}
      {!network.pool && (
        <Notice tone="info">The shielded pool isn&apos;t available on {network.label}, so payments arrive at one-time addresses.</Notice>
      )}

      <div className="flex flex-wrap gap-2">
        <Link href="/create" className="btn btn-primary">
          Get paid
        </Link>
        <Link href="/pool" className="btn">
          Send from pool
        </Link>
        <Link href="/pay" className="btn btn-quiet">
          Pay a link
        </Link>
      </div>

      <section aria-labelledby="activity-h" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="activity-h" className="font-display text-lg font-semibold tracking-[-0.01em] text-snow">
            Recent activity
          </h2>
          {snap.isFetching && !snap.isLoading && (
            <span className="flex items-center gap-2 text-xs text-haze">
              <Spinner className="h-3 w-3" /> Updating
            </span>
          )}
        </div>
        {poolLoading ? (
          <LoadingRows label="Reading pool history" rows={3} />
        ) : activity.length === 0 ? (
          <div className="rounded-xl border border-dashed border-harbor px-5 py-8 text-center text-sm text-haze">
            Nothing yet.{" "}
            <Link href="/create" className="text-signal underline underline-offset-4">
              Create a payment link
            </Link>{" "}
            to get paid.
          </div>
        ) : (
          <ul className="divide-y divide-harbor/60 rounded-xl border border-harbor">
            {activity.map((a) => (
              <ActivityRow key={`${a.kind}:${a.tx}`} item={a} network={network} fmt={(v) => `${fmt(v)} ${symbol}`} />
            ))}
          </ul>
        )}
        <p className="text-xs leading-relaxed text-haze">
          Pool payments show up on their own. Payments to one-time addresses appear after a scan on the{" "}
          <Link href="/receive" className="underline underline-offset-4 hover:text-snow">
            Receive page
          </Link>
          .
        </p>
      </section>
    </div>
  );
}

function Tile({ title, value, hint, href, action }: { title: string; value: string | null; hint: string; href: string; action: string }) {
  return (
    <div className="flex flex-col rounded-xl border border-harbor p-4">
      <p className="text-xs uppercase tracking-[0.12em] text-haze">{title}</p>
      <p className="mt-1 font-display text-xl font-semibold tracking-[-0.02em] text-snow">{value ?? <Skeleton className="h-7 w-28" />}</p>
      <p className="mt-1 flex-1 text-xs leading-relaxed text-haze">{hint}</p>
      <Link href={href} className="mt-3 self-start text-sm text-signal underline underline-offset-4">
        {action}
      </Link>
    </div>
  );
}

const LABEL: Record<ActivityItem["kind"], string> = {
  "pool-received": "Received into the pool",
  "pool-deposit": "Moved into the pool",
  "pool-withdrawal": "Withdrawn from the pool",
  "link-payment": "Received at a one-time address",
  sent: "Sent from a one-time address",
};

function ActivityRow({ item, network, fmt }: { item: ActivityItem & { time: number | undefined }; network: NetworkConfig; fmt: (v: bigint) => string }) {
  const incoming = item.kind === "pool-received" || item.kind === "link-payment";
  const outgoing = item.kind === "pool-withdrawal" || item.kind === "sent";
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
      <div className="min-w-0">
        <p className="text-snow">{LABEL[item.kind]}</p>
        <p className="mt-0.5 text-xs text-haze">
          {item.time !== undefined ? formatDateTime(item.time) : "Recently"}
          {item.kind === "sent" && (
            <>
              {" "}
              · to <Mono>{shorten(item.to, 4)}</Mono>
            </>
          )}{" "}
          · <ExplorerLink network={network} tx={item.tx} />
        </p>
      </div>
      <p className={`font-display font-semibold tracking-[-0.01em] ${incoming ? "text-ok" : "text-snow"}`}>
        {incoming ? "+" : outgoing ? "−" : ""}
        {fmt(item.amount)}
      </p>
    </li>
  );
}
