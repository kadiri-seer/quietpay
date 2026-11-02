"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { enabledNetworks, type NetworkKey } from "@/config/networks";
import { Wordmark } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { useSelectedNetwork } from "./Providers";
import { Mono, shorten } from "./ui";

const NAV = [
  { href: "/create", label: "Create" },
  { href: "/pay", label: "Pay" },
  { href: "/receive", label: "Receive" },
  { href: "/pool", label: "Pool" },
  { href: "/security", label: "Security" },
];

/** Header height. */
export const HEADER_HEIGHT = 76;

export const ETH_FAUCET_URL = "https://faucet.testnet.chain.robinhood.com";

export function NetworkIndicator() {
  const { network, setNetwork } = useSelectedNetwork();
  const nets = enabledNetworks();
  const dot = `rounded-full ${network.chain.testnet ? "bg-warn" : "bg-ok"}`;
  const base = "inline-flex min-h-9 items-center gap-2 rounded-lg border border-mist/25 px-3 text-xs text-mist";
  if (nets.length < 2) {
    return (
      <span className={base} title={`Chain ID ${network.chain.id}`}>
        <span className={`h-1.5 w-1.5 ${dot}`} aria-hidden />
        {network.label}
      </span>
    );
  }
  return (
    <label className={base}>
      <span className={`h-1.5 w-1.5 ${dot}`} aria-hidden />
      <span className="sr-only">Network</span>
      <select className="min-h-9 bg-transparent text-mist outline-none" value={network.key} onChange={(e) => setNetwork(e.target.value as NetworkKey)}>
        {nets.map((n) => (
          <option key={n.key} value={n.key} className="bg-abyss">
            {n.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function isActive(path: string | null, href: string) {
  return !!path && (path === href || path.startsWith(`${href}/`));
}

export function SiteHeader() {
  const path = usePathname();
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const menuId = useId();

  // Close the menu on navigation and on Escape.
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="relative z-30">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 sm:px-6" style={{ height: HEADER_HEIGHT }}>
        <Link href="/" aria-label="QuietPay home" className="-m-2 p-2">
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-8 lg:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(path, n.href) ? "page" : undefined}
              className={`-mx-2 inline-flex min-h-11 min-w-11 items-center justify-center px-2 text-[0.875rem] font-medium ${
                isActive(path, n.href) ? "text-snow underline decoration-signal decoration-[1.5px] underline-offset-[10px]" : "text-mist/80 hover:text-snow"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <ThemeToggle />
          <NetworkIndicator />
          {address && (
            <button type="button" onClick={() => disconnect()} className="btn btn-sm btn-quiet normal-case tracking-normal" title="Disconnect wallet">
              <Mono>{shorten(address)}</Mono>
            </button>
          )}
        </div>

        <div className="-mr-2 flex items-center lg:hidden">
          <ThemeToggle />
        <button
          type="button"
          className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-snow"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
        >
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            {open ? <path d="M5 5l12 12M17 5L5 17" /> : <path d="M3 6h16M3 11h16M3 16h16" />}
          </svg>
        </button>
        </div>
      </div>

      {open && (
        <div id={menuId} className="absolute inset-x-0 top-full border-y border-harbor bg-abyss lg:hidden">
          <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-col px-4 py-2 sm:px-6">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive(path, n.href) ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={`flex min-h-12 items-center border-b border-harbor/60 text-base font-medium last:border-b-0 ${
                  isActive(path, n.href) ? "text-snow underline decoration-signal decoration-2 underline-offset-8" : "text-mist/85"
                }`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 border-t border-harbor px-4 py-4 sm:px-6">
            <NetworkIndicator />
            {address && (
              <button type="button" onClick={() => disconnect()} className="btn btn-sm btn-quiet normal-case tracking-normal">
                Disconnect <Mono>{shorten(address)}</Mono>
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

export function SiteFooter() {
  const { network } = useSelectedNetwork();
  const year = new Date().getFullYear();
  return (
    <footer className="relative z-10 mt-24 border-t border-mist/15">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 text-sm sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div className="space-y-3">
          <Link href="/" aria-label="QuietPay home" className="-m-2 inline-block p-2">
            <Wordmark />
          </Link>
          <p className="max-w-[34ch] text-haze">One-time USDG payment links with a fresh receiving address for every payment.</p>
        </div>
        <FooterCol
          title="Use QuietPay"
          links={[
            { href: "/create", label: "Create a link" },
            { href: "/pay", label: "Pay a link" },
            { href: "/receive", label: "Receive and claim" },
            { href: "/pool", label: "Shielded pool" },
          ]}
        />
        <FooterCol
          title="Network"
          links={[
            { href: network.explorerUrl, label: `${network.label} explorer`, external: true },
            ...(network.chain.testnet
              ? [
                  { href: ETH_FAUCET_URL, label: "Testnet ETH faucet", external: true },
                  { href: "/faucet", label: `Test ${network.expectedSymbol}` },
                ]
              : []),
          ]}
        />
        <FooterCol
          title="Trust"
          links={[
            { href: "/security", label: "Security model" },
            { href: "/security#contracts", label: "Contracts" },
            { href: "https://eips.ethereum.org/EIPS/eip-5564", label: "ERC-5564 standard", external: true },
          ]}
        />
      </div>
      <div className="border-t border-mist/10">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-5 text-xs text-haze sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            <span suppressHydrationWarning>© {year}</span> QuietPay. Experimental software that provides recipient address unlinkability, not
            anonymity.
          </p>
          <nav aria-label="Legal" className="flex gap-6">
            <Link href="/terms" className="inline-flex min-h-11 items-center underline decoration-mist/30 underline-offset-4 hover:text-snow">
              Terms of Service
            </Link>
            <Link href="/privacy" className="inline-flex min-h-11 items-center underline decoration-mist/30 underline-offset-4 hover:text-snow">
              Privacy Policy
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: { href: string; label: string; external?: boolean }[] }) {
  const cls = "inline-flex min-h-11 items-center text-mist/85 underline decoration-mist/30 underline-offset-4 hover:text-snow";
  return (
    <div>
      <h2 className="mb-1 text-[0.875rem] font-semibold text-snow">{title}</h2>
      <ul>
        {links.map((l) => (
          <li key={l.href}>
            {l.external ? (
              <a href={l.href} target="_blank" rel="noopener noreferrer" className={cls}>
                {l.label}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <Link href={l.href} className={cls}>
                {l.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
