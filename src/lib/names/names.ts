/**
 * The link key: a secp256k1 key derived in the browser from the same wallet signature that unlocks
 * the vault (separate derivation), never the wallet itself. It signs the pool locks behind your
 * personal link, and the link names its address, so a payer can check a lock really is yours.
 *
 * (QuietPay once had usernames; they were removed for privacy. The key keeps its original
 * derivation labels so existing personal links keep working.)
 */
import { getAddress, hexToBytes, type Address, type Hex } from "viem";

const te = new TextEncoder();
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The browser's link key, derived from the vault signature with its own salt and label. */
export async function deriveNameKey(signature: Hex, address: Address): Promise<Hex> {
  const ikm = await crypto.subtle.importKey("raw", buf(hexToBytes(signature)), "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: buf(te.encode("quietpay/names/v1")), info: buf(te.encode(`name-key|${getAddress(address).toLowerCase()}`)) },
      ikm,
      384,
    ),
  );
  let n = 0n;
  for (const b of bits) n = (n << 8n) | BigInt(b);
  const k = (n % (SECP256K1_N - 1n)) + 1n; // uniform enough over 384 bits, never zero
  return `0x${k.toString(16).padStart(64, "0")}`;
}

/** An error with an HTTP status, shown to the user as is. */
export class ReservationError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "ReservationError";
  }
}
