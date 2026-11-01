"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Connector } from "wagmi";
import { useAccount, useConnect, useSwitchChain } from "wagmi";
import type { NetworkConfig } from "@/config/networks";
import { classifyTxError } from "@/lib/tx-errors";
import { Notice, Spinner } from "./ui";
import { useVault } from "./VaultProvider";

/** Renders children only when a wallet is connected on `network`. */
export function WalletGate({ network, children, purpose }: { network: NetworkConfig; children: ReactNode; purpose: string }) {
  const { isConnected, chainId, isReconnecting } = useAccount();
  const { connectors, connect, isPending, error, reset } = useConnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const [hasInjected, setHasInjected] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => setHasInjected(typeof window !== "undefined" && !!(window as { ethereum?: unknown }).ethereum), []);
  // If a wallet never answers, say so after a while and let the user cancel instead of waiting forever.
  useEffect(() => {
    setSlow(false);
    if (!isPending) return;
    const t = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(t);
  }, [isPending]);

  // Wallet extensions announced via EIP-6963 (MetaMask, Rabby, Coinbase…) appear by name.
  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const generic = connectors.find((c) => c.id === "injected");
  const wc = connectors.find((c) => c.type === "walletConnect");
  const options: { connector: Connector; label: string; hint: string; icon?: string }[] = [
    ...announced.map((c) => ({ connector: c, label: c.name, hint: "Browser extension", icon: c.icon })),
    ...(announced.length === 0 && hasInjected && generic ? [{ connector: generic, label: "Browser wallet", hint: "Extension or in-app browser" }] : []),
    ...(wc ? [{ connector: wc, label: "WalletConnect", hint: "Mobile wallets: scan a QR code or open your wallet app", icon: "/brand/walletconnect.svg" }] : []),
  ];

  if (!isConnected) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-haze">{purpose}</p>
        {options.length > 0 ? (
          <ul className="grid gap-2">
            {options.map((o, i) => (
              <li key={o.connector.uid}>
                <button
                  type="button"
                  className={`group flex w-full items-center gap-4 rounded-lg border px-4 py-3 text-left disabled:opacity-50 ${
                    i === 0 ? "border-snow/80 hover:bg-snow/10" : "border-harbor hover:border-mist/60"
                  }`}
                  disabled={isPending || isReconnecting}
                  onClick={() => {
                    setPendingId(o.connector.uid);
                    connect({ connector: o.connector });
                  }}
                >
                  {o.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={o.icon} alt="" className={`h-7 w-7 shrink-0 ${o.connector.type === "walletConnect" ? "rounded-full" : "rounded"}`} />
                  ) : (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-mist/30 text-xs text-mist" aria-hidden>
                      ◆
                    </span>
                  )}
                  <span className="flex-1">
                    <span className="block font-medium text-snow">{o.label}</span>
                    <span className="block text-xs text-haze">{o.hint}</span>
                  </span>
                  {isPending && pendingId === o.connector.uid ? <Spinner /> : <span className="text-haze group-hover:text-snow" aria-hidden>›</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Notice tone="warn" title="No wallet found">
            Install a wallet extension such as MetaMask, or open this page inside your wallet app&apos;s built-in browser.
          </Notice>
        )}
        {!wc && !hasInjected && (
          <p className="text-xs text-haze">On a phone, open this page in the MetaMask or Trust Wallet app&apos;s browser.</p>
        )}
        {isPending && (
          <div className="flex flex-wrap items-center gap-3">
            {slow && <p className="text-sm text-haze">Still waiting for your wallet. Check the wallet app, or cancel and try again.</p>}
            <button
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={() => {
                reset();
                setPendingId(null);
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {error && <Notice tone="bad">{classifyTxError(error).message}</Notice>}
      </div>
    );
  }

  if (chainId !== network.chain.id) {
    return (
      <div className="space-y-4">
        <Notice tone="warn" title="Wrong network">
          Your wallet is on another network. Switch to {network.label} (chain ID {network.chain.id}) to continue.
        </Notice>
        <button type="button" className="btn btn-primary" disabled={switching} onClick={() => switchChain({ chainId: network.chain.id })}>
          {switching ? <Spinner /> : null} Switch to {network.label}
        </button>
        {switchError && <Notice tone="bad">{classifyTxError(switchError).message}</Notice>}
      </div>
    );
  }

  return <>{children}</>;
}

/** Renders children only when the encrypted key vault is unlocked. */
export function VaultGate({ children }: { children: ReactNode }) {
  const { status, unlock, error, isNew } = useVault();
  if (status === "unlocked") return <>{children}</>;
  return (
    <div className="space-y-4">
      <div className="space-y-2 text-sm leading-relaxed text-haze">
        <p className="text-snow">{isNew ? "Set up your key vault" : "Unlock your key vault"}</p>
        <p>
          QuietPay keeps each link&apos;s receiving keys encrypted in this browser. Your wallet signs a message to derive the encryption
          key. It is not a transaction and costs nothing.
          {isNew && " Your wallet will ask twice the first time, to confirm it signs consistently."}
        </p>
      </div>
      <button type="button" className="btn btn-primary" disabled={status === "unlocking" || status === "unavailable"} onClick={unlock}>
        {status === "unlocking" ? <Spinner /> : null} {isNew ? "Sign to set up vault" : "Sign to unlock"}
      </button>
      {error && <Notice tone="bad">{error}</Notice>}
      {status === "unavailable" && <Notice tone="bad">This browser blocks local storage. Allow site data for QuietPay to keep payment keys.</Notice>}
    </div>
  );
}
