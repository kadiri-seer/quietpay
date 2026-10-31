"use client";

import { useSelectedNetwork } from "@/components/Providers";

export function HeroNetwork() {
  const { network } = useSelectedNetwork();
  return (
    <p className="mt-5 flex items-center gap-2 text-sm text-mist/80">
      <span className={`h-1.5 w-1.5 rounded-full ${network.chain.testnet ? "bg-warn" : "bg-ok"}`} aria-hidden />
      {network.label}
      {network.chain.testnet ? ", using a test token with no value" : ""}
    </p>
  );
}
