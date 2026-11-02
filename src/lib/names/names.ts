/**
 * QuietPay name reservations (waitlist for pay-by-username).
 *
 * A reservation is signed by a "name key": a secp256k1 key derived in the browser from the same
 * wallet signature that unlocks the vault (separate derivation), never the wallet itself. The
 * server stores only the name, the name key's address and the time, so the waitlist never links
 * a username to a wallet.
 */
import { getAddress, hexToBytes, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const NAME_MIN = 3;
export const NAME_MAX = 20;
/** How long a signed reservation stays valid, to stop old signatures being replayed. */
export const MAX_SIGNATURE_AGE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 2 * 60 * 1000;

/** Names nobody can reserve: QuietPay itself, roles people could impersonate, and big brands. */
const RESERVED = new Set([
  "admin", "administrator", "root", "system", "support", "help", "helpdesk", "security", "official", "team", "staff", "mod",
  "moderator", "owner", "founder", "ceo", "dev", "developer", "api", "app", "www", "mail", "email", "info", "contact", "billing",
  "payments", "pay", "wallet", "relayer", "approver", "pool", "faucet", "test", "null", "undefined", "anonymous", "everyone",
  "quietpay", "quiet_pay", "quietpayapp", "quietpay_support", "robinhood", "robinhoodchain", "paxos", "usdg", "ethereum", "eth",
  "bitcoin", "btc", "arbitrum", "metamask", "walletconnect", "reown", "coinbase", "binance", "tether", "usdt", "usdc", "circle",
  "vercel", "google", "apple", "microsoft", "twitter", "x", "meta", "facebook", "instagram", "openai", "anthropic", "0xbow",
  "privacypools", "tornado", "tornadocash",
]);
/** Substrings that make a name unavailable (impersonation and abuse). */
const BLOCKED_PARTS = ["quietpay", "robinhood", "admin", "support", "official", "nigger", "nigga", "faggot", "rape", "nazi", "hitler"];

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

/** Lowercases, strips a leading @, and checks the rules. */
export function checkName(input: string): NameCheck {
  const name = input.trim().replace(/^@+/, "").toLowerCase();
  if (name.length < NAME_MIN) return { ok: false, reason: `Use at least ${NAME_MIN} characters.` };
  if (name.length > NAME_MAX) return { ok: false, reason: `Use at most ${NAME_MAX} characters.` };
  if (!/^[a-z0-9_]+$/.test(name)) return { ok: false, reason: "Use only letters, numbers and underscores." };
  if (/^_|_$/.test(name) || name.includes("__")) return { ok: false, reason: "Underscores can't start, end or repeat." };
  if (/^\d+$/.test(name)) return { ok: false, reason: "Include at least one letter." };
  if (/^0x[0-9a-f]*$/.test(name)) return { ok: false, reason: "Names can't look like an address." };
  if (RESERVED.has(name) || BLOCKED_PARTS.some((b) => name.includes(b))) return { ok: false, reason: "That name isn't available." };
  return { ok: true, name };
}

export interface ReservationRequest {
  action: "reserve" | "release";
  name: string;
  key: Address;
  issuedAt: string; // ISO time
  signature: Hex;
}

/** The exact text the name key signs. Domain-separated and human-readable. */
export function reservationMessage(p: { action: "reserve" | "release"; name: string; key: Address; issuedAt: string }): string {
  return [
    p.action === "reserve" ? "QuietPay name reservation" : "QuietPay name release",
    `Name: @${p.name}`,
    `Key: ${getAddress(p.key)}`,
    `Issued: ${p.issuedAt}`,
  ].join("\n");
}

const te = new TextEncoder();
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The browser's name key, derived from the vault signature with its own salt and label. */
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

export async function signReservation(nameKey: Hex, action: "reserve" | "release", name: string, now = new Date()): Promise<ReservationRequest> {
  const account = privateKeyToAccount(nameKey);
  const issuedAt = now.toISOString();
  const message = reservationMessage({ action, name, key: account.address, issuedAt });
  return { action, name, key: account.address, issuedAt, signature: await account.signMessage({ message }) };
}

export class ReservationError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "ReservationError";
  }
}

/** Validates shape, name rules, freshness and the signature. Returns the normalised request. */
export async function verifyReservation(raw: unknown, nowMs = Date.now()): Promise<ReservationRequest> {
  const r = raw as Partial<ReservationRequest> | null;
  if (!r || typeof r !== "object") throw new ReservationError("Malformed request.");
  if (r.action !== "reserve" && r.action !== "release") throw new ReservationError("Unknown action.");
  if (typeof r.name !== "string" || typeof r.issuedAt !== "string" || typeof r.signature !== "string" || typeof r.key !== "string")
    throw new ReservationError("Malformed request.");
  if (!isAddress(r.key, { strict: false }) || !/^0x[0-9a-fA-F]{130}$/.test(r.signature)) throw new ReservationError("Malformed request.");
  const check = checkName(r.name);
  if (!check.ok) throw new ReservationError(check.reason);
  if (check.name !== r.name) throw new ReservationError("Malformed request.");
  const issued = Date.parse(r.issuedAt);
  if (!Number.isFinite(issued) || new Date(issued).toISOString() !== r.issuedAt) throw new ReservationError("Malformed request.");
  if (issued > nowMs + CLOCK_SKEW_MS || nowMs - issued > MAX_SIGNATURE_AGE_MS)
    throw new ReservationError("This request has expired. Check your device's clock and try again.");
  const key = getAddress(r.key);
  const message = reservationMessage({ action: r.action, name: r.name, key, issuedAt: r.issuedAt });
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message, signature: r.signature as Hex });
  } catch {
    throw new ReservationError("Invalid signature.");
  }
  if (signer !== key) throw new ReservationError("Invalid signature.");
  return { action: r.action, name: r.name, key, issuedAt: r.issuedAt, signature: r.signature as Hex };
}
