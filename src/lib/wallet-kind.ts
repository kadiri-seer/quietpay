/**
 * Does this wallet need the "sign twice" check?
 *
 * Every QuietPay key comes from one wallet signature, so the wallet must sign the same message the
 * same way every time. Ordinary wallets do (RFC 6979 ECDSA): MetaMask, Rabby, Coinbase Wallet,
 * Trust, Rainbow, Ledger and the like. Smart-contract wallets (Safe, passkey wallets) and some
 * embedded MPC wallets don't. Those get a second signature to compare; ordinary wallets sign once.
 *
 * A wallet is treated as ordinary only if all three hold:
 *  - it is one QuietPay recognises (by its EIP-6963 id or its WalletConnect name);
 *  - its signature has the plain 65-byte ECDSA shape (smart-wallet signatures are longer);
 *  - the address has no contract code (EIP-7702 delegated accounts still sign with their own
 *    key, so they count as ordinary).
 */
import type { Hex } from "viem";

/** EIP-6963 reverse-DNS ids of wallets that sign deterministically. */
const KNOWN_IDS = [
  "io.metamask",
  "io.metamask.mobile",
  "io.metamask.flask",
  "io.rabby",
  "com.coinbase.wallet",
  "com.trustwallet.app",
  "me.rainbow",
  "io.zerion.wallet",
  "app.phantom",
  "com.okex.wallet",
  "com.brave.wallet",
  "com.bitget.web3",
  "io.frame",
  "com.ledger",
  "app.backpack",
];

/** WalletConnect peer names (lowercased, matched as prefixes) of wallets that sign deterministically. */
const KNOWN_NAMES = ["metamask", "trust", "brave", "rainbow", "rabby", "zerion", "okx", "phantom", "bitget", "ledger", "uniswap", "coinbase wallet", "safepal", "tokenpocket", "imtoken", "exodus"];

export interface WalletFacts {
  /** The connector's id (EIP-6963 rdns for announced extensions, "injected", "walletConnect"…). */
  connectorId?: string;
  /** For WalletConnect: the connected wallet app's name. */
  peerName?: string | null;
  /** Bytecode at the address, if known ("0x" or empty for none). */
  code?: Hex | null;
}

export function isRecognisedWallet(f: WalletFacts): boolean {
  const id = (f.connectorId ?? "").toLowerCase();
  if (KNOWN_IDS.includes(id)) return true;
  const name = (f.peerName ?? "").trim().toLowerCase();
  return !!name && KNOWN_NAMES.some((n) => name.startsWith(n));
}

/** EIP-7702 delegation designator: 0xef0100 followed by a 20-byte address. */
const isDelegated = (code: string) => /^0xef0100[0-9a-fA-F]{40}$/.test(code);

/** True when one signature is enough (see above). Anything unknown gets the second signature. */
export function signsOnce(f: WalletFacts, signature: Hex): boolean {
  if (!isRecognisedWallet(f)) return false;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  if (f.code === undefined || f.code === null) return false;
  return f.code === "0x" || isDelegated(f.code);
}
