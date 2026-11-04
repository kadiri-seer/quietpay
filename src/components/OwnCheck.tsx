"use client";

/**
 * Before paying a link or a username: if this browser holds QuietPay keys for the connected
 * wallet but they're locked, unlock them first, so QuietPay can tell when you're about to pay
 * yourself. People who don't use QuietPay here go straight on.
 */
import { useMemo, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { browserStore, hasVault } from "@/lib/vault";
import { useVault } from "./VaultProvider";
import { VaultGate } from "./WalletGate";

export function OwnCheck({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const { status } = useVault();
  const holdsKeys = useMemo(() => {
    const store = browserStore();
    return !!address && !!store && hasVault(store, address);
  }, [address]);
  if (!holdsKeys || status === "unlocked") return <>{children}</>;
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-haze">You use QuietPay in this browser. Unlock first, so QuietPay can check this isn&apos;t your own link.</p>
      <VaultGate>{children}</VaultGate>
    </div>
  );
}
