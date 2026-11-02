/**
 * Payer flow.
 *
 * Router mode (preferred, when a verified QuietPayRouter is configured): one transaction moves the
 * tokens to the one-time address, adds a small ETH "gas stipend" so the recipient can claim without
 * topping the address up from a wallet linked to them, and posts the announcement. An exact token
 * approval for the router may be needed first.
 *
 * Direct mode (fallback): token transfer, then the announcement as a second transaction that can
 * be retried on its own without ever resending the payment.
 */
import { formatEther, getAddress, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { PAYMENT_LIMITS, CLOCK_SKEW_SECONDS, MAX_EXPIRY_SECONDS, type NetworkConfig } from "@/config/networks";
import { announcerAbi, erc20Abi, ERC5564_SCHEME_ID, routerAbi, routerV2Abi } from "@/config/contracts";
import { SHIELD_GAS_BUDGET } from "./pool/constants";
import { checkLimits, formatAmount, limitsFor } from "./amount";
import {
  assertChainId,
  findBlockAtOrBefore,
  scanAnnouncements,
  verifyAnnouncementInReceipt,
  verifyAnnouncer,
  verifyRouter,
  verifyToken,
  verifyTransferInReceipt,
  waitForConfirmedReceipt,
  type Announcement,
  type TokenInfo,
} from "./chain";
import type { LinkKind, PaymentRequestLink } from "./link";
import { buildPaymentMetadata, parsePaymentMetadata } from "./metadata";
import { initialMachine, type PaymentMachine } from "./payment-state";
import type { StealthDerivation } from "./stealth";
import { receivedAmount } from "./receive";
import type { KeyValueStore } from "./vault";

export type CheckStatus = "ok" | "fail" | "warn";
export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export type PayMode = "router" | "direct";

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  token?: TokenInfo;
  existingPayments: Announcement[];
  mode: PayMode;
  /** ETH (wei) sent along for the recipient's claim gas. 0 in direct mode. */
  stipend: bigint;
  /** True when an exact token approval for the router is needed first. */
  needsApproval: boolean;
  /** Router version in router mode (2 enforces one-time links onchain). */
  routerVersion?: 1 | 2;
}

/** Router contract's cap on the stipend (0.001 ETH). */
export const MAX_GAS_STIPEND = 10n ** 15n;

/** The amount actually being paid: fixed from the link, or chosen by the payer for open links. */
export function payAmount(request: PaymentRequestLink, chosen?: bigint | null): bigint {
  return request.kind === "fixed" ? request.amount : (chosen ?? 0n);
}

/**
 * Searches announcements for this request ID (one-time enforcement for fixed links). Anyone who
 * has the link can post an announcement with its ID, so one only counts if its one-time address
 * actually received at least the link's amount of the token. Faking that means paying in full.
 */
export async function findExistingPayments(
  client: PublicClient,
  network: NetworkConfig,
  request: PaymentRequestLink,
  fromBlock?: bigint,
): Promise<Announcement[]> {
  if (!network.announcer || request.kind !== "fixed") return [];
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
  const claimed = anns.filter((a) => parsePaymentMetadata(a.metadata).requestId?.toLowerCase() === request.requestId.toLowerCase());
  const real: Announcement[] = [];
  for (const a of claimed) {
    // A real payment's transfer comes at or just before its announcement (the same transaction
    // with the router). Look there first, then back to the link's creation.
    const near = a.blockNumber > start + 50_000n ? a.blockNumber - 50_000n : start;
    let got = await receivedAmount(client, getAddress(request.token), a.stealthAddress, near, network.logChunkSize, a.blockNumber);
    if (got < request.amount && near > start) got = await receivedAmount(client, getAddress(request.token), a.stealthAddress, start, network.logChunkSize, a.blockNumber);
    if (got >= request.amount) real.push(a);
  }
  return real;
}

/**
 * ETH to send with the payment so the recipient can move the tokens later: three token transfers'
 * worth of gas (a full claim plus a couple of partial sends) with headroom, capped by the router.
 */
export async function estimateGasStipend(
  client: PublicClient,
  token: Address,
  payer: Address,
  probeTo: Address,
  amount: bigint,
  /** Extra gas the recipient may need, e.g. to shield the payment in the pool. */
  minGas = 0n,
) {
  const [transferGas, fees] = await Promise.all([
    client.estimateContractGas({ address: token, abi: erc20Abi, functionName: "transfer", args: [probeTo, amount], account: payer }),
    client.estimateFeesPerGas(),
  ]);
  const maxFee = fees.maxFeePerGas ?? 0n;
  const gas = transferGas * 3n > minGas ? transferGas * 3n : minGas;
  let stipend = (gas * maxFee * 3n) / 2n;
  if (stipend > MAX_GAS_STIPEND) stipend = MAX_GAS_STIPEND;
  // Round up to 0.000001 ETH so the figure shown everywhere is exactly the figure sent.
  const unit = 10n ** 12n;
  const rounded = ((stipend + unit - 1n) / unit) * unit;
  return rounded > MAX_GAS_STIPEND ? MAX_GAS_STIPEND : rounded;
}

export async function preflight(
  client: PublicClient,
  p: {
    network: NetworkConfig;
    request: PaymentRequestLink;
    /** Amount the payer chose (open links). Ignored for fixed links. */
    amount?: bigint | null;
    payer: Address;
    derivation: StealthDerivation;
    nowSeconds?: number;
    scanFromBlock?: bigint;
  },
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => checks.push(c);
  const now = p.nowSeconds ?? Math.floor(Date.now() / 1000);
  const amount = payAmount(p.request, p.amount);
  let token: TokenInfo | undefined;
  let existingPayments: Announcement[] = [];
  let mode: PayMode = "direct";
  let stipend = 0n;
  let needsApproval = false;
  let routerVersion: 1 | 2 | undefined;
  const done = (): PreflightResult => ({ ok: checks.every((c) => c.status !== "fail"), checks, token, existingPayments, mode, stipend, needsApproval, routerVersion });

  try {
    await assertChainId(client, p.network.chain.id);
    add({ id: "chain", label: `Network is ${p.network.label}`, status: "ok" });
  } catch (e) {
    add({ id: "chain", label: "Network", status: "fail", detail: (e as Error).message });
    return done();
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

  try {
    const router = await verifyRouter(client, p.network);
    if (router) {
      mode = "router";
      routerVersion = router.version;
      add({ id: "router", label: "One-transaction payment available", status: "ok", detail: "Includes gas for the recipient to claim." });
    } else {
      add({
        id: "router",
        label: "Two-transaction payment",
        status: "warn",
        detail: "The recipient will need to add a little ETH to claim, which can link the payment to them.",
      });
    }
  } catch (e) {
    add({ id: "router", label: "Payment router", status: "fail", detail: (e as Error).message });
  }

  if (p.request.expiresAt !== 0 && p.request.expiresAt <= now) add({ id: "expiry", label: "Link expired", status: "fail" });

  if (token) {
    if (amount <= 0n) {
      add({ id: "limits", label: "Enter an amount", status: "fail" });
      return done();
    }
    const limitError = checkLimits(amount, limitsFor(token.decimals, PAYMENT_LIMITS), token.decimals, token.symbol);
    if (limitError) add({ id: "limits", label: "Amount outside allowed range", status: "fail", detail: limitError });

    const balance = await client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [p.payer] });
    add(
      balance >= amount
        ? { id: "balance", label: `${token.symbol} balance is enough`, status: "ok" }
        : {
            id: "balance",
            label: `Not enough ${token.symbol}`,
            status: "fail",
            detail: `You have ${formatAmount(balance, token.decimals, { group: true })} ${token.symbol}; this payment needs ${formatAmount(amount, token.decimals, { group: true })}.`,
          },
    );

    if (balance >= amount && p.network.announcer) {
      try {
        const metadata = buildPaymentMetadata({
          viewTag: p.derivation.viewTag,
          token: token.address,
          amount,
          requestId: p.request.kind === "fixed" ? p.request.requestId : null,
        });
        const [gTransfer, gAnnounce, fees, eth] = await Promise.all([
          client.estimateContractGas({
            address: token.address,
            abi: erc20Abi,
            functionName: "transfer",
            args: [p.derivation.stealthAddress, amount],
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
        const maxFee = fees.maxFeePerGas ?? 0n;
        let gasUnits = gTransfer + gAnnounce;
        if (mode === "router" && p.network.router) {
          stipend = await estimateGasStipend(client, token.address, p.payer, p.derivation.stealthAddress, amount, p.network.pool ? SHIELD_GAS_BUDGET : 0n);
          const allowance = await client.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [p.payer, p.network.router],
          });
          needsApproval = allowance < amount;
          // Router call: the transfer plus announcement plus routing overhead; an approval if needed.
          gasUnits = gTransfer + gAnnounce + 45_000n + (needsApproval ? 60_000n : 0n);
        }
        const needed = (gasUnits * maxFee * 3n) / 2n + stipend;
        const txs = mode === "router" ? (needsApproval ? "an approval and the payment" : "the payment") : "two transactions";
        add(
          eth >= needed
            ? {
                id: "gas",
                label: "ETH for network fees is enough",
                status: "ok",
                detail: stipend > 0n ? `Includes about ${formatEther(stipend)} ETH so the recipient can claim.` : undefined,
              }
            : {
                id: "gas",
                label: "Not enough ETH for network fees",
                status: "fail",
                detail: `About ${formatEther(needed)} ETH needed for ${txs}${stipend > 0n ? " and the recipient's claim fee" : ""}; you have ${formatEther(eth)}.`,
              },
        );
      } catch (e) {
        add({ id: "gas", label: "Could not estimate network fees", status: "fail", detail: (e as Error).message.split("\n")[0] });
      }
    }
  }

  if (p.request.kind === "fixed" && p.network.announcer && checks.every((c) => c.id !== "announcer" || c.status === "ok")) {
    try {
      // With router v2 the contract's own record is authoritative (and also refuses a second
      // payment onchain). Earlier payments made another way are still found by scanning.
      const paidOnchain =
        mode === "router" && routerVersion === 2 && p.network.router
          ? await client.readContract({ address: p.network.router, abi: routerV2Abi, functionName: "paidOnce", args: [p.request.requestId as Hex] })
          : false;
      existingPayments = await findExistingPayments(client, p.network, p.request, p.scanFromBlock);
      add(
        existingPayments.length === 0 && !paidOnchain
          ? { id: "unpaid", label: "Not paid yet", status: "ok" }
          : { id: "unpaid", label: "This link was already paid", status: "fail", detail: "This link can be paid once." },
      );
    } catch (e) {
      add({ id: "unpaid", label: "Could not check earlier payments", status: "fail", detail: (e as Error).message.split("\n")[0] });
    }
  }

  return done();
}

/* ---------------- Local payer record (no secrets) ---------------- */

export interface PayerRecord {
  requestId: Hex;
  kind?: LinkKind;
  chainId: number;
  /** Base units actually paid (fixed: from the link; open: chosen by the payer). */
  amount?: string;
  mode?: PayMode;
  /** Wei sent to the one-time address for the recipient's claim gas (router mode). */
  stipend?: string;
  approveTx?: Hex;
  payer: Address;
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: Hex;
  metadata: Hex;
  machine: PaymentMachine;
  updatedAt: number;
  /** The payment transaction's nonce, recorded right after sending, to tell later if it was dropped. */
  paymentNonce?: number;
  /** Set when the payment transaction was proven dropped (its nonce used by something else, no transfer). */
  dropped?: boolean;
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

/** Forgets a finished payment so a reusable link can be paid again from this browser. */
export function clearPayerRecord(store: KeyValueStore, requestId: Hex) {
  store.removeItem(payerKey(requestId));
}

export function newPayerRecord(
  request: PaymentRequestLink,
  payer: Address,
  derivation: StealthDerivation,
  token: Address,
  opts: { amount?: bigint | null; mode?: PayMode; stipend?: bigint } = {},
): PayerRecord {
  const amount = payAmount(request, opts.amount);
  return {
    requestId: request.requestId,
    kind: request.kind,
    chainId: request.chainId,
    amount: amount.toString(),
    mode: opts.mode ?? "direct",
    stipend: (opts.stipend ?? 0n).toString(),
    payer: getAddress(payer),
    stealthAddress: derivation.stealthAddress,
    ephemeralPublicKey: derivation.ephemeralPublicKey,
    viewTag: derivation.viewTag,
    metadata: buildPaymentMetadata({
      viewTag: derivation.viewTag,
      token,
      amount,
      requestId: request.kind === "fixed" ? request.requestId : null,
    }),
    machine: initialMachine(),
    updatedAt: Date.now(),
  };
}

/**
 * A payment this browser prepared but never saw a transaction hash for: the tab was closed or
 * reloaded while the wallet was asking (common on phones). Looks onchain for a token transfer
 * from the payer to that one-time address since the attempt started, so it is never paid twice.
 * Returns the transaction and whether it also carried the announcement (router payments).
 */
export async function findUnrecordedPayment(
  client: PublicClient,
  network: NetworkConfig,
  rec: PayerRecord,
): Promise<{ hash: Hash; announced: boolean } | null> {
  if (!network.token) return null;
  const since = BigInt(Math.max(0, Math.floor(rec.updatedAt / 1000) - 300));
  const fromBlock = await findBlockAtOrBefore(client, since);
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  let start = fromBlock;
  let size = network.logChunkSize > 0n ? network.logChunkSize : 10_000n;
  while (start <= latest) {
    const end = start + size - 1n > latest ? latest : start + size - 1n;
    try {
      const logs = await client.getContractEvents({
        address: network.token,
        abi: erc20Abi,
        eventName: "Transfer",
        args: { from: rec.payer, to: rec.stealthAddress },
        fromBlock: start,
        toBlock: end,
        strict: true,
      });
      if (logs.length > 0) {
        const hash = logs[0].transactionHash;
        const receipt = await client.getTransactionReceipt({ hash });
        let announced = false;
        try {
          if (network.announcer) {
            verifyAnnouncementInReceipt(receipt, { announcer: network.announcer, stealthAddress: rec.stealthAddress });
            announced = true;
          }
        } catch {
          announced = false;
        }
        return { hash, announced };
      }
      start = end + 1n;
    } catch (e) {
      if (size <= 100n) throw e;
      size /= 2n;
    }
  }
  return null;
}

/**
 * What happened to a payment transaction that hasn't confirmed:
 *  - "landed": the money did reach the one-time address (possibly in a replacement transaction);
 *  - "pending": the network still knows the transaction, or it can't be told yet;
 *  - "dropped": the transaction is gone, the payer's nonce has moved past it, and no transfer to the
 *    one-time address happened, so it can never go through and a new payment is safe.
 */
export async function checkPaymentFate(
  client: PublicClient,
  network: NetworkConfig,
  rec: PayerRecord,
): Promise<{ status: "landed"; hash: Hash; announced: boolean } | { status: "pending" } | { status: "dropped" }> {
  const landed = await findUnrecordedPayment(client, network, rec).catch(() => null);
  if (landed) return { status: "landed", ...landed };
  const hash = rec.machine.paymentTx as Hash | undefined;
  if (hash) {
    const tx = await client.getTransaction({ hash }).catch(() => null);
    if (tx) return { status: "pending" };
  }
  if (rec.paymentNonce === undefined) return { status: "pending" };
  const used = await client.getTransactionCount({ address: rec.payer, blockTag: "latest" });
  if (used <= rec.paymentNonce) return { status: "pending" };
  // The nonce was used by another transaction. Look once more for the transfer, in case the
  // replacement was the payment itself, before calling it dropped.
  const again = await findUnrecordedPayment(client, network, rec);
  return again ? { status: "landed", ...again } : { status: "dropped" };
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

/* ---------------- Router mode ---------------- */

/** Approves exactly `amount` for the router if the current allowance is lower. Returns the tx hash, or null if not needed. */
export async function approveRouterIfNeeded(
  wallet: WalletClient,
  client: PublicClient,
  p: { network: NetworkConfig; token: Address; owner: Address; amount: bigint },
): Promise<Hash | null> {
  if (!wallet.account) throw new Error("Wallet not connected.");
  if (!p.network.router) throw new Error("No router configured.");
  const allowance = await client.readContract({ address: p.token, abi: erc20Abi, functionName: "allowance", args: [p.owner, p.network.router] });
  if (allowance >= p.amount) return null;
  const hash = await wallet.writeContract({
    chain: p.network.chain,
    account: wallet.account,
    address: p.token,
    abi: erc20Abi,
    functionName: "approve",
    args: [p.network.router, p.amount],
  });
  const receipt = await waitForConfirmedReceipt(client, hash, { confirmations: p.network.confirmations });
  if (receipt.status !== "success") throw new Error("The approval transaction failed.");
  return receipt.transactionHash;
}

export async function submitRoutedPayment(
  wallet: WalletClient,
  p: {
    network: NetworkConfig;
    token: Address;
    stealthAddress: Address;
    amount: bigint;
    ephemeralPublicKey: Hex;
    metadata: Hex;
    stipend: bigint;
    /** Router version from verifyRouter. v2 needs `requestId` for one-time links. */
    routerVersion?: 1 | 2;
    /** One-time link's request ID (fixed links); null for reusable links. */
    requestId?: Hex | null;
  },
): Promise<Hash> {
  if (!wallet.account) throw new Error("Wallet not connected.");
  if (!p.network.router || !p.network.announcer) throw new Error("Router or announcer not configured.");
  if (p.stipend > MAX_GAS_STIPEND) throw new Error("Gas stipend is above the router's limit.");
  if (p.routerVersion === 2) {
    const common = { chain: p.network.chain, account: wallet.account, address: p.network.router, abi: routerV2Abi, value: p.stipend } as const;
    return p.requestId
      ? wallet.writeContract({ ...common, functionName: "payOnce", args: [p.requestId, p.stealthAddress, p.amount, p.ephemeralPublicKey, p.metadata] })
      : wallet.writeContract({ ...common, functionName: "pay", args: [p.stealthAddress, p.amount, p.ephemeralPublicKey, p.metadata] });
  }
  return wallet.writeContract({
    chain: p.network.chain,
    account: wallet.account,
    address: p.network.router,
    abi: routerAbi,
    functionName: "pay",
    args: [p.token, p.network.announcer, p.stealthAddress, p.amount, p.ephemeralPublicKey, p.metadata],
    value: p.stipend,
  });
}

/** Waits for a routed payment and verifies both the token transfer and the announcement in its receipt. */
export async function confirmRoutedPayment(
  client: PublicClient,
  hash: Hash,
  p: { network: NetworkConfig; token: Address; stealthAddress: Address; amount: bigint; payer: Address; onReplaced?: (h: Hash) => void },
) {
  const receipt = await waitForConfirmedReceipt(client, hash, { confirmations: p.network.confirmations, onReplaced: p.onReplaced });
  verifyTransferInReceipt(receipt, { token: p.token, to: p.stealthAddress, amount: p.amount, from: p.payer });
  verifyAnnouncementInReceipt(receipt, { announcer: p.network.announcer!, stealthAddress: p.stealthAddress });
  return receipt;
}
