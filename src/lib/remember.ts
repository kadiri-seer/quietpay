/**
 * "Keep me signed in on this device": keeps the vault's data key in IndexedDB so the vault opens
 * on the next visit without a new wallet signature. (Vault format v2: this is the random data
 * key, never the key derived from the wallet signature, and it is rotated at the next signature.
 * Entries saved before v2 hold the signature-derived key; they are recognised as kind "kek" and
 * replaced with a data key when they are next used.)
 *
 * The key is a non-extractable CryptoKey. IndexedDB stores it as is, so the browser can use it
 * to decrypt the vault, but no script (QuietPay's or anyone's) can read its bytes out. It is
 * still usable by anything running in this site's pages, which is why remembering is opt-in,
 * expires, and is cleared on Lock, on Disconnect and when another wallet connects.
 *
 * Only one wallet is remembered per browser. The signature itself is never stored.
 */
import { getAddress, type Address } from "viem";

export const REMEMBER_DAYS = 30;
const DB = "quietpay-session";
const STORE = "keys";
const ID = "current";

export type KeptKind = "dek" | "kek";

interface Entry {
  id: typeof ID;
  address: Address;
  key: CryptoKey;
  expiresAt: number;
  /** Missing on entries saved before vault v2, which hold the signature-derived key. */
  kind?: KeptKind;
  kid?: string;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result ?? null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Remembers `key` for `address`, replacing any other remembered wallet. Returns the expiry (ms), or null if the browser refused. */
export async function rememberKey(
  address: Address,
  key: CryptoKey,
  opts: { kind: KeptKind; kid?: string; expiresAt?: number } = { kind: "dek" },
  nowMs = Date.now(),
): Promise<number | null> {
  if (key.extractable) throw new Error("Refusing to remember an extractable key.");
  const expiresAt = opts.expiresAt ?? nowMs + REMEMBER_DAYS * 86_400_000;
  const entry: Entry = { id: ID, address: getAddress(address), key, expiresAt, kind: opts.kind, ...(opts.kid ? { kid: opts.kid } : {}) };
  const ok = await run("readwrite", (s) => s.put(entry));
  return ok === null ? null : expiresAt;
}

/** The remembered key for `address`, if there is one and it hasn't expired. */
export async function recallKey(address: Address, nowMs = Date.now()): Promise<{ key: CryptoKey; expiresAt: number; kind: KeptKind; kid: string | null } | null> {
  const e = (await run("readonly", (s) => s.get(ID) as IDBRequest<Entry | undefined>)) as Entry | null;
  if (!e || !(e.key instanceof CryptoKey)) return null;
  if (e.expiresAt <= nowMs) {
    await forgetKey();
    return null;
  }
  if (getAddress(e.address) !== getAddress(address)) return null;
  return { key: e.key, expiresAt: e.expiresAt, kind: e.kind ?? "kek", kid: e.kid ?? null };
}

export async function forgetKey(): Promise<void> {
  await run("readwrite", (s) => s.delete(ID));
}

const declinedKey = (address: Address) => `quietpay:stay-signed-in:${getAddress(address).toLowerCase()}`;

/** True if the user answered "No" for this wallet on this device, so we don't ask again. */
export function hasDeclined(address: Address): boolean {
  try {
    return localStorage.getItem(declinedKey(address)) === "no";
  } catch {
    return false;
  }
}

export function setDeclined(address: Address, declined: boolean) {
  try {
    if (declined) localStorage.setItem(declinedKey(address), "no");
    else localStorage.removeItem(declinedKey(address));
  } catch {
    /* storage blocked: we'll just ask again next time */
  }
}
