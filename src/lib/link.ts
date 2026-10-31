/**
 * Payment link encoding (v1).
 *
 * Binary layout, then base64url (no padding):
 *   [0]        version            uint8   (= 1)
 *   [1..4]     chainId            uint32  big-endian
 *   [5..24]    token              20 bytes
 *   [25..40]   amount             uint128 big-endian, token base units
 *   [41..45]   expiresAt          uint40  big-endian, unix seconds
 *   [46..61]   requestId          16 random bytes
 *   [62..127]  stealthMetaAddress 66 bytes (33-byte compressed spending key || 33-byte viewing key)
 *   [128..131] checksum           first 4 bytes of keccak256(bytes[0..127])
 * Total 132 bytes -> 176 characters.
 *
 * The link carries public data only. It never contains private keys or viewing secrets.
 * The code is placed in the URL fragment (/pay#<code>) so it is not sent to the web server.
 */
import { bytesToHex, getAddress, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { z } from "zod";
import { CLOCK_SKEW_SECONDS, MAX_EXPIRY_SECONDS, NETWORKS, networkForChainId, type NetworkConfig, type NetworkKey } from "@/config/networks";
import { isValidCompressedPoint } from "./stealth";

export const LINK_VERSION = 1;
const LENGTH = 132;
const BODY = 128;
const MAX_U128 = (1n << 128n) - 1n;
const MAX_U40 = (1n << 40n) - 1n;

export interface PaymentRequestLink {
  version: number;
  chainId: number;
  token: Address;
  amount: bigint;
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

export const linkSchema = z.object({
  version: z.literal(LINK_VERSION),
  chainId: z.number().int().positive().max(0xffffffff),
  token: hexBytes(20),
  amount: z.bigint().positive().max(MAX_U128),
  expiresAt: z.number().int().positive(),
  requestId: hexBytes(16),
  stealthMetaAddress: hexBytes(66),
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

export function encodePaymentLink(req: PaymentRequestLink): string {
  const parsed = linkSchema.safeParse(req);
  if (!parsed.success) throw new LinkError(`Invalid payment request: ${parsed.error.issues[0]?.message}`);
  if (BigInt(req.expiresAt) > MAX_U40) throw new LinkError("Expiry out of range.");
  const buf = new Uint8Array(LENGTH);
  buf[0] = req.version;
  writeUint(buf, 1, 4, BigInt(req.chainId));
  buf.set(hexToBytes(req.token), 5);
  writeUint(buf, 25, 16, req.amount);
  writeUint(buf, 41, 5, BigInt(req.expiresAt));
  buf.set(hexToBytes(req.requestId), 46);
  buf.set(hexToBytes(req.stealthMetaAddress), 62);
  const checksum = hexToBytes(keccak256(buf.subarray(0, BODY))).subarray(0, 4);
  buf.set(checksum, BODY);
  return toBase64Url(buf);
}

/** Decodes the binary structure only. Use validatePaymentLink for policy checks. */
export function decodePaymentLink(code: string): PaymentRequestLink {
  const trimmed = code.trim();
  if (trimmed.length === 0) throw new LinkError("This link is empty.");
  if (trimmed.length > 400) throw new LinkError("This link is too long to be a QuietPay link.");
  const buf = fromBase64Url(trimmed);
  if (buf.length !== LENGTH) throw new LinkError("This link is incomplete or was copied incorrectly.");
  if (buf[0] !== LINK_VERSION) throw new LinkError(`Unsupported link version ${buf[0]}.`);
  const expected = hexToBytes(keccak256(buf.subarray(0, BODY))).subarray(0, 4);
  const actual = buf.subarray(BODY);
  if (!expected.every((b, i) => b === actual[i])) {
    throw new LinkError("This link is damaged (checksum mismatch). Ask the recipient to share it again.");
  }
  const req: PaymentRequestLink = {
    version: buf[0],
    chainId: Number(readUint(buf, 1, 4)),
    token: getAddress(bytesToHex(buf.subarray(5, 25))),
    amount: readUint(buf, 25, 16),
    expiresAt: Number(readUint(buf, 41, 5)),
    requestId: bytesToHex(buf.subarray(46, 62)),
    stealthMetaAddress: bytesToHex(buf.subarray(62, 128)),
  };
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
 * known + enabled chain, allowlisted token for that chain, unexpired, sane expiry window,
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
  if (request.expiresAt <= now) throw new LinkError("This payment link has expired.");
  if (request.expiresAt > now + MAX_EXPIRY_SECONDS + CLOCK_SKEW_SECONDS) {
    throw new LinkError("This link's expiry is further out than QuietPay allows.");
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
