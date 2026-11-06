/**
 * What a scanned (or pasted) QR code means. Only QuietPay codes are accepted:
 *   - a personal link (…/pay#to=0x…) -> Send from your balance, to that link
 *   - a wallet address -> Send from your balance
 *   - a payment request (…/pay#<code>) -> Pay page (paid from a connected wallet)
 * A link to any other website is refused, so a QR code can't send you somewhere that looks like
 * QuietPay but isn't.
 */
import { getAddress, isAddress } from "viem";
import { parsePayTarget } from "./pool/locks";
import { decodePaymentLink } from "./link";

export const QUIETPAY_HOSTS = ["quietpay.sbs", "www.quietpay.sbs"];

export type ScanResult = { kind: "send"; to: string } | { kind: "pay"; code: string } | { kind: "error"; message: string };

export function interpretScan(text: string, currentHost: string): ScanResult {
  const s = text.trim();
  if (!s) return { kind: "error", message: "Nothing to read." };
  if (isAddress(s)) return { kind: "send", to: getAddress(s) };
  const ethereum = /^ethereum:(0x[0-9a-fA-F]{40})(?:@\d+)?$/.exec(s);
  if (ethereum) return { kind: "send", to: getAddress(ethereum[1]) };

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { kind: "error", message: "That isn't a QuietPay code." };
  }
  const local = url.protocol === "http:" && url.host === currentHost && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (url.protocol !== "https:" && !local) return { kind: "error", message: "That isn't a QuietPay code." };
  if (url.host !== currentHost && !QUIETPAY_HOSTS.includes(url.hostname)) return { kind: "error", message: `That code points to ${url.hostname}, not QuietPay. Don't use it.` };
  if (url.pathname.replace(/\/$/, "") !== "/pay" || url.hash.length < 2) return { kind: "error", message: "That isn't a QuietPay payment code." };
  const frag = url.hash.slice(1);
  const target = parsePayTarget(frag);
  // "to=0x…" so Send knows it's a personal link, not a wallet address to withdraw to.
  if (target) return { kind: "send", to: `to=${target.key}` };
  try {
    decodePaymentLink(frag);
    return { kind: "pay", code: frag };
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
}
