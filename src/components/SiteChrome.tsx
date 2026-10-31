"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useDisconnect } from "wagmi";
import { enabledNetworks, type NetworkKey } from "@/config/networks";
import { Wordmark } from "./Logo";
import { useSelectedNetwork } from "./Providers";
import { Mono, shorten } from "./ui";

const NAV = [
  { href: "/create", label: "Create" },
  { href: "/pay", label: "Pay" },
  { href: "/receive", label: "Receive" },
];

export function NetworkIndicator() {
  const { network, setNetwork } = useSelectedNetwork();
  const nets = enabledNetworks();
  const dot = network.chain.testnet ? "bg-warn" : "bg-ok";
  if (nets.length < 2) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-mist/25 px-3 py-1 text-xs text-mist" title={`Chain ID ${network.chain.id}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
        {network.label}
      </span>
    );
  }
  return (
    <label className="inline-flex items-center gap-2 rounded-full border border-mist/25 px-3 py-1 text-xs text-mist">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      <span className="sr-only">Network</span>
      <select className="bg-transparent text-mist outline-none" value={network.key} onChange={(e) => setNetwork(e.target.value as NetworkKey)}>
        {nets.map((n) => (
          <option key={n.key} value={n.key} className="bg-abyss">
            {n.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SiteHeader() {
  const path = usePathname();
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  return (
    <header className="relative z-20">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-5 sm:px-6">
        <Link href="/" aria-label="QuietPay home">
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="order-3 flex w-full gap-6 sm:order-none sm:w-auto sm:gap-10">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`font-display text-[0.8rem] font-semibold uppercase tracking-[0.12em] transition-colors ${
                path?.startsWith(n.href) ? "text-snow underline decoration-signal decoration-2 underline-offset-[10px]" : "text-mist/80 hover:text-snow"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <NetworkIndicator />
          {address && (
            <button type="button" onClick={() => disconnect()} className="btn btn-sm btn-quiet normal-case tracking-normal" title="Disconnect wallet">
              <Mono>{shorten(address)}</Mono>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const { network } = useSelectedNetwork();
  return (
    <footer className="relative z-10 mt-24 border-t border-mist/15">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 text-sm sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div className="space-y-3">
          <Wordmark />
          <p className="max-w-[34ch] text-haze">One-time USDG payment links with a fresh receiving address for every payment.</p>
        </div>
        <FooterCol title="Use QuietPay" links={NAV.map((n) => ({ href: n.href, label: n.label === "Pay" ? "Pay a link" : n.label === "Create" ? "Create a link" : "Receive and claim" }))} />
        <FooterCol
          title="Network"
          links={[
            { href: network.explorerUrl, label: `${network.label} explorer`, external: true },
            ...(network.chain.testnet ? [{ href: "https://faucet.testnet.chain.robinhood.com", label: "Testnet ETH faucet", external: true }] : []),
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
      <p className="border-t border-mist/10 px-4 py-5 text-center text-xs text-haze">
        QuietPay is experimental software. It provides recipient address unlinkability, not anonymity.
      </p>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: { href: string; label: string; external?: boolean }[] }) {
  return (
    <div>
      <h2 className="mb-3 font-display text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-snow">{title}</h2>
      <ul className="space-y-2">
        {links.map((l) => (
          <li key={l.href}>
            {l.external ? (
              <a href={l.href} target="_blank" rel="noopener noreferrer" className="text-mist/85 underline decoration-mist/30 underline-offset-4 hover:text-snow">
                {l.label}
              </a>
            ) : (
              <Link href={l.href} className="text-mist/85 underline decoration-mist/30 underline-offset-4 hover:text-snow">
                {l.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
