import { describe, expect, it } from "vitest";
import { isRecognisedWallet, signsOnce } from "@/lib/wallet-kind";

const sig65 = `0x${"ab".repeat(65)}` as const;
const longSig = `0x${"ab".repeat(400)}` as const;

describe("which wallets sign once", () => {
  it("recognises ordinary wallets by their EIP-6963 id, WalletConnect name or injected flag", () => {
    expect(isRecognisedWallet({ connectorId: "io.metamask" })).toBe(true);
    expect(isRecognisedWallet({ connectorId: "walletConnect", peerName: "MetaMask Wallet" })).toBe(true);
    expect(isRecognisedWallet({ connectorId: "walletConnect", peerName: "Trust Wallet" })).toBe(true);
    expect(isRecognisedWallet({ connectorId: "injected", peerName: "metamask" })).toBe(true);
    expect(isRecognisedWallet({ connectorId: "walletConnect", peerName: "Some MPC Wallet" })).toBe(false);
    expect(isRecognisedWallet({ connectorId: "injected", peerName: null })).toBe(false);
  });

  it("signs once only for a recognised wallet, a plain signature and no contract code", () => {
    const mm = { connectorId: "io.metamask", code: "0x" as const };
    expect(signsOnce(mm, sig65)).toBe(true);
    // EIP-7702 delegated accounts still sign with their own key.
    expect(signsOnce({ ...mm, code: `0xef0100${"11".repeat(20)}` }, sig65)).toBe(true);
    // A smart-contract wallet, a long (smart-wallet) signature, or unknown code: sign twice.
    expect(signsOnce({ ...mm, code: "0x6080604052" }, sig65)).toBe(false);
    expect(signsOnce(mm, longSig)).toBe(false);
    expect(signsOnce({ ...mm, code: null }, sig65)).toBe(false);
    expect(signsOnce({ connectorId: "walletConnect", peerName: "Unknown", code: "0x" }, sig65)).toBe(false);
  });
});
