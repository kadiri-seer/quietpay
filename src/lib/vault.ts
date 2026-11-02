/**
 * Encrypted vault of payment requests and their stealth keys, persisted in localStorage.
 * Only ciphertext is ever written. Plain keys exist only in memory while the vault is unlocked.
 */
import { getAddress, type Address, type Hex } from "viem";
import type { LinkKind } from "./link";
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
  /** Set once the payment's token balance has been fully moved out. */
  claimTx?: Hex;
  claimedTo?: Address;
  claimedAt?: number;
  /** Every send out of this one-time address (full claims and partial sends). */
  sends?: { tx: Hex; to: Address; amount: string; at: number }[];
  /** Funds that came back to this address after being sent out (a pool exit). */
  returns?: { tx: Hex; amount: string; at: number }[];
}

export interface StoredRequest {
  id: Hex;
  /** "fixed" (one payment of a set amount) or "open" (reusable, any amount). Missing = fixed. */
  kind?: LinkKind;
  chainId: number;
  token: Address;
  amount: string; // base units; "0" for open links
  decimals: number;
  symbol: string;
  expiresAt: number; // unix seconds; 0 = never
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
  /** Link number the keys were derived from. Missing on old links that used random keys. */
  index?: number;
  /**
   * True when the link was rebuilt from the chain on this device. Its shareable code, amount and
   * expiry are not known (they only lived in the link), but its payments and funds are.
   */
  recovered?: boolean;
  payments: StoredPayment[];
}

export interface VaultData {
  version: 1;
  address: Address;
  requests: StoredRequest[];
  /**
   * Shielded pool master keys (decimal field elements), derived from the wallet signature on
   * unlock. The first set is used for new deposits; every set is scanned.
   */
  poolKeys?: { masterNullifier: string; masterSecret: string }[];
  /** Private key that signs QuietPay name reservations. Derived from the wallet signature. Never the wallet key. */
  nameKey?: Hex;
  /** Seed for every link's keys, derived from the wallet signature (src/lib/link-keys.ts). */
  linkSeed?: Hex;
  /** Number of the next link to create. Links 0..n-1 are in use. */
  nextLinkIndex?: number;
  /** When this browser last checked the chain for links made elsewhere (ms). */
  linksCheckedAt?: number;
  /** Private claims: payments shielded in the pool, then sent on to an address at a chosen time. */
  deliveries?: Delivery[];
}

export interface Delivery {
  id: string;
  /** Pool deposit label of the shielded payment. */
  label: string;
  /** Which of `poolKeys` made the deposit. */
  poolKeyIndex: number;
  depositTx: Hex;
  to: Address;
  /** Not before this time (ms). Equal to the deposit time for "as soon as it's approved". */
  notBefore: number;
  timing: "asap" | "chosen" | "random";
  status: "scheduled" | "delivered" | "cancelled";
  tx?: Hex;
  amount?: string;
  fee?: string;
  deliveredAt?: number;
  lastError?: string;
  /** Next attempt after a failure (ms). */
  retryAt?: number;
}

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const vaultSchema = z.object({
  version: z.literal(1),
  address: z.string(),
  requests: z.array(
    z
      .object({
        id: hex,
        kind: z.enum(["fixed", "open"]).optional(),
        chainId: z.number().int(),
        token: hex,
        amount: z.string().regex(/^\d+$/),
        decimals: z.number().int().min(0).max(36),
        symbol: z.string().max(32),
        expiresAt: z.number().int().min(0),
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
  poolKeys: z
    .array(z.object({ masterNullifier: z.string().regex(/^\d{1,78}$/), masterSecret: z.string().regex(/^\d{1,78}$/) }))
    .max(16)
    .optional(),
  nameKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  linkSeed: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  nextLinkIndex: z.number().int().min(0).optional(),
  linksCheckedAt: z.number().optional(),
  deliveries: z.array(z.any()).max(500).optional(),
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

export type RequestStatus = "created" | "expired" | "announcement_pending" | "claimable" | "claimed";

export const isExpired = (r: Pick<StoredRequest, "expiresAt">, nowSeconds = Math.floor(Date.now() / 1000)) =>
  r.expiresAt !== 0 && r.expiresAt <= nowSeconds;

/** Recipient-side status of a request, derived from verified local scan results. */
export function requestStatus(r: StoredRequest, nowSeconds = Math.floor(Date.now() / 1000)): RequestStatus {
  if (r.payments.length === 0) return isExpired(r, nowSeconds) ? "expired" : "created";
  const funded = r.payments.filter((p) => p.transferVerified);
  if (funded.length === 0) return "announcement_pending";
  if (funded.some((p) => !p.claimTx)) return "claimable";
  return "claimed";
}
