"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkConfig } from "@/config/networks";
import { formatAmount } from "@/lib/amount";
import { homeBalance } from "@/lib/balance";
import { classifyTxError } from "@/lib/tx-errors";
import { useNetworkReadiness } from "@/components/hooks";
import { useOnchainHoldings, usePoolInfo, usePoolSnapshot } from "@/components/pool-hooks";
import { usePaymentScan } from "@/components/scan-hooks";
import { useSelectedNetwork } from "@/components/Providers";
import { Notice, Skeleton, Spinner } from "@/components/ui";
import { useVault } from "@/components/VaultProvider";
import { VaultGate, WalletGate } from "@/components/WalletGate";

const HIDE_KEY = "quietpay:hide-balance";

/**
 * The app part of the front page: your balance and actions. Shown to people who use QuietPay on
 * this device (or who tapped "Get started"); everyone else sees the landing hero instead.
 */
export function HomeApp() {
  const { network } = useSelectedNetwork();
  const { status } = useVault();
  useEffect(() => {
    // "Get started" links here with ?app=1; keep the hero hidden from now on.
    if (new URLSearchParams(window.location.search).get("app") === "1") {
      document.documentElement.dataset.app = "1";
      try {
        localStorage.setItem(APP_HINT, "1");
      } catch {
        /* storage blocked */
      }
    }
  }, []);
  useEffect(() => {
    if (status !== "unlocked") return;
    document.documentElement.dataset.app = "1";
    try {
      localStorage.setItem(APP_HINT, "1");
    } catch {
      /* storage blocked */
    }
  }, [status]);
  return status === "unlocked" ? (
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
  );
}

/** Set once someone has used QuietPay on this device: the front page then opens on their balance. */
export const APP_HINT = "quietpay:app";

/**
 * One balance: everything QuietPay holds for you. Mostly the shielded pool (payments go in and are
 * approved there, in seconds on testnet, so money awaiting approval counts), plus anything still
 * at one-time addresses or returned to a refund address, read from the chain. On open, Home looks
 * for new link payments, so the total is current. Worked out on this device.
 */
function Home({ network }: { network: NetworkConfig }) {
  const { vault } = useVault();
  const readiness = useNetworkReadiness(network);
  const snap = usePoolSnapshot(network);
  const info = usePoolInfo(network);
  const holdings = useOnchainHoldings(network, snap.data?.notes, info.data?.scope);
  const payments = usePaymentScan(network);
  // Look for new payments to your links each time Home opens (only blocks not checked yet).
  const scanned = useRef(false);
  useEffect(() => {
    if (scanned.current || !payments.ready) return;
    scanned.current = true;
    void payments.scan(false).then(() => {
      void snap.refetch();
    });
  }, [payments, snap]);
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

  const balance = useMemo(
    () => homeBalance(snap.data?.notes ?? [], vault?.requests ?? [], network.chain.id, holdings.data ?? null),
    [snap.data, vault, network.chain.id, holdings.data],
  );
  const poolBalance = balance.pool.ready + balance.pool.waiting;
  const loading = (!!network.pool && snap.isLoading) || readiness.isLoading || holdings.isLoading;
  const [whole, frac] = formatAmount(balance.total, decimals, { group: true, minFraction: 2 }).split(".");
  const f = (v: bigint) => formatAmount(v, decimals, { group: true });
  const parts = [
    poolBalance > 0n || (balance.oneTime === 0n && balance.refunds === 0n) ? `${f(poolBalance)} in the shielded pool` : "",
    balance.oneTime > 0n ? `${f(balance.oneTime)} at one-time addresses` : "",
    balance.refunds > 0n ? `${f(balance.refunds)} at refund addresses` : "",
  ].filter(Boolean);

  return (
    <div className="space-y-5">
      <section
        aria-labelledby="balance-h"
        className="relative overflow-hidden rounded-[1.75rem] border border-harbor bg-deep p-6 sm:p-7"
        style={{ backgroundImage: "linear-gradient(to top, color-mix(in oklab, var(--color-ok) 22%, transparent), transparent 70%)" }}
      >
        <div className="flex items-center gap-2">
          <h2 id="balance-h" className="text-[0.95rem] text-haze">
            Total balance
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
        <p className="mt-3 text-sm text-haze">
          {hidden ? "Hidden" : parts.join(" · ")}
          {mock ? " · test token, no value" : ""}
        </p>
        {payments.scanning && (
          <p className="mt-2 flex items-center gap-2 text-xs text-haze" aria-live="polite">
            <Spinner className="h-3 w-3" /> Checking for new payments
          </p>
        )}
      </section>

      <nav aria-label="Actions" className="grid grid-cols-3 gap-3">
        <Action href="/receive" label="Receive" icon={<ArrowIcon down />} />
        <Action href="/send" label="Send" icon={<ArrowIcon />} />
        <Action href="/scan" label="Scan" icon={<ScanIcon />} />
      </nav>

      {/* Only shown when something needs attention. */}
      {balance.oneTime > 0n && (
        <Notice tone="warn">
          {f(balance.oneTime)} {symbol} is at one-time addresses, outside the pool.{" "}
          <Link href="/receive" className="underline underline-offset-4">
            Move it into the pool
          </Link>{" "}
          to keep it private.
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
              {loading ? <Skeleton className="h-6 w-20" /> : hidden ? "••••" : formatAmount(balance.total, decimals, { group: true })}
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

function ScanIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M7 12h10" />
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

/** The landing page's "Get started": switches the front page to the app on this device. */
export function GetStarted({ className }: { className?: string }) {
  return (
    <a
      href="/?app=1"
      className={className}
      onClick={(e) => {
        e.preventDefault();
        try {
          localStorage.setItem(APP_HINT, "1");
        } catch {
          /* storage blocked: the page still switches for this visit */
        }
        document.documentElement.dataset.app = "1";
        window.history.replaceState(null, "", "/?app=1");
        window.scrollTo({ top: 0 });
      }}
    >
      Get started
    </a>
  );
}
