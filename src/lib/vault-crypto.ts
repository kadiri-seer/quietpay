/**
 * Client-side encryption for stealth keys (Web Crypto only).
 *
 * Vault key: HKDF-SHA256 over a wallet signature of a domain-separated message
 *   (buildVaultMessage), salt "quietpay/vault/v1", info "aes-256-gcm|<address>".
 *   The resulting AES-256-GCM key is non-extractable and lives in memory, or, if the user chooses
 *   to stay signed in, in IndexedDB (src/lib/remember.ts), where it can be used but not read out.
 *   The signature itself is never stored.
 *
 * There are no backup files: every key in the vault can be re-derived from the same wallet
 * signature (see src/lib/link-keys.ts), so the vault is only a local, encrypted cache.
 *
 * Every ciphertext binds associated data (purpose + address), so a blob cannot be swapped
 * between wallets without failing authentication.
 */
import { getAddress, hexToBytes, type Address, type Hex } from "viem";

export const VAULT_VERSION = 1;

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
    "QuietPay keys",
    "",
    "Sign to unlock QuietPay. This signature recreates your QuietPay payment keys on any device.",
    "It does not send a transaction or cost gas.",
    "Treat it like a password: only sign this message on QuietPay's own website.",
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
  constructor(message = "Could not decrypt. The key is wrong or the data was altered.") {
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
