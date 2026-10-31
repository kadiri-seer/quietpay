/**
 * ERC-5564 announcement metadata.
 *
 * Bytes 0..56 follow the ERC-5564 recommendation (built with the SDK):
 *   [0]      view tag
 *   [1..4]   function selector (ERC-20 transfer, 0xa9059cbb)
 *   [5..24]  token address
 *   [25..56] amount (uint256)
 * QuietPay appends:
 *   [57..59] magic "QP" + version 0x01
 *   [60..75] request ID (16 bytes, random, also in the payment link)
 *
 * The request ID lets anyone holding the link see whether the request was already paid
 * (one-time enforcement) without revealing who the recipient is.
 */
import { buildMetadataForERC20 } from "@scopelift/stealth-address-sdk";
import { getAddress, type Address, type Hex } from "viem";

const MAGIC = "515001";
const ERC20_TRANSFER_SELECTOR = "a9059cbb";

export function buildPaymentMetadata(p: { viewTag: Hex; token: Address; amount: bigint; requestId: Hex }): Hex {
  if (!/^0x[0-9a-fA-F]{32}$/.test(p.requestId)) throw new Error("requestId must be 16 bytes");
  const base = buildMetadataForERC20({
    viewTag: p.viewTag.toLowerCase() as Hex,
    tokenAddress: p.token,
    amount: p.amount,
  });
  return `${base}${MAGIC}${p.requestId.slice(2).toLowerCase()}` as Hex;
}

export interface ParsedMetadata {
  viewTag: Hex;
  selector: Hex | null;
  token: Address | null;
  amount: bigint | null;
  requestId: Hex | null;
}

/** Tolerant parser: announcements are public and anyone can emit arbitrary bytes. */
export function parsePaymentMetadata(metadata: Hex): ParsedMetadata {
  const hex = metadata.slice(2).toLowerCase();
  const out: ParsedMetadata = { viewTag: `0x${hex.slice(0, 2)}` as Hex, selector: null, token: null, amount: null, requestId: null };
  if (hex.length >= 114) {
    out.selector = `0x${hex.slice(2, 10)}` as Hex;
    if (hex.slice(2, 10) === ERC20_TRANSFER_SELECTOR) {
      out.token = getAddress(`0x${hex.slice(10, 50)}`);
      out.amount = BigInt(`0x${hex.slice(50, 114)}`);
    }
  }
  if (hex.length === 152 && hex.slice(114, 120) === MAGIC) {
    out.requestId = `0x${hex.slice(120, 152)}` as Hex;
  }
  return out;
}
