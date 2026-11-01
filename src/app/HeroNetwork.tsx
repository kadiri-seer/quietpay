"use client";

import { useSelectedNetwork } from "@/components/Providers";

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
