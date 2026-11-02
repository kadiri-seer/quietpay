"use client";

/**
 * Holds the unlocked vault in memory. The AES key is non-extractable. By default it is never
 * persisted and reloading the page locks the vault again; if the user chooses "Keep me signed in
 * on this device", the key is kept in IndexedDB (src/lib/remember.ts) and the vault reopens on
 * the next visit without a signature.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useAccountEffect, usePublicClient, useSignMessage } from "wagmi";
import { getAddress, type Address, type Hex } from "viem";
import { buildVaultMessage, deriveVaultKey, DecryptionError } from "@/lib/vault-crypto";
import {
  browserStore,
  emptyVault,
  hasVault,
  KeyChangedError,
  openVault,
  rekeyVault,
  shouldRotate,
  vaultStorageKey,
  writeVault,
  type VaultData,
  type VaultKeys,
} from "@/lib/vault";
import { derivePoolMasterKeys } from "@/lib/pool/crypto";
import { deriveNameKey } from "@/lib/names/names";
import { deriveLinkSeed } from "@/lib/link-keys";
import { classifyTxError } from "@/lib/tx-errors";
import { forgetKey, hasDeclined, recallKey, rememberKey, setDeclined } from "@/lib/remember";
import { signsOnce, type WalletFacts } from "@/lib/wallet-kind";

/** Runs `fn` while holding a lock shared by every QuietPay tab (Web Locks), or directly where unsupported. */
export function withVaultLock<T>(address: Address, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (!locks) return fn();
  return locks.request(`quietpay-vault-${address.toLowerCase()}`, fn) as Promise<T>;
}

type Status = "locked" | "restoring" | "unlocking" | "confirming" | "unlocked" | "unavailable";

/**
 * Why a second signature is needed: "first" when setting up with a wallet QuietPay doesn't
 * recognise as an ordinary one, "check" when the saved vault didn't open with this signature.
 */
export type ConfirmReason = "first" | "check";

interface VaultContextValue {
  status: Status;
  vault: VaultData | null;
  error: string | null;
  isNew: boolean;
  /** Signs to open the vault. `remember: true` keeps this device signed in without asking. */
  unlock: (opts?: { remember?: boolean }) => Promise<void>;
  /** Locks the vault and signs this device out (forgets a remembered key). */
  lock: () => void;
  /** When the vault stays open on this device until (ms), or null if it isn't remembered. */
  rememberedUntil: number | null;
  /** True right after a signature, when we should ask whether to stay signed in. */
  askRemember: boolean;
  /** Answer to "Keep me signed in on this device?" */
  chooseRemember: (yes: boolean) => Promise<void>;
  /** While status is "confirming": why, and the tap that asks the wallet for the second signature. */
  confirmReason: ConfirmReason | null;
  confirmAgain: () => void;
  /**
   * The only way to change the vault: applies `fn` to the latest saved vault and saves the result.
   * Updates run one at a time across every QuietPay tab (a Web Lock), and each one re-reads what
   * is stored first, so a change made elsewhere (another tab, a scan finishing, a delivery) is
   * never overwritten by an older copy.
   */
  update: (fn: (current: VaultData) => VaultData | Promise<VaultData>) => Promise<VaultData>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault() {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("VaultContext missing");
  return ctx;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const { address, connector } = useAccount();
  const client = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const [confirmReason, setConfirmReason] = useState<ConfirmReason | null>(null);
  // The second signature waits for a tap, so on a phone the wallet app opens for it properly.
  const tapRef = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const waitForTap = useCallback((reason: ConfirmReason) => {
    setConfirmReason(reason);
    setStatus("confirming");
    return new Promise<void>((resolve, reject) => {
      tapRef.current = { resolve, reject };
    }).finally(() => {
      tapRef.current = null;
      setConfirmReason(null);
      setStatus("unlocking");
    });
  }, []);
  const confirmAgain = useCallback(() => tapRef.current?.resolve(), []);

  /** What QuietPay can tell about the connected wallet (see src/lib/wallet-kind.ts). */
  const walletFacts = useCallback(async (): Promise<WalletFacts> => {
    const facts: WalletFacts = { connectorId: connector?.id };
    try {
      if (connector?.type === "walletConnect") {
        const provider = (await connector.getProvider()) as { session?: { peer?: { metadata?: { name?: string } } } };
        facts.peerName = provider?.session?.peer?.metadata?.name ?? null;
      } else if (connector?.id === "injected" && typeof window !== "undefined") {
        const eth = (window as { ethereum?: Record<string, unknown> }).ethereum ?? {};
        const flag = ["isRabby", "isCoinbaseWallet", "isTrust", "isTrustWallet", "isBraveWallet", "isRainbow", "isPhantom", "isOkxWallet", "isMetaMask"].find((f) => eth[f] === true);
        facts.peerName = flag ? flag.slice(2).replace(/Wallet$/, " wallet").replace("MetaMask", "metamask") : null;
      }
    } catch {
      facts.peerName = null;
    }
    try {
      facts.code = address && client ? ((await client.getCode({ address })) ?? "0x") : null;
    } catch {
      facts.code = null;
    }
    return facts;
  }, [connector, client, address]);
  const [status, setStatus] = useState<Status>("locked");
  const [vault, setVault] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [rememberedUntil, setRememberedUntil] = useState<number | null>(null);
  const [askRemember, setAskRemember] = useState(false);
  // The vault's data key (format v2), never the signature-derived key.
  const keyRef = useRef<{ keys: VaultKeys; address: Address } | null>(null);
  const prevAddress = useRef<Address | undefined>(undefined);

  // A deliberate disconnect signs this device out.
  useAccountEffect({ onDisconnect: () => void forgetKey() });

  // Lock whenever the connected wallet changes, then reopen from a remembered key if there is one.
  useEffect(() => {
    tapRef.current?.reject(new Error("Wallet changed."));
    // Another wallet connected in place of the remembered one: sign this device out of the old one.
    // (While the page loads, the address is briefly undefined; that is not a switch.)
    if (prevAddress.current && address && prevAddress.current !== address) void forgetKey();
    if (address) prevAddress.current = address;
    keyRef.current = null;
    setVault(null);
    setError(null);
    setRememberedUntil(null);
    setAskRemember(false);
    const store = browserStore();
    setIsNew(address ? !(store && hasVault(store, address)) : false);
    if (!store) return setStatus("unavailable");
    if (!address || !hasVault(store, address)) return setStatus("locked");
    setStatus("restoring");
    let cancelled = false;
    (async () => {
      try {
        const r = await recallKey(address);
        if (!r) throw new Error("none");
        let data: VaultData;
        let keys: VaultKeys | null;
        if (r.kind === "dek") {
          ({ data, keys } = await openVault(store, address, { dek: { key: r.key, kid: r.kid ?? "" } }));
        } else {
          // Kept before vault v2: this is the signature-derived key. Open with it, upgrade the
          // vault to v2 if needed, and keep the new data key instead from now on.
          ({ data, keys } = await openVault(store, address, { kek: r.key }));
          const kek = r.key;
          keys = await withVaultLock(address, async () => (keys ? keys : rekeyVault(store, kek, data)));
          keys = { ...keys, remembered: true };
          await writeVault(store, keys, data);
          await rememberKey(address, keys.dek, { kind: "dek", kid: keys.kid, expiresAt: r.expiresAt });
        }
        if (!keys) throw new Error("needs a signature");
        // Every derived key must already be in the vault; otherwise a signature is needed once.
        if (!data.linkSeed || !data.nameKey || !data.poolKeys?.length) throw new Error("incomplete");
        if (cancelled) return;
        keyRef.current = { keys, address };
        setVault(data);
        setRememberedUntil(r.expiresAt);
        setStatus("unlocked");
      } catch (e) {
        // A kept key that no longer opens the vault (it was rotated at a later signature) is useless.
        if (e instanceof KeyChangedError || e instanceof DecryptionError) void forgetKey();
        if (!cancelled) setStatus("locked");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  /**
   * Keeps the data key on this device ("stay signed in") and marks it in the saved vault, so the
   * next signature unlock replaces it with a new one.
   */
  const keepOnDevice = useCallback(async () => {
    const k = keyRef.current;
    const store = browserStore();
    if (!k || !store) return;
    const until = await rememberKey(k.address, k.keys.dek, { kind: "dek", kid: k.keys.kid });
    if (until === null) {
      setError("This browser would not keep you signed in (private browsing or blocked site data). You'll be asked to sign next time.");
      return;
    }
    if (!k.keys.remembered) {
      const marked = { ...k.keys, remembered: true };
      await withVaultLock(k.address, async () => {
        const { data } = await openVault(store, k.address, { dek: { key: marked.dek, kid: marked.kid } });
        await writeVault(store, marked, data);
      }).catch(() => undefined);
      if (keyRef.current === k) keyRef.current = { ...k, keys: marked };
    }
    setRememberedUntil(until);
  }, []);

  const unlock = useCallback(async (opts?: { remember?: boolean }) => {
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
      const signsSame = async (reason: ConfirmReason) => {
        await waitForTap(reason);
        const again = (await signMessageAsync({ message })) as Hex;
        return again.toLowerCase() === sig.toLowerCase();
      };
      // The vault key is derived from this signature, so it must be reproducible. Ordinary wallets
      // always sign the same way; anything QuietPay can't vouch for signs a second time to compare.
      if (firstTime && !signsOnce(await walletFacts(), sig) && !(await signsSame("first"))) {
        throw new Error(
          "Your wallet produced two different signatures for the same message, so QuietPay can't recreate your keys from it. Use an ordinary wallet account (MetaMask, Rabby, Coinbase Wallet, Trust and most others work), not a smart-contract or passkey wallet.",
        );
      }
      const kek = await deriveVaultKey(sig, address);
      let data: VaultData;
      let keys: VaultKeys | null = null;
      try {
        ({ data, keys } = await openVault(store, address, { kek }));
      } catch (e) {
        if (!(e instanceof DecryptionError)) throw e;
        // This browser holds a vault this signature can't open. Either it was made with an older
        // QuietPay message (then start a fresh local cache: every key is re-derived from the
        // signature, and the Receive page recovers links from the chain), or the wallet now signs
        // differently, which a second signature shows. In that case keep the saved vault and stop.
        if (!(await signsSame("check"))) {
          throw new Error(
            "Your wallet signed differently from when you set up QuietPay here, so your saved keys can't be opened with it. Nothing was changed. If you switched to a smart or passkey account, switch back to the account you used before.",
          );
        }
        data = emptyVault(address);
      }
      // A new vault, a v1 vault (upgraded now; its old ciphertext is kept as a backup), a reset
      // one, or a data key that was kept on a device or is old: start a new data key.
      if (!keys || shouldRotate(keys)) {
        const current = data;
        keys = await withVaultLock(address, () => rekeyVault(store, kek, current));
      }
      const save = (d: VaultData) => writeVault(store, keys!, d);
      // Pool keys, the name key and the link seed all come from this one signature (each with its
      // own derivation), so connecting the same wallet on any device recreates them.
      const pk = await derivePoolMasterKeys(sig, address);
      const pkStr = { masterNullifier: pk.masterNullifier.toString(), masterSecret: pk.masterSecret.toString() };
      const known = data.poolKeys ?? [];
      if (!known.some((k) => k.masterNullifier === pkStr.masterNullifier && k.masterSecret === pkStr.masterSecret)) {
        data = { ...data, poolKeys: [...known, pkStr] };
        await save(data);
      }
      const nameKey = await deriveNameKey(sig, address);
      const linkSeed = await deriveLinkSeed(sig, address);
      if (data.nameKey !== nameKey || data.linkSeed !== linkSeed) {
        data = { ...data, nameKey, linkSeed };
        await save(data);
      }
      keyRef.current = { keys, address };
      setVault(data);
      setIsNew(firstTime);
      setRememberedUntil(null);
      setAskRemember(!opts?.remember && !hasDeclined(address));
      setStatus("unlocked");
      if (opts?.remember) {
        setDeclined(address, false);
        await keepOnDevice();
      }
    } catch (e) {
      setStatus("locked");
      if (e instanceof DecryptionError) {
        setError("The signature did not unlock this browser's vault. Make sure you connected the same wallet you used before.");
      } else {
        const c = classifyTxError(e);
        setError(c.kind === "unknown" && e instanceof Error ? e.message : c.message);
      }
    }
  }, [address, signMessageAsync, walletFacts, waitForTap, keepOnDevice]);

  const lock = useCallback(() => {
    tapRef.current?.reject(new Error("Locked."));
    void forgetKey();
    keyRef.current = null;
    setVault(null);
    setRememberedUntil(null);
    setAskRemember(false);
    setStatus("locked");
  }, []);

  const chooseRemember = useCallback(async (yes: boolean) => {
    const k = keyRef.current;
    setAskRemember(false);
    if (!k) return;
    setDeclined(k.address, !yes);
    if (!yes) return;
    await keepOnDevice();
  }, []);

  const vaultRef = useRef<VaultData | null>(null);
  useEffect(() => {
    vaultRef.current = vault;
  }, [vault]);

  // Another tab saved the vault: load its version so this tab never works from a stale copy.
  useEffect(() => {
    if (status !== "unlocked" || !address) return;
    const key = vaultStorageKey(address);
    const onStorage = (e: StorageEvent) => {
      const k = keyRef.current;
      const store = browserStore();
      if (e.key !== key || !k || !store) return;
      void openVault(store, k.address, { dek: { key: k.keys.dek, kid: k.keys.kid } })
        .then(({ data }) => {
          vaultRef.current = data;
          setVault(data);
        })
        .catch(async (err) => {
          if (!(err instanceof KeyChangedError)) return;
          // Another tab signed in again and re-keyed the vault. Pick up the new key if this device
          // keeps it; otherwise this tab must unlock again.
          const r = await recallKey(k.address).catch(() => null);
          if (r?.kind === "dek" && r.kid) {
            try {
              const o = await openVault(store, k.address, { dek: { key: r.key, kid: r.kid } });
              if (o.keys) {
                keyRef.current = { keys: o.keys, address: k.address };
                vaultRef.current = o.data;
                setVault(o.data);
                return;
              }
            } catch {
              /* fall through to locking */
            }
          }
          keyRef.current = null;
          setVault(null);
          setStatus("locked");
          setError(new KeyChangedError().message);
        });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [status, address]);

  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const update = useCallback((fn: (current: VaultData) => VaultData | Promise<VaultData>) => {
    const run = async () => {
      const k = keyRef.current;
      const store = browserStore();
      if (!k || !store || !vaultRef.current) throw new Error("Vault is locked.");
      return withVaultLock(k.address, async () => {
        let cur = vaultRef.current!;
        try {
          ({ data: cur } = await openVault(store, k.address, { dek: { key: k.keys.dek, kid: k.keys.kid } }));
        } catch (e) {
          // Re-keyed elsewhere: never overwrite it with this tab's out-of-date key.
          if (e instanceof KeyChangedError) {
            keyRef.current = null;
            setVault(null);
            setStatus("locked");
            setError(e.message);
            throw e;
          }
          /* unreadable stored copy (altered or corrupted): keep the one in memory */
        }
        const next = await fn(cur);
        if (getAddress(next.address) !== getAddress(k.address)) throw new Error("Vault is locked.");
        await writeVault(store, k.keys, next);
        if (keyRef.current === k) {
          vaultRef.current = next;
          setVault(next);
        }
        return next;
      });
    };
    const p = queue.current.then(run, run);
    queue.current = p.catch(() => undefined);
    return p;
  }, []);

  return (
    <VaultContext.Provider value={{ status, vault, error, isNew, unlock, lock, update, rememberedUntil, askRemember, chooseRemember, confirmReason, confirmAgain }}>{children}</VaultContext.Provider>
  );
}
