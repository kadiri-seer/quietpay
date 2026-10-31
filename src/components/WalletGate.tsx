"use client";

import type { ReactNode } from "react";
import { useAccount, useConnect, useSwitchChain } from "wagmi";
import type { NetworkConfig } from "@/config/networks";
import { classifyTxError } from "@/lib/tx-errors";
import { Notice, Spinner } from "./ui";
import { useVault } from "./VaultProvider";

/** Renders children only when a wallet is connected on `network`. */
export function WalletGate({ network, children, purpose }: { network: NetworkConfig; children: ReactNode; purpose: string }) {
  const { isConnected, chainId, isConnecting, isReconnecting } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const injected = connectors[0];

  if (!isConnected) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-haze">{purpose}</p>
        <button
          type="button"
          className="btn btn-primary w-full sm:w-auto"
          disabled={isPending || isConnecting || isReconnecting || !injected}
          onClick={() => injected && connect({ connector: injected, chainId: network.chain.id })}
        >
          {isPending ? <Spinner /> : null} Connect wallet
        </button>
        {!injected && <Notice tone="warn">No browser wallet found. Install a wallet extension such as MetaMask or Rabby.</Notice>}
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
