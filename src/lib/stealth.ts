/**
 * ERC-5564 scheme 1 (secp256k1) helpers.
 *
 * All cryptography comes from @scopelift/stealth-address-sdk. Robinhood Chain is not in the
 * SDK's chain configuration, so only its chain-agnostic crypto utilities are used here; the
 * scheme itself is not modified.
 */
import {
  VALID_SCHEME_ID,
  checkStealthAddress,
  computeStealthKey,
  generateRandomStealthMetaAddress,
  generateStealthAddress,
} from "@scopelift/stealth-address-sdk";
import { ProjectivePoint } from "@noble/secp256k1";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

export const SCHEME_ID = VALID_SCHEME_ID.SCHEME_ID_1;

export interface RequestKeys {
  spendingPrivateKey: Hex;
  viewingPrivateKey: Hex;
  spendingPublicKey: Hex;
  viewingPublicKey: Hex;
  /** 66-byte meta-address: spending pubkey || viewing pubkey (both compressed). */
  stealthMetaAddress: Hex;
}

/** Generates a fresh, independent key pair set for a single payment request. */
export function createRequestKeys(): RequestKeys {
  const k = generateRandomStealthMetaAddress();
  return {
    spendingPrivateKey: k.spendingPrivateKey as Hex,
    viewingPrivateKey: k.viewingPrivateKey as Hex,
    spendingPublicKey: k.spendingPublicKey as Hex,
    viewingPublicKey: k.viewingPublicKey as Hex,
    stealthMetaAddress: k.stealthMetaAddress as Hex,
  };
}

export function isValidCompressedPoint(hex: string): boolean {
  if (!/^0x0[23][0-9a-fA-F]{64}$/.test(hex)) return false;
  try {
    ProjectivePoint.fromHex(hex.slice(2)).assertValidity();
    return true;
  } catch {
    return false;
  }
}

export interface StealthDerivation {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: Hex;
}

/** Payer side: derive a one-time stealth address from the recipient's meta-address. */
export function deriveStealthPayment(stealthMetaAddress: Hex): StealthDerivation {
  const r = generateStealthAddress({
    stealthMetaAddressURI: `st:eth:${stealthMetaAddress}`,
    schemeId: SCHEME_ID,
  });
  return {
    stealthAddress: getAddress(r.stealthAddress),
    ephemeralPublicKey: r.ephemeralPublicKey as Hex,
    viewTag: r.viewTag.toLowerCase() as Hex,
  };
}

/** Recipient side: does this announcement belong to these keys? Runs entirely locally. */
export function announcementMatches(
  ann: { stealthAddress: Address; ephemeralPubKey: Hex; metadata: Hex },
  keys: Pick<RequestKeys, "spendingPublicKey" | "viewingPrivateKey">,
): boolean {
  if (!ann.metadata || ann.metadata.length < 4) return false;
  if (!isValidCompressedPoint(ann.ephemeralPubKey)) return false;
  const viewTag = `0x${ann.metadata.slice(2, 4).toLowerCase()}` as Hex;
  try {
    return checkStealthAddress({
      ephemeralPublicKey: ann.ephemeralPubKey,
      spendingPublicKey: keys.spendingPublicKey,
      userStealthAddress: ann.stealthAddress,
      viewingPrivateKey: keys.viewingPrivateKey,
      viewTag,
      schemeId: SCHEME_ID,
    });
  } catch {
    return false;
  }
}

/**
 * Recipient side: derive the private key controlling a stealth address.
 * Throws if the derived key does not control the expected address.
 */
export function deriveStealthPrivateKey(
  ephemeralPublicKey: Hex,
  expectedAddress: Address,
  keys: Pick<RequestKeys, "spendingPrivateKey" | "viewingPrivateKey">,
): Hex {
  const key = computeStealthKey({
    ephemeralPublicKey,
    spendingPrivateKey: keys.spendingPrivateKey,
    viewingPrivateKey: keys.viewingPrivateKey,
    schemeId: SCHEME_ID,
  }) as Hex;
  if (getAddress(privateKeyToAddress(key)) !== getAddress(expectedAddress)) {
    throw new Error("Derived stealth key does not control the expected address.");
  }
  return key;
}
