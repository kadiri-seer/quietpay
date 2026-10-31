/**
 * Payer flow: preflight checks, USDG transfer to the derived stealth address, then the
 * ERC-5564 announcement as a separate transaction (retryable without resending payment).
 */
import { formatEther, getAddress, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { PAYMENT_LIMITS, CLOCK_SKEW_SECONDS, MAX_EXPIRY_SECONDS, type NetworkConfig } from "@/config/networks";
import { announcerAbi, erc20Abi, ERC5564_SCHEME_ID } from "@/config/contracts";
import { checkLimits, formatAmount, limitsFor } from "./amount";
import {
  assertChainId,
  findBlockAtOrBefore,
  scanAnnouncements,
  verifyAnnouncementInReceipt,
  verifyAnnouncer,
  verifyToken,
  verifyTransferInReceipt,
  waitForConfirmedReceipt,
  type Announcement,
  type TokenInfo,
} from "./chain";
import type { PaymentRequestLink } from "./link";
import { buildPaymentMetadata, parsePaymentMetadata } from "./metadata";
import { initialMachine, type PaymentMachine } from "./payment-state";
import type { StealthDerivation } from "./stealth";
import type { KeyValueStore } from "./vault";

export type CheckStatus = "ok" | "fail" | "warn";
export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  token?: TokenInfo;
  existingPayments: Announcement[];
}

/** Searches announcements for this request ID (one-time enforcement across payers). */
export async function findExistingPayments(
  client: PublicClient,
  network: NetworkConfig,
  request: PaymentRequestLink,
  fromBlock?: bigint,
): Promise<Announcement[]> {
  if (!network.announcer) return [];
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const start =
    fromBlock ??
    (await findBlockAtOrBefore(client, BigInt(Math.max(0, request.expiresAt - MAX_EXPIRY_SECONDS - CLOCK_SKEW_SECONDS))));
  const anns = await scanAnnouncements(client, {
    announcer: network.announcer,
    fromBlock: start,
    toBlock: latest,
    chunkSize: network.logChunkSize,
  });
  return anns.filter((a) => parsePaymentMetadata(a.metadata).requestId?.toLowerCase() === request.requestId.toLowerCase());
}

export async function preflight(
  client: PublicClient,
  p: {
    network: NetworkConfig;
    request: PaymentRequestLink;
    payer: Address;
    derivation: StealthDerivation;
    nowSeconds?: number;
    scanFromBlock?: bigint;
  },
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => checks.push(c);
  const now = p.nowSeconds ?? Math.floor(Date.now() / 1000);
  let token: TokenInfo | undefined;
  let existingPayments: Announcement[] = [];

  try {
    await assertChainId(client, p.network.chain.id);
    add({ id: "chain", label: `Network is ${p.network.label}`, status: "ok" });
  } catch (e) {
    add({ id: "chain", label: "Network", status: "fail", detail: (e as Error).message });
    return { ok: false, checks, existingPayments };
  }

  try {
    token = await verifyToken(client, p.network);
    add({
      id: "token",
      label: `${token.symbol} contract verified`,
      status: token.isMock ? "warn" : "ok",
      detail: token.isMock ? "Testnet mock token. It has no value." : `${token.decimals} decimals read onchain.`,
    });
  } catch (e) {
    add({ id: "token", label: "Token contract", status: "fail", detail: (e as Error).message });
  }

  try {
    await verifyAnnouncer(client, p.network);
    add({ id: "announcer", label: "Stealth announcer verified", status: "ok" });
  } catch (e) {
    add({ id: "announcer", label: "Stealth announcer", status: "fail", detail: (e as Error).message });
  }

  if (p.request.expiresAt <= now) add({ id: "expiry", label: "Link expired", status: "fail" });

  if (token) {
    const limitError = checkLimits(p.request.amount, limitsFor(token.decimals, PAYMENT_LIMITS), token.decimals, token.symbol);
    if (limitError) add({ id: "limits", label: "Amount outside allowed range", status: "fail", detail: limitError });

    const balance = await client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [p.payer] });
    add(
      balance >= p.request.amount
        ? { id: "balance", label: `${token.symbol} balance is enough`, status: "ok" }
        : {
            id: "balance",
            label: `Not enough ${token.symbol}`,
            status: "fail",
            detail: `You have ${formatAmount(balance, token.decimals, { group: true })} ${token.symbol}; this link needs ${formatAmount(p.request.amount, token.decimals, { group: true })}.`,
          },
    );

    if (balance >= p.request.amount && p.network.announcer) {
      try {
        const metadata = buildPaymentMetadata({
          viewTag: p.derivation.viewTag,
          token: token.address,
          amount: p.request.amount,
          requestId: p.request.requestId,
        });
        const [g1, g2, fees, eth] = await Promise.all([
          client.estimateContractGas({
            address: token.address,
            abi: erc20Abi,
            functionName: "transfer",
            args: [p.derivation.stealthAddress, p.request.amount],
            account: p.payer,
          }),
          client.estimateContractGas({
            address: p.network.announcer,
            abi: announcerAbi,
            functionName: "announce",
            args: [ERC5564_SCHEME_ID, p.derivation.stealthAddress, p.derivation.ephemeralPublicKey, metadata],
            account: p.payer,
          }),
          client.estimateFeesPerGas(),
          client.getBalance({ address: p.payer }),
        ]);
        const needed = ((g1 + g2) * (fees.maxFeePerGas ?? 0n) * 3n) / 2n;
        add(
          eth >= needed
            ? { id: "gas", label: "ETH for network fees is enough", status: "ok" }
            : {
                id: "gas",
                label: "Not enough ETH for network fees",
                status: "fail",
                detail: `About ${formatEther(needed)} ETH needed for two transactions; you have ${formatEther(eth)}.`,
              },
        );
      } catch (e) {
        add({ id: "gas", label: "Could not estimate network fees", status: "fail", detail: (e as Error).message.split("\n")[0] });
      }
    }
  }

  if (p.network.announcer && checks.every((c) => c.id !== "announcer" || c.status === "ok")) {
    try {
      existingPayments = await findExistingPayments(client, p.network, p.request, p.scanFromBlock);
      add(
        existingPayments.length === 0
          ? { id: "unpaid", label: "Not paid yet", status: "ok" }
          : { id: "unpaid", label: "This link was already paid", status: "fail", detail: "Each QuietPay link can be paid once." },
      );
    } catch (e) {
      add({ id: "unpaid", label: "Could not check earlier payments", status: "fail", detail: (e as Error).message.split("\n")[0] });
    }
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks, token, existingPayments };
}

/* ---------------- Local payer record (no secrets) ---------------- */

export interface PayerRecord {
  requestId: Hex;
  chainId: number;
  payer: Address;
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: Hex;
  metadata: Hex;
  machine: PaymentMachine;
  updatedAt: number;
}

const payerKey = (requestId: Hex) => `quietpay:payer:v1:${requestId.toLowerCase()}`;

export function loadPayerRecord(store: KeyValueStore, requestId: Hex): PayerRecord | null {
  try {
    const raw = store.getItem(payerKey(requestId));
    return raw ? (JSON.parse(raw) as PayerRecord) : null;
  } catch {
    return null;
  }
}

export function savePayerRecord(store: KeyValueStore, rec: PayerRecord) {
  store.setItem(payerKey(rec.requestId), JSON.stringify({ ...rec, updatedAt: Date.now() }));
}

export function newPayerRecord(
  request: PaymentRequestLink,
  payer: Address,
  derivation: StealthDerivation,
  token: Address,
): PayerRecord {
  return {
    requestId: request.requestId,
    chainId: request.chainId,
    payer: getAddress(payer),
    stealthAddress: derivation.stealthAddress,
    ephemeralPublicKey: derivation.ephemeralPublicKey,
    viewTag: derivation.viewTag,
    metadata: buildPaymentMetadata({ viewTag: derivation.viewTag, token, amount: request.amount, requestId: request.requestId }),
    machine: initialMachine(),
    updatedAt: Date.now(),
  };
}

/* ---------------- Transactions ---------------- */

export async function submitPayment(
  wallet: WalletClient,
  p: { network: NetworkConfig; token: Address; stealthAddress: Address; amount: bigint },
): Promise<Hash> {
  if (!wallet.account) throw new Error("Wallet not connected.");
  return wallet.writeContract({
    chain: p.network.chain,
    account: wallet.account,
    address: p.token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [p.stealthAddress, p.amount],
  });
}

export async function confirmPayment(
  client: PublicClient,
  hash: Hash,
  p: { network: NetworkConfig; token: Address; stealthAddress: Address; amount: bigint; payer: Address; onReplaced?: (h: Hash) => void },
) {
  const receipt = await waitForConfirmedReceipt(client, hash, { confirmations: p.network.confirmations, onReplaced: p.onReplaced });
  verifyTransferInReceipt(receipt, { token: p.token, to: p.stealthAddress, amount: p.amount, from: p.payer });
  return receipt;
}

export async function submitAnnouncement(
  wallet: WalletClient,
  p: { network: NetworkConfig; stealthAddress: Address; ephemeralPublicKey: Hex; metadata: Hex },
): Promise<Hash> {
  if (!wallet.account) throw new Error("Wallet not connected.");
  if (!p.network.announcer) throw new Error("No announcer configured.");
  return wallet.writeContract({
    chain: p.network.chain,
    account: wallet.account,
    address: p.network.announcer,
    abi: announcerAbi,
    functionName: "announce",
    args: [ERC5564_SCHEME_ID, p.stealthAddress, p.ephemeralPublicKey, p.metadata],
  });
}

export async function confirmAnnouncement(
  client: PublicClient,
  hash: Hash,
  p: { network: NetworkConfig; stealthAddress: Address; onReplaced?: (h: Hash) => void },
) {
  const receipt = await waitForConfirmedReceipt(client, hash, { confirmations: p.network.confirmations, onReplaced: p.onReplaced });
  verifyAnnouncementInReceipt(receipt, { announcer: p.network.announcer!, stealthAddress: p.stealthAddress });
  return receipt;
}
