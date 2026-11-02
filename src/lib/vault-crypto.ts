/**
 * Client-side encryption for stealth keys (Web Crypto only).
 *
 * Vault key: HKDF-SHA256 over a wallet signature of a fixed Sign-In with Ethereum message bound
 *   to www.quietpay.sbs (buildVaultMessage), salt "quietpay/vault/v1", info "aes-256-gcm|<address>".
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
import { createSiweMessage } from "viem/siwe";
import { ROBINHOOD_MAINNET_ID } from "@/config/networks";

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
 * The host the vault message is bound to: the site's primary domain on Vercel (quietpay.sbs and
 * the vercel.app address redirect here). Wallets compare it with the page's host exactly, so it
 * must stay the primary domain. Changing it changes every user's keys, so it is a constant.
 */
export const VAULT_DOMAIN = "www.quietpay.sbs";

/**
 * The exact message a wallet signs to unlock the vault: a Sign-In with Ethereum (EIP-4361)
 * message bound to VAULT_DOMAIN (www.quietpay.sbs). Wallets that check SIWE domains (MetaMask, Rabby, Coinbase
 * Wallet and others) warn when any other site asks for it, which is the main defence against a
 * phishing site collecting the signature that recreates every QuietPay key.
 *
 * Every field is fixed (nonce and issue time included) so the signature is the same each time;
 * that is what makes the keys reproducible. It authorizes nothing onchain.
 */
export function buildVaultMessage(address: Address): string {
  return createSiweMessage({
    domain: VAULT_DOMAIN,
    address: getAddress(address),
    statement:
      "Unlock QuietPay. This signature recreates your QuietPay payment keys on any device. It does not send a transaction or cost gas. Only sign it on quietpay.sbs.",
    uri: `https://${VAULT_DOMAIN}`,
    version: "1",
    chainId: ROBINHOOD_MAINNET_ID,
    nonce: "quietpaykeys2",
    issuedAt: new Date("2026-11-02T00:00:00.000Z"),
    resources: [`https://${VAULT_DOMAIN}/security`],
  });
}

/**
 * The message used before 2 November 2026. Only asked for, on QuietPay, to move a name
 * reservation made with it to the current keys. Never used to derive payment keys.
 */
export function buildLegacyVaultMessage(address: Address): string {
  return [
    "QuietPay keys",
    "",
    "Sign to unlock QuietPay. This signature recreates your QuietPay payment keys on any device.",
    "It does not send a transaction or cost gas.",
    "Treat it like a password: only sign this message on QuietPay's own website.",
    "",
    `Wallet: ${getAddress(address)}`,
    `Purpose: quietpay/vault-encryption`,
    `Version: 1`,
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

/**
 * Encrypts `data` (as JSON) with AES-256-GCM. Every call draws a fresh random 96-bit nonce from
 * the platform CSPRNG; with a vault saved at most a few thousand times per key (and keys rotated),
 * the chance of ever repeating a nonce under one key is negligible (birthday bound ~2^-64 at 2^16
 * saves). `aad` binds the ciphertext to its purpose, address, format version and key id.
 */
export async function seal(key: CryptoKey, data: unknown, aad: string, version = VAULT_VERSION): Promise<Sealed> {
  const iv = randomBytes(12);
  const pt = te.encode(JSON.stringify(data));
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(te.encode(aad)) }, key, buf(pt)),
  );
  return { v: version, alg: "AES-256-GCM", iv: b64(iv), ct: b64(ct) };
}

export class DecryptionError extends Error {
  constructor(message = "Could not decrypt. The key is wrong or the data was altered.") {
    super(message);
    this.name = "DecryptionError";
  }
}

/**
 * Decrypts and authenticates. AES-GCM checks the tag before returning anything, so a wrong key or
 * a single altered byte throws DecryptionError and no partial plaintext is ever returned.
 */
export async function open<T = unknown>(key: CryptoKey, sealed: Sealed, aad: string, version = VAULT_VERSION): Promise<T> {
  if (sealed?.alg !== "AES-256-GCM" || sealed.v !== version) throw new DecryptionError("Unsupported format.");
  if (typeof sealed.iv !== "string" || typeof sealed.ct !== "string" || sealed.ct.length > 8_000_000) throw new DecryptionError("Unsupported format.");
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

/* ---------------- Vault format v2: a random data key, wrapped by the signature key ---------------- */

/**
 * v2 encrypts the vault with a random 256-bit data key (DEK). The DEK is stored only wrapped
 * (AES-256-GCM) by the key derived from the wallet signature (the KEK, deriveVaultKey). So:
 *  - the signature-derived key is never kept anywhere; "stay signed in" keeps only the DEK, as a
 *    non-extractable CryptoKey;
 *  - the DEK can be rotated (a new one wrapped by the same KEK) without a new message or any
 *    change to the user's payment keys, which are derived separately from the signature;
 *  - a DEK that was kept on a device stops opening the vault once it is rotated.
 */
export const VAULT_V2 = 2;

export interface WrappedKey {
  iv: string;
  ct: string;
}

/** A random 64-bit key id, bound into every v2 ciphertext's associated data. */
export function newKeyId(): string {
  return [...randomBytes(8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const dekAad = (address: Address, kid: string) => `quietpay/vault-dek/v2|${getAddress(address).toLowerCase()}|${kid}`;
export const vaultAadV2 = (address: Address, kid: string) => `quietpay/vault/v2|${getAddress(address).toLowerCase()}|${kid}`;

const importDek = (raw: Uint8Array) => subtle().importKey("raw", buf(raw), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

/** A new data key: the usable (non-extractable) key and its wrapped form for storage. */
export async function newDataKey(kek: CryptoKey, address: Address): Promise<{ dek: CryptoKey; wrapped: WrappedKey; kid: string }> {
  const raw = randomBytes(32);
  const kid = newKeyId();
  try {
    const iv = randomBytes(12);
    const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(te.encode(dekAad(address, kid))) }, kek, buf(raw)));
    return { dek: await importDek(raw), wrapped: { iv: b64(iv), ct: b64(ct) }, kid };
  } finally {
    raw.fill(0);
  }
}

/** Unwraps a stored data key with the signature key. Throws DecryptionError if it doesn't match. */
export async function unwrapDataKey(kek: CryptoKey, wrapped: WrappedKey, address: Address, kid: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv: buf(unb64(wrapped.iv)), additionalData: buf(te.encode(dekAad(address, kid))) }, kek, buf(unb64(wrapped.ct))),
    );
  } catch {
    throw new DecryptionError();
  }
  if (raw.length !== 32) throw new DecryptionError("Unsupported format.");
  try {
    return await importDek(raw);
  } finally {
    raw.fill(0);
  }
}
