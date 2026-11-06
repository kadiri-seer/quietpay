/**
 * Encrypted vault of payment requests and their stealth keys, persisted in localStorage.
 * Only ciphertext is ever written. Plain keys exist only in memory while the vault is unlocked.
 */
import { bytesToHex, getAddress, isAddress, type Address, type Hex } from "viem";
import { getPublicKey } from "@noble/secp256k1";
import type { LinkKind } from "./link";
import { z } from "zod";
import {
  DecryptionError,
  newDataKey,
  open,
  seal,
  unwrapDataKey,
  vaultAad,
  vaultAadV2,
  VAULT_V2,
  type Sealed,
  type WrappedKey,
} from "./vault-crypto";

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
  /**
   * Set when the link pays straight into the shielded pool: the lock it carries (receive index =
   * link index). Its payment shows up as a pool note, not at a one-time address.
   */
  pool?: { precommitment: string; refund: Address; receiveIndex: number };
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
  /** Signed pool locks uploaded for your personal link (they are numbered 0..n-1). */
  lockCount?: number;
  /** When this browser last checked the chain for links made elsewhere (ms). */
  linksCheckedAt?: number;
  /** Private claims: payments shielded in the pool, then sent on to an address at a chosen time. */
  deliveries?: Delivery[];
  /** Saved records that failed validation, kept as found and left out of everything else. */
  quarantine?: QuarantinedRecord[];
}

export interface QuarantinedRecord {
  /** What it was: "request", "payment", "delivery", or a field name. */
  kind: string;
  reason: string;
  /** When it was set aside (ms). */
  at: number;
  /** The record as found, as JSON (at most 20,000 characters). */
  raw: string;
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

export function emptyVault(address: Address): VaultData {
  return { version: 1, address: getAddress(address), requests: [] };
}

/* ---------------- Strict record validation ---------------- */

/**
 * Every record read from storage is checked against a strict schema before the app uses it:
 * exact shapes (no unexpected properties), valid addresses, hashes and keys, bounded numbers and
 * array sizes. A record that fails is not used (so it can't affect balances or matching) and is
 * not deleted either: it is moved, as found, into `quarantine`.
 */
const MAX_UINT256 = (1n << 256n) - 1n;
const hexBytes = (n: number) => z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${n * 2}}$`));
const txHash = hexBytes(32);
const address = z.string().refine((a) => isAddress(a, { strict: false }), "invalid address");
// One check, so it can never run BigInt() on something that isn't digits (zod 4 runs refinements
// even after an earlier check on the same value has failed).
const uintStr = z.string().refine((v) => /^\d{1,78}$/.test(v) && BigInt(v) <= MAX_UINT256, "not a whole number in range");
/** Milliseconds since 1970, not absurdly far in the future (other devices' clocks can be a bit ahead). */
const timeMs = z.number().int().min(0).max(4_102_444_800_000);
const compressedPoint = z.string().regex(/^0x0[23][0-9a-fA-F]{64}$/);
const shortText = (max: number) => z.string().max(max);

export const sendSchema = z.strictObject({ tx: txHash, to: address, amount: uintStr, at: timeMs });
export const returnSchema = z.strictObject({ tx: txHash, amount: uintStr, at: timeMs });

export const paymentSchema = z
  .strictObject({
    stealthAddress: address,
    ephemeralPublicKey: compressedPoint,
    announcementTx: txHash,
    announcementBlock: uintStr,
    detectedAt: timeMs,
    receivedAmount: uintStr.nullable(),
    transferVerified: z.boolean(),
    claimTx: txHash.optional(),
    claimedTo: address.optional(),
    claimedAt: timeMs.optional(),
    sends: z.array(sendSchema).max(200).optional(),
    returns: z.array(returnSchema).max(200).optional(),
  })
  // A claim names where it went; a verified transfer has an amount.
  .refine((p) => !p.claimTx || !!p.claimedTo, "claim without destination")
  .refine((p) => !p.transferVerified || p.receivedAmount !== null, "verified transfer without amount");

const requestKeysSchema = z
  .strictObject({
    spendingPrivateKey: hexBytes(32),
    viewingPrivateKey: hexBytes(32),
    spendingPublicKey: compressedPoint,
    viewingPublicKey: compressedPoint,
    stealthMetaAddress: hexBytes(66),
  })
  // The public keys must belong to the private keys, or payments could be matched to the wrong link.
  .refine((k) => {
    try {
      return (
        bytesToHex(getPublicKey(k.spendingPrivateKey.slice(2), true)).toLowerCase() === k.spendingPublicKey.toLowerCase() &&
        bytesToHex(getPublicKey(k.viewingPrivateKey.slice(2), true)).toLowerCase() === k.viewingPublicKey.toLowerCase() &&
        k.stealthMetaAddress.toLowerCase() === `0x${k.spendingPublicKey.slice(2)}${k.viewingPublicKey.slice(2)}`.toLowerCase()
      );
    } catch {
      return false;
    }
  }, "keys don't match");

/** A request without its payments (those are checked one by one, so one bad payment doesn't hide the rest). */
const requestShellSchema = z.strictObject({
  id: hexBytes(16),
  kind: z.enum(["fixed", "open"]).optional(),
  chainId: z.number().int().positive().max(0xffffffff),
  token: address,
  amount: uintStr,
  decimals: z.number().int().min(0).max(36),
  symbol: shortText(32),
  expiresAt: z.number().int().min(0).max(2 ** 40),
  createdAt: timeMs,
  fromBlock: uintStr,
  lastScannedBlock: uintStr.optional(),
  link: shortText(400),
  keys: requestKeysSchema,
  index: z.number().int().min(0).max(1_000_000).optional(),
  recovered: z.boolean().optional(),
  pool: z.strictObject({ precommitment: uintStr, refund: address, receiveIndex: z.number().int().min(0).max(1_000_000) }).optional(),
  payments: z.array(z.unknown()).max(1000),
});

export const deliverySchema = z
  .strictObject({
    id: shortText(100),
    label: uintStr,
    poolKeyIndex: z.number().int().min(0).max(15),
    depositTx: txHash,
    to: address,
    notBefore: timeMs,
    timing: z.enum(["asap", "chosen", "random"]),
    status: z.enum(["scheduled", "delivered", "cancelled"]),
    tx: txHash.optional(),
    amount: uintStr.optional(),
    fee: uintStr.optional(),
    deliveredAt: timeMs.optional(),
    // Not sensitive and sometimes long (an error message): trimmed rather than rejected.
    lastError: z.string().max(5000).transform((v) => v.slice(0, 300)).optional(),
    retryAt: timeMs.optional(),
  })
  .refine((d) => d.status !== "delivered" || !!d.tx, "delivered without a transaction");

const fieldNum = z.string().regex(/^\d{1,78}$/);
const quarantineSchema = z.strictObject({ kind: shortText(20), reason: shortText(300), at: timeMs, raw: shortText(20_000) });

/** Records that couldn't be read, kept as found (newest last), up to this many. */
export const MAX_QUARANTINE = 500;

const topSchema = z.object({
  version: z.literal(1),
  address,
  requests: z.array(z.unknown()).max(2000),
  poolKeys: z.unknown().optional(),
  nameKey: z.unknown().optional(),
  linkSeed: z.unknown().optional(),
  nextLinkIndex: z.unknown().optional(),
  linksCheckedAt: z.unknown().optional(),
  lockCount: z.unknown().optional(),
  deliveries: z.unknown().optional(),
  quarantine: z.unknown().optional(),
});

function reasonOf(e: z.ZodError): string {
  const i = e.issues[0];
  return `${i?.path.join(".") || "record"}: ${i?.message ?? "invalid"}`.slice(0, 300);
}

/**
 * Validates a decrypted vault. Throws only if the vault as a whole isn't one (wrong version or
 * owner, not an object): that is treated like a failed decryption. Anything smaller that is wrong
 * (a request, a payment, a delivery, an optional field) is set aside in `quarantine` and the rest
 * opens normally.
 */
export function parseVault(data: unknown, now = Date.now()): VaultData {
  const top = topSchema.safeParse(data);
  if (!top.success) throw new Error(`Vault data is not readable (${reasonOf(top.error)}).`);
  const t = top.data;
  const quarantine: QuarantinedRecord[] = [];
  const prior = z.array(quarantineSchema).max(MAX_QUARANTINE).safeParse(t.quarantine ?? []);
  if (prior.success) quarantine.push(...prior.data);
  const setAside = (kind: string, raw: unknown, reason: string) => {
    let text: string;
    try {
      text = JSON.stringify(raw) ?? String(raw);
    } catch {
      text = String(raw);
    }
    quarantine.push({ kind, reason: reason.slice(0, 300), at: now, raw: text.slice(0, 20_000) });
  };

  const requests: StoredRequest[] = [];
  for (const r of t.requests) {
    const shell = requestShellSchema.safeParse(r);
    if (!shell.success) {
      setAside("request", r, reasonOf(shell.error));
      continue;
    }
    const payments: StoredPayment[] = [];
    for (const p of shell.data.payments) {
      const ok = paymentSchema.safeParse(p);
      if (ok.success) payments.push(ok.data as StoredPayment);
      else setAside("payment", { requestId: shell.data.id, payment: p }, reasonOf(ok.error));
    }
    requests.push({ ...(shell.data as unknown as StoredRequest), payments });
  }

  const out: VaultData = { version: 1, address: getAddress(t.address), requests };
  const opt = <T>(name: string, schema: z.ZodType<T>, value: unknown, apply: (v: T) => void) => {
    if (value === undefined) return;
    const r = schema.safeParse(value);
    if (r.success) apply(r.data);
    else setAside(name, value, reasonOf(r.error));
  };
  opt("poolKeys", z.array(z.strictObject({ masterNullifier: fieldNum, masterSecret: fieldNum })).max(16), t.poolKeys, (v) => (out.poolKeys = v));
  opt("nameKey", hexBytes(32), t.nameKey, (v) => (out.nameKey = v as Hex));
  opt("linkSeed", hexBytes(32), t.linkSeed, (v) => (out.linkSeed = v as Hex));
  opt("nextLinkIndex", z.number().int().min(0).max(1_000_000), t.nextLinkIndex, (v) => (out.nextLinkIndex = v));
  opt("linksCheckedAt", timeMs, t.linksCheckedAt, (v) => (out.linksCheckedAt = v));
  opt("lockCount", z.number().int().min(0).max(1_000_000), t.lockCount, (v) => (out.lockCount = v));
  if (t.deliveries !== undefined) {
    const list = z.array(z.unknown()).max(500).safeParse(t.deliveries);
    if (!list.success) setAside("deliveries", t.deliveries, reasonOf(list.error));
    else {
      const ds: Delivery[] = [];
      for (const d of list.data) {
        const ok = deliverySchema.safeParse(d);
        if (ok.success) ds.push(ok.data as Delivery);
        else setAside("delivery", d, reasonOf(ok.error));
      }
      out.deliveries = ds;
    }
  }
  if (quarantine.length) out.quarantine = quarantine.slice(-MAX_QUARANTINE);
  return out;
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

/* ---------------- Vault format v2 (random data key, wrapped by the signature key) ---------------- */

/** How long a data key is used before the next signature unlock replaces it. */
export const MAX_DATA_KEY_AGE_MS = 30 * 86_400_000;

export interface VaultKeys {
  /** The data key, non-extractable. */
  dek: CryptoKey;
  /** The data key wrapped by the signature key, as stored. */
  wrapped: WrappedKey;
  kid: string;
  /** When this data key was created (ms). */
  created: number;
  /** True once this data key has been kept on a device ("stay signed in"); it is then rotated at the next signature. */
  remembered: boolean;
}

interface SealedV2 extends Sealed {
  v: 2;
  kid: string;
  created: number;
  remembered?: boolean;
  key: WrappedKey;
}

/** The saved vault was re-keyed elsewhere (another tab or device signed in again). */
export class KeyChangedError extends Error {
  constructor() {
    super("QuietPay was unlocked again in another tab, so this tab's key is out of date. Unlock again here.");
    this.name = "KeyChangedError";
  }
}

const isWrapped = (w: unknown): w is WrappedKey =>
  !!w && typeof (w as WrappedKey).iv === "string" && typeof (w as WrappedKey).ct === "string" && (w as WrappedKey).ct.length < 200;

type Blob = { v: 1; sealed: Sealed } | { v: 2; sealed: SealedV2 };

/** The raw stored vault, or null. Throws DecryptionError if it isn't a recognisable vault. */
export function readBlob(store: KeyValueStore, address: Address): Blob | null {
  const raw = store.getItem(vaultStorageKey(address));
  if (!raw) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new DecryptionError("Unsupported format.");
  }
  const b = j as Partial<Omit<SealedV2, "v">> & { v?: number };
  if (b?.v === 1) return { v: 1, sealed: b as unknown as Sealed };
  if (b?.v === VAULT_V2 && typeof b.kid === "string" && /^[0-9a-f]{16}$/.test(b.kid) && typeof b.created === "number" && isWrapped(b.key)) {
    return { v: 2, sealed: b as unknown as SealedV2 };
  }
  throw new DecryptionError("Unsupported format.");
}

/** The stored data key id, or null (no vault, or a v1 vault). */
export function storedKeyId(store: KeyValueStore, address: Address): string | null {
  try {
    const b = readBlob(store, address);
    return b?.v === 2 ? b.sealed.kid : null;
  } catch {
    return null;
  }
}

/**
 * Opens the saved vault with whatever key is at hand:
 *  - `dek` (a kept data key and its id): v2 only; throws KeyChangedError if the vault was re-keyed;
 *  - `kek` (the signature key): v2 (unwraps the data key) or v1.
 * Returns the parsed data, the keys (null for v1, which must then be upgraded), and the version
 * (0 when nothing is saved yet). Authentication failures throw DecryptionError; nothing partial
 * is ever returned.
 */
export async function openVault(
  store: KeyValueStore,
  address: Address,
  by: { kek?: CryptoKey; dek?: { key: CryptoKey; kid: string } },
): Promise<{ data: VaultData; keys: VaultKeys | null; version: 0 | 1 | 2 }> {
  const blob = readBlob(store, address);
  if (!blob) return { data: emptyVault(address), keys: null, version: 0 };
  if (blob.v === 1) {
    if (!by.kek) throw new DecryptionError("This vault needs a signature to open.");
    const data = parseVault(await open(by.kek, blob.sealed, vaultAad(address)));
    if (getAddress(data.address) !== getAddress(address)) throw new Error("Vault belongs to a different wallet.");
    return { data, keys: null, version: 1 };
  }
  const b = blob.sealed;
  let dek: CryptoKey;
  if (by.dek) {
    if (by.dek.kid !== b.kid) throw new KeyChangedError();
    dek = by.dek.key;
  } else if (by.kek) {
    dek = await unwrapDataKey(by.kek, b.key, address, b.kid);
  } else {
    throw new DecryptionError("No key to open this vault.");
  }
  const data = parseVault(await open(dek, b, vaultAadV2(address, b.kid), VAULT_V2));
  if (getAddress(data.address) !== getAddress(address)) throw new Error("Vault belongs to a different wallet.");
  return { data, keys: { dek, wrapped: b.key, kid: b.kid, created: b.created, remembered: !!b.remembered }, version: 2 };
}

/** Encrypts and saves `data` with `keys` (always format v2). */
export async function writeVault(store: KeyValueStore, keys: VaultKeys, data: VaultData): Promise<void> {
  const sealed = await seal(keys.dek, data, vaultAadV2(data.address, keys.kid), VAULT_V2);
  const out: SealedV2 = { ...sealed, v: 2, kid: keys.kid, created: keys.created, ...(keys.remembered ? { remembered: true } : {}), key: keys.wrapped };
  store.setItem(vaultStorageKey(data.address), JSON.stringify(out));
}

/** Where an upgraded v1 vault's original ciphertext is kept, untouched, in case it is ever needed. */
export const vaultV1BackupKey = (address: Address) => `quietpay:vault:v1-backup:${getAddress(address).toLowerCase()}`;

/**
 * Re-keys the vault with a new data key wrapped by `kek` and saves `data` with it. Used to upgrade
 * a v1 vault (its original ciphertext is kept under vaultV1BackupKey first), to start a new vault,
 * and to rotate the data key.
 */
export async function rekeyVault(store: KeyValueStore, kek: CryptoKey, data: VaultData, now = Date.now()): Promise<VaultKeys> {
  const prev = store.getItem(vaultStorageKey(data.address));
  try {
    if (prev && (JSON.parse(prev) as { v?: number }).v === 1 && !store.getItem(vaultV1BackupKey(data.address))) {
      store.setItem(vaultV1BackupKey(data.address), prev);
    }
  } catch {
    /* unparseable old blob: nothing worth keeping */
  }
  const k = await newDataKey(kek, data.address);
  const keys: VaultKeys = { dek: k.dek, wrapped: k.wrapped, kid: k.kid, created: now, remembered: false };
  await writeVault(store, keys, data);
  return keys;
}

/** Rotate at a signature unlock if the data key was ever kept on a device, or is old. */
export function shouldRotate(keys: VaultKeys, now = Date.now()): boolean {
  return keys.remembered || now - keys.created > MAX_DATA_KEY_AGE_MS;
}
