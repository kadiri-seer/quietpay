/**
 * Wallet-derived payment link keys.
 *
 * Every link's stealth keys come from one seed, and the seed comes from the deterministic wallet
 * signature that unlocks the vault (HKDF-SHA256, its own salt and label). Link n always gets the
 * same keys on the same chain, so connecting the same wallet on any device can find every paid link again by
 * scanning public announcements. No backup file is needed.
 *
 * Each link still has its own spending and viewing keys, so two links can't be tied together
 * by comparing them.
 */
import { getPublicKey } from "@noble/secp256k1";
import { bytesToHex, getAddress, hexToBytes, type Address, type Hex } from "viem";
import type { RequestKeys } from "./stealth";

const te = new TextEncoder();
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Links beyond the last one found that recovery still checks, in case some were never paid. */
export const RECOVERY_GAP = 20;

async function hkdf(ikm: Uint8Array, salt: string, info: string, bits: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(te.encode(salt)), info: buf(te.encode(info)) }, key, bits));
}

/** 32-byte seed for all of a wallet's link keys. Domain-separated from the vault, pool and name keys. */
export async function deriveLinkSeed(signature: Hex, address: Address): Promise<Hex> {
  return bytesToHex(await hkdf(hexToBytes(signature), "quietpay/links/v1", `link-seed|${getAddress(address).toLowerCase()}`, 256));
}

async function scalar(seed: Hex, label: string): Promise<Hex> {
  // 384 bits reduced mod n keeps the bias negligible; +1 avoids zero.
  const out = await hkdf(hexToBytes(seed), "quietpay/links/v1/key", label, 384);
  let n = 0n;
  for (const b of out) n = (n << 8n) | BigInt(b);
  return `0x${((n % (SECP256K1_N - 1n)) + 1n).toString(16).padStart(64, "0")}`;
}

/**
 * Spending and viewing keys for link number `index` (0, 1, 2...) on chain `chainId`. The chain is
 * part of the derivation, so link 3 on testnet and link 3 on mainnet have unrelated keys and can't
 * be tied together.
 */
export async function deriveLinkKeys(seed: Hex, chainId: number, index: number): Promise<RequestKeys> {
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid link index.");
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("Invalid chain.");
  const spendingPrivateKey = await scalar(seed, `spend|${chainId}|${index}`);
  const viewingPrivateKey = await scalar(seed, `view|${chainId}|${index}`);
  const spendingPublicKey = bytesToHex(getPublicKey(spendingPrivateKey.slice(2), true));
  const viewingPublicKey = bytesToHex(getPublicKey(viewingPrivateKey.slice(2), true));
  return {
    spendingPrivateKey,
    viewingPrivateKey,
    spendingPublicKey,
    viewingPublicKey,
    stealthMetaAddress: `0x${spendingPublicKey.slice(2)}${viewingPublicKey.slice(2)}`,
  };
}

/**
 * Link keys as derived before 2 November 2026 (no chain in the label), from the seed of the old
 * sign-in message. Only used to find funds sent to links made back then.
 */
export async function deriveLinkKeysLegacy(seed: Hex, index: number): Promise<RequestKeys> {
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid link index.");
  const spendingPrivateKey = await scalar(seed, `spend|${index}`);
  const viewingPrivateKey = await scalar(seed, `view|${index}`);
  const spendingPublicKey = bytesToHex(getPublicKey(spendingPrivateKey.slice(2), true));
  const viewingPublicKey = bytesToHex(getPublicKey(viewingPrivateKey.slice(2), true));
  return {
    spendingPrivateKey,
    viewingPrivateKey,
    spendingPublicKey,
    viewingPublicKey,
    stealthMetaAddress: `0x${spendingPublicKey.slice(2)}${viewingPublicKey.slice(2)}`,
  };
}
