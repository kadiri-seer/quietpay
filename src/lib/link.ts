/**
 * Payment link encoding.
 *
 * v2 (current), base64url of 133 bytes:
 *   [0]        version            uint8   (= 2)
 *   [1]        flags              bit 0 = open amount (payer chooses; amount field is 0)
 *   [2..5]     chainId            uint32  big-endian
 *   [6..25]    token              20 bytes
 *   [26..41]   amount             uint128 big-endian, token base units (0 for open links)
 *   [42..46]   expiresAt          uint40  big-endian, unix seconds (0 = never expires)
 *   [47..62]   requestId          16 random bytes
 *   [63..128]  stealthMetaAddress 66 bytes (33-byte compressed spending key || 33-byte viewing key)
 *   [129..132] checksum           first 4 bytes of keccak256(bytes[0..128])
 *
 * v1 (still accepted): fixed amount only, 132 bytes, same fields without the flags byte.
 *
 * Links carry public data only, never private keys or viewing secrets. The code lives in the URL
 * fragment (/pay#<code>) so it is not sent to the web server.
 */
import { bytesToHex, getAddress, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { z } from "zod";
import {
  CLOCK_SKEW_SECONDS,
  MAX_EXPIRY_SECONDS,
  MAX_OPEN_EXPIRY_SECONDS,
  NETWORKS,
  networkForChainId,
  type NetworkConfig,
  type NetworkKey,
} from "@/config/networks";
import { isValidCompressedPoint } from "./stealth";

export const LINK_VERSION = 2;
const FLAG_OPEN = 0x01;
const MAX_U128 = (1n << 128n) - 1n;
const MAX_U40 = (1n << 40n) - 1n;

export type LinkKind = "fixed" | "open";

export interface PaymentRequestLink {
  version: number;
  kind: LinkKind;
  chainId: number;
  token: Address;
  /** Base units. 0n for open links, where the payer chooses. */
  amount: bigint;
  /** Unix seconds. 0 means the link never expires (open links only). */
  expiresAt: number;
  requestId: Hex; // 16 bytes
  stealthMetaAddress: Hex; // 66 bytes
}

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

const hexBytes = (len: number) =>
  z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${len * 2}}$`), `Expected ${len} bytes of hex`);

export const linkSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    kind: z.enum(["fixed", "open"]),
    chainId: z.number().int().positive().max(0xffffffff),
    token: hexBytes(20),
    amount: z.bigint().min(0n).max(MAX_U128),
    expiresAt: z.number().int().min(0),
    requestId: hexBytes(16),
    stealthMetaAddress: hexBytes(66),
  })
  .refine((r) => (r.kind === "fixed" ? r.amount > 0n && r.expiresAt > 0 : r.amount === 0n), {
    message: "Fixed links need an amount and expiry; open links carry no amount.",
  });

function writeUint(target: Uint8Array, offset: number, size: number, value: bigint) {
  let v = value;
  for (let i = size - 1; i >= 0; i--) {
    target[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new LinkError("Value does not fit.");
}

function readUint(source: Uint8Array, offset: number, size: number): bigint {
  let v = 0n;
  for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(source[offset + i]);
  return v;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new LinkError("Link contains invalid characters.");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function checksum(body: Uint8Array) {
  return hexToBytes(keccak256(body)).subarray(0, 4);
}

/** Encodes a link in the current (v2) format. */
export function encodePaymentLink(req: Omit<PaymentRequestLink, "version"> & { version?: number }): string {
  const full = { ...req, version: LINK_VERSION };
  const parsed = linkSchema.safeParse(full);
  if (!parsed.success) throw new LinkError(`Invalid payment request: ${parsed.error.issues[0]?.message}`);
  if (BigInt(req.expiresAt) > MAX_U40) throw new LinkError("Expiry out of range.");
  const buf = new Uint8Array(133);
  buf[0] = LINK_VERSION;
  buf[1] = req.kind === "open" ? FLAG_OPEN : 0;
  writeUint(buf, 2, 4, BigInt(req.chainId));
  buf.set(hexToBytes(req.token), 6);
  writeUint(buf, 26, 16, req.amount);
  writeUint(buf, 42, 5, BigInt(req.expiresAt));
  buf.set(hexToBytes(req.requestId), 47);
  buf.set(hexToBytes(req.stealthMetaAddress), 63);
  buf.set(checksum(buf.subarray(0, 129)), 129);
  return toBase64Url(buf);
}

/** Decodes the binary structure only (v1 or v2). Use validatePaymentLink for policy checks. */
export function decodePaymentLink(code: string): PaymentRequestLink {
  const trimmed = code.trim();
  if (trimmed.length === 0) throw new LinkError("This link is empty.");
  if (trimmed.length > 400) throw new LinkError("This link is too long to be a QuietPay link.");
  const buf = fromBase64Url(trimmed);
  const version = buf[0];
  let req: PaymentRequestLink;
  if (version === 1) {
    if (buf.length !== 132) throw new LinkError("This link is incomplete or was copied incorrectly.");
    if (!checksum(buf.subarray(0, 128)).every((b, i) => b === buf[128 + i])) {
      throw new LinkError("This link is damaged (checksum mismatch). Ask the recipient to share it again.");
    }
    req = {
      version: 1,
      kind: "fixed",
      chainId: Number(readUint(buf, 1, 4)),
      token: getAddress(bytesToHex(buf.subarray(5, 25))),
      amount: readUint(buf, 25, 16),
      expiresAt: Number(readUint(buf, 41, 5)),
      requestId: bytesToHex(buf.subarray(46, 62)),
      stealthMetaAddress: bytesToHex(buf.subarray(62, 128)),
    };
  } else if (version === 2) {
    if (buf.length !== 133) throw new LinkError("This link is incomplete or was copied incorrectly.");
    if (!checksum(buf.subarray(0, 129)).every((b, i) => b === buf[129 + i])) {
      throw new LinkError("This link is damaged (checksum mismatch). Ask the recipient to share it again.");
    }
    if ((buf[1] & ~FLAG_OPEN) !== 0) throw new LinkError("This link uses features this version of QuietPay doesn't support.");
    req = {
      version: 2,
      kind: buf[1] & FLAG_OPEN ? "open" : "fixed",
      chainId: Number(readUint(buf, 2, 4)),
      token: getAddress(bytesToHex(buf.subarray(6, 26))),
      amount: readUint(buf, 26, 16),
      expiresAt: Number(readUint(buf, 42, 5)),
      requestId: bytesToHex(buf.subarray(47, 63)),
      stealthMetaAddress: bytesToHex(buf.subarray(63, 129)),
    };
  } else if (buf.length === 0) {
    throw new LinkError("This link is empty.");
  } else {
    throw new LinkError(`Unsupported link version ${version}.`);
  }
  const parsed = linkSchema.safeParse(req);
  if (!parsed.success) throw new LinkError(`Invalid link: ${parsed.error.issues[0]?.message}`);
  return req;
}

export interface LinkValidation {
  request: PaymentRequestLink;
  network: NetworkConfig;
}

/**
 * Policy validation, done before any wallet connection:
 * known + enabled chain, allowlisted token for that chain, expiry rules for the link kind,
 * non-zero request ID, and both meta-address keys are valid secp256k1 points.
 */
export function validatePaymentLink(
  code: string,
  opts: { nowSeconds?: number; networks?: Record<NetworkKey, NetworkConfig> } = {},
): LinkValidation {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const networks = opts.networks ?? NETWORKS;
  const request = decodePaymentLink(code);
  const network = networkForChainId(request.chainId, networks);
  if (!network) {
    const known = Object.values(networks).find((n) => n.chain.id === request.chainId);
    throw new LinkError(
      known
        ? `This link is for ${known.label}, which is disabled in this QuietPay deployment.`
        : `This link is for an unsupported network (chain ID ${request.chainId}).`,
    );
  }
  if (!network.token) throw new LinkError(`No payment token is configured for ${network.label}.`);
  if (getAddress(request.token) !== getAddress(network.token)) {
    throw new LinkError("This link asks for a token that QuietPay does not accept. Do not pay it.");
  }
  const maxWindow = request.kind === "fixed" ? MAX_EXPIRY_SECONDS : MAX_OPEN_EXPIRY_SECONDS;
  if (request.expiresAt !== 0) {
    if (request.expiresAt <= now) throw new LinkError("This payment link has expired.");
    if (request.expiresAt > now + maxWindow + CLOCK_SKEW_SECONDS) {
      throw new LinkError("This link's expiry is further out than QuietPay allows.");
    }
  }
  if (/^0x0+$/.test(request.requestId)) throw new LinkError("This link has an invalid request ID.");
  const meta = request.stealthMetaAddress.slice(2);
  if (!isValidCompressedPoint(`0x${meta.slice(0, 66)}`) || !isValidCompressedPoint(`0x${meta.slice(66)}`)) {
    throw new LinkError("This link's receiving keys are invalid.");
  }
  return { request, network };
}

export function buildPayUrl(origin: string, code: string): string {
  return `${origin.replace(/\/$/, "")}/pay#${code}`;
}

/** Extracts a link code from a full URL, a "#code" fragment, or a bare code. */
export function extractLinkCode(input: string): string {
  const s = input.trim();
  const hash = s.indexOf("#");
  return hash >= 0 ? s.slice(hash + 1) : s;
}
