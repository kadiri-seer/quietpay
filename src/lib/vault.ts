/**
 * Encrypted vault of payment requests and their stealth keys, persisted in localStorage.
 * Only ciphertext is ever written. Plain keys exist only in memory while the vault is unlocked.
 */
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { open, seal, vaultAad, type Sealed } from "./vault-crypto";

export interface StoredPayment {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  announcementTx: Hex;
  announcementBlock: string;
  detectedAt: number; // ms, from the announcement block timestamp
  receivedAmount: string | null; // base units actually received (verified Transfer logs)
  transferVerified: boolean;
  claimTx?: Hex;
  claimedTo?: Address;
  claimedAt?: number;
}

export interface StoredRequest {
  id: Hex;
  chainId: number;
  token: Address;
  amount: string; // base units
  decimals: number;
  symbol: string;
  expiresAt: number; // unix seconds
  createdAt: number; // ms
  fromBlock: string; // block number at creation; scanning starts here
  lastScannedBlock?: string;
  link: string;
  keys: {
    spendingPrivateKey: Hex;
    viewingPrivateKey: Hex;
    spendingPublicKey: Hex;
    viewingPublicKey: Hex;
    stealthMetaAddress: Hex;
  };
  payments: StoredPayment[];
}

export interface VaultData {
  version: 1;
  address: Address;
  requests: StoredRequest[];
}

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const vaultSchema = z.object({
  version: z.literal(1),
  address: z.string(),
  requests: z.array(
    z
      .object({
        id: hex,
        chainId: z.number().int(),
        token: hex,
        amount: z.string().regex(/^\d+$/),
        decimals: z.number().int().min(0).max(36),
        symbol: z.string().max(32),
        expiresAt: z.number().int(),
        createdAt: z.number(),
        fromBlock: z.string().regex(/^\d+$/),
        link: z.string().max(400),
        keys: z.object({
          spendingPrivateKey: hex,
          viewingPrivateKey: hex,
          spendingPublicKey: hex,
          viewingPublicKey: hex,
          stealthMetaAddress: hex,
        }),
        payments: z.array(z.any()),
      })
      .passthrough(),
  ),
});

export function emptyVault(address: Address): VaultData {
  return { version: 1, address: getAddress(address), requests: [] };
}

export function parseVault(data: unknown): VaultData {
  return vaultSchema.parse(data) as unknown as VaultData;
}

/* ---------------- Storage ---------------- */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function browserStore(): KeyValueStore | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const probe = "quietpay:probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

export const vaultStorageKey = (address: Address) => `quietpay:vault:v1:${getAddress(address).toLowerCase()}`;

export function hasVault(store: KeyValueStore, address: Address) {
  return store.getItem(vaultStorageKey(address)) !== null;
}

export async function loadVault(store: KeyValueStore, key: CryptoKey, address: Address): Promise<VaultData> {
  const raw = store.getItem(vaultStorageKey(address));
  if (!raw) return emptyVault(address);
  const sealed = JSON.parse(raw) as Sealed;
  const data = await open(key, sealed, vaultAad(address));
  const vault = parseVault(data);
  if (getAddress(vault.address) !== getAddress(address)) throw new Error("Vault belongs to a different wallet.");
  return vault;
}

export async function saveVault(store: KeyValueStore, key: CryptoKey, vault: VaultData): Promise<void> {
  const sealed = await seal(key, vault, vaultAad(vault.address));
  store.setItem(vaultStorageKey(vault.address), JSON.stringify(sealed));
}

/** Merges restored requests into an existing vault without dropping local progress. */
export function mergeVaults(current: VaultData, incoming: VaultData): { vault: VaultData; added: number } {
  const byId = new Map(current.requests.map((r) => [r.id.toLowerCase(), r]));
  let added = 0;
  for (const r of incoming.requests) {
    const existing = byId.get(r.id.toLowerCase());
    if (!existing) {
      byId.set(r.id.toLowerCase(), r);
      added++;
      continue;
    }
    const payments = new Map(existing.payments.map((p) => [p.stealthAddress.toLowerCase(), p]));
    for (const p of r.payments) {
      const e = payments.get(p.stealthAddress.toLowerCase());
      if (!e || (!e.claimTx && p.claimTx)) payments.set(p.stealthAddress.toLowerCase(), p);
    }
    byId.set(r.id.toLowerCase(), { ...existing, payments: [...payments.values()] });
  }
  return { vault: { ...current, requests: [...byId.values()].sort((a, b) => b.createdAt - a.createdAt) }, added };
}

export type RequestStatus = "created" | "expired" | "announcement_pending" | "claimable" | "claimed";

/** Recipient-side status of a request, derived from verified local scan results. */
export function requestStatus(r: StoredRequest, nowSeconds = Math.floor(Date.now() / 1000)): RequestStatus {
  if (r.payments.length === 0) return r.expiresAt <= nowSeconds ? "expired" : "created";
  const funded = r.payments.filter((p) => p.transferVerified);
  if (funded.length === 0) return "announcement_pending";
  if (funded.some((p) => !p.claimTx)) return "claimable";
  return "claimed";
}
