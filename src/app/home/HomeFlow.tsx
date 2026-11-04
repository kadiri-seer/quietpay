"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { NetworkConfig } from "@/config/networks";
import { formatAmount } from "@/lib/amount";
import { homeBalance } from "@/lib/balance";
import { classifyTxError } from "@/lib/tx-errors";
import { useNetworkReadiness } from "@/components/hooks";
import { usePoolSnapshot } from "@/components/pool-hooks";
import { useSelectedNetwork } from "@/components/Providers";
import { Notice, Skeleton } from "@/components/ui";
import { useVault } from "@/components/VaultProvider";
import { VaultGate, WalletGate } from "@/components/WalletGate";

const HIDE_KEY = "quietpay:hide-balance";

export function HomeFlow() {
  const { network } = useSelectedNetwork();
  const { status } = useVault();
  return (
    <div className="mx-auto max-w-xl px-4 pt-6 sm:px-6">
      <h1 className="mb-6 font-display text-[2rem] font-bold leading-[1.08] tracking-[-0.03em] text-snow sm:text-[2.6rem]">Home</h1>
      {status === "unlocked" ? (
        <WalletGate network={network} purpose="Connect the wallet you use with QuietPay.">
          <VaultGate>
            <Home network={network} />
          </VaultGate>
        </WalletGate>
      ) : (
        <div className="panel p-5 sm:p-7">
          <WalletGate network={network} purpose="Connect the wallet you use with QuietPay. Its signature unlocks your keys on this device.">
            <VaultGate>
              <Home network={network} />
            </VaultGate>
          </WalletGate>
        </div>
      )}
    </div>
  );
}

/**
 * One balance: what you hold in the shielded pool. Payments go into the pool and are approved
 * there (in seconds on testnet), so money awaiting approval is part of it. Worked out on this
 * device from your keys and public pool history.
 */
function Home({ network }: { network: NetworkConfig }) {
  const { vault } = useVault();
  const readiness = useNetworkReadiness(network);
  const snap = usePoolSnapshot(network);
  const token = readiness.data?.token;
  const decimals = token?.decimals ?? 6;
  const symbol = token?.symbol ?? "tUSDG";
  const mock = token?.isMock ?? network.chain.testnet;

  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(HIDE_KEY) === "1");
    } catch {
      /* storage blocked: shown by default */
    }
  }, []);
  const toggleHidden = () => {
    setHidden((h) => {
      try {
        localStorage.setItem(HIDE_KEY, h ? "0" : "1");
      } catch {
        /* storage blocked */
      }
      return !h;
    });
  };

  const balance = useMemo(() => homeBalance(snap.data?.notes ?? [], vault?.requests ?? [], network.chain.id), [snap.data, vault, network.chain.id]);
  const poolBalance = balance.pool.ready + balance.pool.waiting;
  const loading = !!network.pool && (snap.isLoading || readiness.isLoading);
  const [whole, frac] = formatAmount(poolBalance, decimals, { group: true, minFraction: 2 }).split(".");

  return (
    <div className="space-y-5">
      <section
        aria-labelledby="balance-h"
        className="relative overflow-hidden rounded-[1.75rem] border border-harbor bg-deep p-6 sm:p-7"
        style={{ backgroundImage: "linear-gradient(to top, color-mix(in oklab, var(--color-ok) 22%, transparent), transparent 70%)" }}
      >
        <div className="flex items-center gap-2">
          <h2 id="balance-h" className="text-[0.95rem] text-haze">
            Shielded balance
          </h2>
          <button
            type="button"
            onClick={toggleHidden}
            className="-m-2 inline-flex h-9 w-9 items-center justify-center rounded-full text-haze hover:text-snow"
            aria-label={hidden ? "Show balance" : "Hide balance"}
            aria-pressed={hidden}
          >
            <EyeIcon off={hidden} />
          </button>
        </div>
        <p className="mt-2 font-display font-semibold leading-none tracking-[-0.03em] text-snow" aria-live="polite">
          {loading ? (
            <Skeleton className="h-12 w-48" />
          ) : hidden ? (
            <span className="text-5xl">••••••</span>
          ) : (
            <>
              {!mock && <span className="text-5xl text-haze">$</span>}
              <span className="text-5xl sm:text-[3.4rem]">{whole}</span>
              {frac && <span className="text-3xl text-haze">.{frac}</span>}
              <span className="ml-2 text-lg text-haze">{symbol}</span>
            </>
          )}
        </p>
        <p className="mt-3 text-sm text-haze">In the shielded pool{mock ? " · test token, no value" : ""}</p>
      </section>

      <nav aria-label="Actions" className="grid grid-cols-3 gap-3">
        <Action href="/create" label="Receive" icon={<ArrowIcon down />} />
        <Action href="/pool" label="Send" icon={<ArrowIcon />} />
        <Action href="/pay" label="Pay a link" icon={<LinkIcon />} />
      </nav>

      {/* Only shown when something needs attention. */}
      {balance.oneTime > 0n && (
        <Notice tone="warn">
          {formatAmount(balance.oneTime, decimals, { group: true })} {symbol} arrived at one-time addresses and isn&apos;t in your balance yet.{" "}
          <Link href="/receive" className="underline underline-offset-4">
            Move it into the pool
          </Link>
          .
        </Notice>
      )}
      {balance.pool.notApproved > 0n && (
        <Notice tone="bad">
          {formatAmount(balance.pool.notApproved, decimals, { group: true })} {symbol} didn&apos;t pass the pool&apos;s screening and isn&apos;t
          in your balance.{" "}
          <Link href="/pool" className="underline underline-offset-4">
            See the Pool page
          </Link>
          .
        </Notice>
      )}
      {snap.error && <Notice tone="bad">{classifyTxError(snap.error).message}</Notice>}
      {!network.pool && <Notice tone="warn">The shielded pool isn&apos;t available on {network.label}.</Notice>}

      <section aria-labelledby="assets-h" className="space-y-3 pt-3">
        <h2 id="assets-h" className="font-display text-2xl font-semibold tracking-[-0.02em] text-snow">
          My assets
        </h2>
        <ul className="space-y-3">
          <li className="flex items-center gap-4 rounded-[1.25rem] border border-harbor bg-deep px-4 py-4">
            <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-snow font-display text-xl font-bold text-abyss">
              $
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-lg text-snow">{mock ? "Test USDG" : "USDG"}</p>
              <p className="text-sm text-haze">{symbol}</p>
            </div>
            <p className="text-right font-display text-lg font-semibold text-snow">
              {loading ? <Skeleton className="h-6 w-20" /> : hidden ? "••••" : formatAmount(poolBalance, decimals, { group: true })}
            </p>
          </li>
        </ul>
      </section>
    </div>
  );
}

function Action({ href, label, icon }: { href: string; label: string; icon: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex flex-col items-center gap-2 rounded-[1.25rem] border border-harbor bg-deep px-2 py-4 text-snow transition-colors hover:border-mist/60"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-snow text-abyss">{icon}</span>
      <span className="text-[0.95rem] font-medium">{label}</span>
    </Link>
  );
}

function ArrowIcon({ down }: { down?: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {down ? <path d="M12 5v14M6 13l6 6 6-6" /> : <path d="M12 19V5M6 11l6-6 6 6" />}
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}
