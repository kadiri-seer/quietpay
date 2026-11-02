"use client";

import Link from "next/link";
import { useSelectedNetwork } from "@/components/Providers";
import { ETH_FAUCET_URL } from "@/components/SiteChrome";

/** Test money links, shown just below the main button on testnet. */
export function HeroFaucet() {
  const { network } = useSelectedNetwork();
  if (!network.chain.testnet) return null;
  const link = "inline-flex min-h-11 items-center font-medium text-snow underline decoration-snow/30 underline-offset-4 hover:decoration-snow";
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-4 text-sm text-haze">
      <span>Need test money?</span>
      <a href={ETH_FAUCET_URL} target="_blank" rel="noopener noreferrer" className={link}>
        Get test ETH<span aria-hidden>&nbsp;↗</span>
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      <Link href="/faucet" className={link}>
        Get test {network.expectedSymbol}
      </Link>
    </p>
  );
}

export function HeroNetwork() {
  const { network } = useSelectedNetwork();
  return (
    <p className="mt-5 flex max-w-[40ch] items-baseline gap-2 text-balance text-sm text-mist/80">
      <span className={`h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full ${network.chain.testnet ? "bg-warn" : "bg-ok"}`} aria-hidden />
      {network.label}
      {network.chain.testnet ? ", using a test token with no value" : ""}
    </p>
  );
}
