"use client";

/**
 * Holds the unlocked vault in memory. The AES key is non-extractable and never persisted;
 * reloading the page locks the vault again.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useSignMessage } from "wagmi";
import type { Address, Hex } from "viem";
import { buildVaultMessage, deriveVaultKey, DecryptionError } from "@/lib/vault-crypto";
import { browserStore, hasVault, loadVault, saveVault, type VaultData } from "@/lib/vault";
import { classifyTxError } from "@/lib/tx-errors";

type Status = "locked" | "unlocking" | "unlocked" | "unavailable";

interface VaultContextValue {
  status: Status;
  vault: VaultData | null;
  error: string | null;
  isNew: boolean;
  unlock: () => Promise<void>;
  lock: () => void;
  /** Encrypts and persists a new vault state. Resolves only after it is written. */
  save: (next: VaultData) => Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault() {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("VaultContext missing");
  return ctx;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [status, setStatus] = useState<Status>("locked");
  const [vault, setVault] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const keyRef = useRef<{ key: CryptoKey; address: Address } | null>(null);

  // Lock whenever the connected wallet changes.
  useEffect(() => {
    keyRef.current = null;
    setVault(null);
    setError(null);
    setStatus(browserStore() ? "locked" : "unavailable");
    setIsNew(address ? !(browserStore() && hasVault(browserStore()!, address)) : false);
  }, [address]);

  const unlock = useCallback(async () => {
    const store = browserStore();
    if (!store) {
      setStatus("unavailable");
      setError("This browser blocks local storage, so QuietPay cannot keep your payment keys.");
      return;
    }
    if (!address) return;
    setStatus("unlocking");
    setError(null);
    try {
      const message = buildVaultMessage(address);
      const sig = (await signMessageAsync({ message })) as Hex;
      const firstTime = !hasVault(store, address);
      if (firstTime) {
        // The vault key is derived from this signature, so it must be reproducible.
        const again = (await signMessageAsync({ message })) as Hex;
        if (again.toLowerCase() !== sig.toLowerCase()) {
          throw new Error(
            "Your wallet produced two different signatures for the same message, so QuietPay cannot derive a stable encryption key from it. Use a wallet with deterministic signatures (most browser wallets are).",
          );
        }
      }
      const key = await deriveVaultKey(sig, address);
      const data = await loadVault(store, key, address);
      keyRef.current = { key, address };
      setVault(data);
      setIsNew(firstTime);
      setStatus("unlocked");
    } catch (e) {
      setStatus("locked");
      if (e instanceof DecryptionError) {
        setError("The signature did not unlock this browser's vault. If your wallet changed how it signs, restore from your backup file.");
      } else {
        const c = classifyTxError(e);
        setError(c.kind === "unknown" && e instanceof Error ? e.message : c.message);
      }
    }
  }, [address, signMessageAsync]);

  const lock = useCallback(() => {
    keyRef.current = null;
    setVault(null);
    setStatus("locked");
  }, []);

  const save = useCallback(async (next: VaultData) => {
    const store = browserStore();
    const k = keyRef.current;
    if (!store || !k || k.address !== next.address) throw new Error("Vault is locked.");
    await saveVault(store, k.key, next);
    setVault(next);
  }, []);

  return (
    <VaultContext.Provider value={{ status, vault, error, isNew, unlock, lock, save }}>{children}</VaultContext.Provider>
  );
}
