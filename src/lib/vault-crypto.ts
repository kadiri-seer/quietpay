/**
 * Client-side encryption for stealth keys (Web Crypto only).
 *
 * Vault key: HKDF-SHA256 over a wallet signature of a domain-separated message
 *   (buildVaultMessage), salt "quietpay/vault/v1", info "aes-256-gcm|<address>".
 *   The resulting AES-256-GCM key is non-extractable and lives only in memory.
 *   The signature itself is never stored.
 *
 * Backups: AES-256-GCM with a key from PBKDF2-SHA256 (600,000 iterations) over a user
 *   passphrase, so a backup can be restored even if the wallet's signatures change.
 *
 * Every ciphertext binds associated data (purpose + address), so a blob cannot be swapped
 * between wallets or between vault/backup contexts without failing authentication.
 */
import { getAddress, hexToBytes, type Address, type Hex } from "viem";

export const VAULT_VERSION = 1;
export const BACKUP_FORMAT = "quietpay-backup";
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 12;

const te = new TextEncoder();
const td = new TextDecoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("Web Crypto is unavailable. Use a modern browser over HTTPS.");
  return s;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Copies into a fresh ArrayBuffer-backed view (keeps TS's BufferSource typing happy). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * The exact message a wallet signs to unlock the vault. Domain-separated by app, purpose,
 * version and address. It authorizes nothing onchain.
 */
export function buildVaultMessage(address: Address): string {
  return [
    "QuietPay vault key",
    "",
    "Sign to unlock the encrypted payment keys QuietPay stores in this browser.",
    "This signature does not send a transaction or cost gas.",
    "Only sign this message on the QuietPay app you trust.",
    "",
    `Wallet: ${getAddress(address)}`,
    `Purpose: quietpay/vault-encryption`,
    `Version: ${VAULT_VERSION}`,
  ].join("\n");
}

export async function deriveVaultKey(signature: Hex, address: Address): Promise<CryptoKey> {
  const sig = hexToBytes(signature);
  if (sig.length < 64) throw new Error("Unexpected signature length.");
  const ikm = await subtle().importKey("raw", buf(sig), "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buf(te.encode("quietpay/vault/v1")),
      info: buf(te.encode(`aes-256-gcm|${getAddress(address).toLowerCase()}`)),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface Sealed {
  v: number;
  alg: "AES-256-GCM";
  iv: string;
  ct: string;
}

export async function seal(key: CryptoKey, data: unknown, aad: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const pt = te.encode(JSON.stringify(data));
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(te.encode(aad)) }, key, buf(pt)),
  );
  return { v: VAULT_VERSION, alg: "AES-256-GCM", iv: b64(iv), ct: b64(ct) };
}

export class DecryptionError extends Error {
  constructor(message = "Could not decrypt. The key, passphrase or file is wrong, or the data was altered.") {
    super(message);
    this.name = "DecryptionError";
  }
}

export async function open<T = unknown>(key: CryptoKey, sealed: Sealed, aad: string): Promise<T> {
  if (sealed?.alg !== "AES-256-GCM" || sealed.v !== VAULT_VERSION) throw new DecryptionError("Unsupported format.");
  try {
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: buf(unb64(sealed.iv)), additionalData: buf(te.encode(aad)) },
      key,
      buf(unb64(sealed.ct)),
    );
    return JSON.parse(td.decode(pt)) as T;
  } catch {
    throw new DecryptionError();
  }
}

export function vaultAad(address: Address) {
  return `quietpay/vault/v${VAULT_VERSION}|${getAddress(address).toLowerCase()}`;
}

/* ---------------- Backups ---------------- */

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  v: number;
  createdAt: string;
  kdf: { name: "PBKDF2-SHA256"; iterations: number; salt: string };
  sealed: Sealed;
}

async function passphraseKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", buf(te.encode(passphrase.normalize("NFKC"))), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function checkPassphrase(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  return null;
}

const BACKUP_AAD = "quietpay/backup/v1";

export async function createBackup(data: unknown, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<BackupFile> {
  const err = checkPassphrase(passphrase);
  if (err) throw new Error(err);
  const salt = randomBytes(16);
  const key = await passphraseKey(passphrase, salt, iterations);
  return {
    format: BACKUP_FORMAT,
    v: 1,
    createdAt: new Date().toISOString(),
    kdf: { name: "PBKDF2-SHA256", iterations, salt: b64(salt) },
    sealed: await seal(key, data, BACKUP_AAD),
  };
}

export async function restoreBackup<T = unknown>(file: unknown, passphrase: string): Promise<T> {
  const f = file as BackupFile;
  if (!f || f.format !== BACKUP_FORMAT || f.v !== 1 || f.kdf?.name !== "PBKDF2-SHA256") {
    throw new DecryptionError("This is not a QuietPay backup file.");
  }
  if (!Number.isInteger(f.kdf.iterations) || f.kdf.iterations < 100_000 || f.kdf.iterations > 10_000_000) {
    throw new DecryptionError("Backup uses unsupported key-derivation settings.");
  }
  const key = await passphraseKey(passphrase, unb64(f.kdf.salt), f.kdf.iterations);
  return open<T>(key, f.sealed, BACKUP_AAD);
}
