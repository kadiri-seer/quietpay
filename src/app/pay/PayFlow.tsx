"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import type { Hash } from "viem";
import { mockTokenFaucetAbi } from "@/config/contracts";
import { PAYMENT_LIMITS } from "@/config/networks";
import { AmountError, checkLimits, formatAmount, limitsFor, parseAmount } from "@/lib/amount";
import { extractLinkCode, validatePaymentLink, type LinkValidation } from "@/lib/link";
import {
  checkPaymentFate,
  clearPayerRecord,
  confirmAnnouncement,
  confirmPayment,
  confirmRoutedPayment,
  findUnrecordedPayment,
  loadPayerRecord,
  newPayerRecord,
  preflight,
  routedPaymentCall,
  savePayerRecord,
  submitAnnouncement,
  submitPayment,
  submitRoutedPayment,
  type PayerRecord,
  type PreflightResult,
} from "@/lib/payer";
import { canSendAnnouncement, STATE_LABELS, transition, type PaymentEvent } from "@/lib/payment-state";
import { deriveStealthPayment, type StealthDerivation } from "@/lib/stealth";
import { classifyTxError } from "@/lib/tx-errors";
import { browserStore } from "@/lib/vault";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { SetupBlocker } from "@/components/SetupBlocker";
import { Countdown, ExplorerLink, LoadingRows, Mono, Notice, PageTitle, Skeleton, Spinner, StatusPill, shorten } from "@/components/ui";
import { WalletGate } from "@/components/WalletGate";
import { formatEthCeil } from "@/components/ui";
import { PoolPayPanel } from "./PoolPayPanel";
import { PersonalPay } from "./PersonalPay";
import { parsePayTarget } from "@/lib/pool/locks";
import { useSelectedNetwork } from "@/components/Providers";
import { useVault } from "@/components/VaultProvider";
import { prepareSpend } from "@/lib/one-confirmation";

export function PayFlow() {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    const read = () => setCode(window.location.hash.length > 1 ? window.location.hash.slice(1) : "");
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const { network: selected } = useSelectedNetwork();
  const target = useMemo(() => (code ? parsePayTarget(code) : null), [code]);
  const validation = useMemo<{ ok: LinkValidation } | { error: string } | null>(() => {
    if (!code || target) return null;
    try {
      return { ok: validatePaymentLink(code) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [code, target]);

  return (
    <div className="mx-auto max-w-xl px-4 pt-6 sm:px-6">
      <PageTitle light="Pay a" bold="payment link">
        Your payment goes to an address created for this payment alone, or straight into the recipient&apos;s shielded pool. QuietPay checks
        the link before you connect anything.
      </PageTitle>
      <div className="panel p-5 sm:p-7">
        {code === null ? (
          <LoadingRows label="Reading the payment link" rows={3} />
        ) : target ? (
          <PersonalPay target={target} network={selected} />
        ) : !validation ? (
          <PasteLink />
        ) : "error" in validation ? (
          <div className="space-y-5">
            <Notice tone="bad" title="This link can't be paid">
              {validation.error}
            </Notice>
            <PasteLink />
          </div>
        ) : (
          <PayLink v={validation.ok} code={code} />
        )}
      </div>
    </div>
  );
}

function PasteLink() {
  const [value, setValue] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const c = extractLinkCode(value);
        if (c) window.location.hash = c;
      }}
    >
      <label htmlFor="paste" className="block text-sm font-medium text-snow">
        Paste a QuietPay link
      </label>
      <input id="paste" className="field font-mono text-base sm:text-xs" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…/pay#…" autoComplete="off" />
      <button className="btn btn-primary" type="submit" disabled={!value.trim()}>
        Open link
      </button>
    </form>
  );
}

function PayLink({ v, code }: { v: LinkValidation; code: string }) {
  const { request, network } = v;
  // A request this browser created (its keys are in this vault) is the user's own.
  const { vault } = useVault();
  const ownRequest = !!vault?.requests.some((r) => r.id.toLowerCase() === request.requestId.toLowerCase());
  const readiness = useNetworkReadiness(network);
  const token = readiness.data?.token;
  const open = request.kind === "open";

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="text-sm text-haze">{open ? "Reusable payment link" : "Payment request"}</p>
        <p className="mt-1 font-display text-4xl font-semibold tracking-[-0.02em] text-snow">
          {open ? (
            <>
              Any amount {token && <span className="text-xl text-haze">{token.symbol}</span>}
            </>
          ) : token ? (
            <>
              {formatAmount(request.amount, token.decimals, { group: true })} <span className="text-xl text-haze">{token.symbol}</span>
            </>
          ) : (
            <Skeleton className="mx-auto mt-1 h-10 w-44" />
          )}
        </p>
        <p className="mt-2 text-sm text-haze">
          {network.label} · {request.expiresAt === 0 ? "never expires" : <Countdown to={request.expiresAt} />}
          {token?.isMock && " · test token, no value"}
        </p>
      </div>
      {readiness.isLoading ? (
        <LoadingRows label="Verifying the token and announcer contracts" rows={2} />
      ) : token && readiness.data?.announcer ? (
        <>
          <WalletGate network={network} purpose="Connect the wallet you'll pay from. You'll review everything before anything is sent.">
            {ownRequest ? (
              <Notice tone="bad">This is your own request. You can&apos;t pay yourself.</Notice>
            ) : request.poolLock ? (
              <PoolPayPanel v={v} />
            ) : (
              <PayerPanel v={v} code={code} />
            )}
          </WalletGate>
        </>
      ) : (
        <SetupBlocker network={network} readiness={readiness.data} error={readiness.error} />
      )}
    </div>
  );
}

function PayerPanel({ v }: { v: LinkValidation; code: string }) {
  const { request, network } = v;
  const open = request.kind === "open";
  const { address } = useAccount();
  const { data: wallet } = useWalletClient({ chainId: network.chain.id });
  const client = usePublicClient(network);
  const { data: readiness } = useNetworkReadiness(network);
  const token = readiness!.token!;
  const store = useMemo(() => browserStore(), []);
  const limits = useMemo(() => limitsFor(token.decimals, PAYMENT_LIMITS), [token.decimals]);

  // A submitted payment being resumed, or null while preparing a new one.
  const [rec, setRec] = useState<PayerRecord | null>(null);
  const [derivation, setDerivation] = useState<StealthDerivation | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [amountConfirmed, setAmountConfirmed] = useState<bigint | null>(open ? null : request.amount);
  const [pf, setPf] = useState<PreflightResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const resumed = useRef(false);

  const freshStart = useCallback(() => {
    setRec(null);
    setPf(null);
    setNotice(null);
    setAmountInput("");
    setAmountConfirmed(open ? null : request.amount);
    setDerivation(deriveStealthPayment(request.stealthMetaAddress));
    resumed.current = false;
  }, [open, request]);

  // An attempt that was prepared but whose transaction this browser never saw (the tab closed
  // while the wallet asked). Checked onchain before anything new is offered.
  const [unconfirmed, setUnconfirmed] = useState<PayerRecord | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  const checkUnconfirmed = useCallback(
    async (existing: PayerRecord) => {
      setLookingUp(true);
      try {
        const found = await findUnrecordedPayment(client, network, existing);
        if (found) {
          let m = transition(existing.machine, { type: "SUBMIT_PAYMENT", txHash: found.hash });
          m = transition(m, found.announced ? { type: "ROUTED_PAYMENT_CONFIRMED", txHash: found.hash } : { type: "PAYMENT_CONFIRMED", txHash: found.hash });
          const next = { ...existing, machine: m };
          if (store) savePayerRecord(store, next);
          setUnconfirmed(null);
          setRec(next);
          return;
        }
        // Nothing arrived. After half an hour a wallet request can't still be pending.
        if (Date.now() - existing.updatedAt > 30 * 60_000) {
          if (store) clearPayerRecord(store, existing.requestId);
          setUnconfirmed(null);
          freshStart();
          return;
        }
        setUnconfirmed(existing);
      } catch {
        setUnconfirmed(existing);
      } finally {
        setLookingUp(false);
      }
    },
    [client, network, store, freshStart],
  );

  // Resume a payment this browser already submitted for this link, otherwise start fresh.
  useEffect(() => {
    if (!address) return;
    const existing = store ? loadPayerRecord(store, request.requestId) : null;
    if (existing && existing.payer.toLowerCase() === address.toLowerCase() && existing.machine.paymentSubmitted) {
      setRec(existing);
    } else if (existing && existing.payer.toLowerCase() === address.toLowerCase() && existing.machine.state === "created") {
      void checkUnconfirmed(existing);
    } else {
      freshStart();
    }
  }, [address, request.requestId, store, freshStart, checkUnconfirmed]);

  /** Saves the payment transaction's nonce so a later check can tell if it was dropped. */
  const recordNonce = useCallback(
    async (r: PayerRecord, hash: Hash): Promise<PayerRecord> => {
      const tx = await client.getTransaction({ hash }).catch(() => null);
      if (!tx) return r;
      const next = { ...r, paymentNonce: tx.nonce };
      if (store) savePayerRecord(store, next);
      setRec(next);
      return next;
    },
    [client, store],
  );

  const persist = useCallback(
    (next: PayerRecord) => {
      setRec(next);
      if (store) savePayerRecord(store, next);
    },
    [store],
  );

  const apply = useCallback(
    (base: PayerRecord, e: PaymentEvent) => {
      const next = { ...base, machine: transition(base.machine, e) };
      persist(next);
      return next;
    },
    [persist],
  );

  // Parse the amount for reusable links.
  const parsedAmount = useMemo(() => {
    if (!open) return { value: request.amount };
    if (!amountInput.trim()) return { error: null as string | null };
    try {
      const value = parseAmount(amountInput, token.decimals);
      const err = checkLimits(value, limits, token.decimals, token.symbol);
      return err ? { error: err } : { value };
    } catch (e) {
      return { error: e instanceof AmountError ? e.message : "Invalid amount." };
    }
  }, [open, amountInput, request.amount, token.decimals, token.symbol, limits]);

  const runPreflight = useCallback(async () => {
    if (rec || !address || !derivation || amountConfirmed === null) return;
    setChecking(true);
    try {
      setPf(await preflight(client, { network, request, amount: amountConfirmed, payer: address, derivation }));
    } catch (e) {
      setPf({
        ok: false,
        checks: [{ id: "rpc", label: "Checks failed", status: "fail", detail: classifyTxError(e).message }],
        existingPayments: [],
        mode: "direct",
        stipend: 0n,
        needsApproval: false,
      });
    } finally {
      setChecking(false);
    }
  }, [rec, address, derivation, amountConfirmed, client, network, request]);

  useEffect(() => {
    if (!rec && derivation && amountConfirmed !== null && !pf && !checking) void runPreflight();
  }, [rec, derivation, amountConfirmed, pf, checking, runPreflight]);

  const doAnnounce = useCallback(
    async (base: PayerRecord) => {
      if (!wallet) return;
      setBusy("announce");
      let cur = base;
      try {
        const hash = await submitAnnouncement(wallet, {
          network,
          stealthAddress: cur.stealthAddress,
          ephemeralPublicKey: cur.ephemeralPublicKey,
          metadata: cur.metadata,
        });
        cur = apply(cur, { type: "SUBMIT_ANNOUNCEMENT", txHash: hash });
        const receipt = await confirmAnnouncement(client, hash, {
          network,
          stealthAddress: cur.stealthAddress,
          onReplaced: (h) => persist({ ...cur, machine: { ...cur.machine, announcementTx: h } }),
        });
        apply(cur, { type: "ANNOUNCEMENT_CONFIRMED", txHash: receipt.transactionHash });
      } catch (e) {
        apply(cur, { type: "ANNOUNCEMENT_FAILED", reason: classifyTxError(e).message });
      } finally {
        setBusy(null);
      }
    },
    [wallet, network, client, apply, persist],
  );

  const doPay = useCallback(async () => {
    if (!wallet || !address || !derivation || !pf?.ok || amountConfirmed === null) return;
    if (request.expiresAt !== 0 && request.expiresAt <= Math.floor(Date.now() / 1000)) {
      setNotice("This link expired while you were reviewing it.");
      return;
    }
    const amount = amountConfirmed;
    let cur = newPayerRecord(request, address, derivation, token.address, { amount, mode: pf.mode, stipend: pf.stipend });
    setNotice(null);

    // Router mode: the first payment approves QuietPay's router once, for any amount, so every later
    // payment is a single confirmation. Wallets that support batched calls do both in one.
    const routed = pf.mode === "router";
    const payArgs = {
      network,
      token: token.address,
      stealthAddress: cur.stealthAddress,
      amount,
      ephemeralPublicKey: cur.ephemeralPublicKey,
      metadata: cur.metadata,
      stipend: pf.stipend,
      routerVersion: pf.routerVersion,
      requestId: request.kind === "fixed" ? request.requestId : null,
    };
    let batchedHash: Hash | null = null;
    if (routed) {
      try {
        setBusy(pf.needsApproval ? "approve" : "pay");
        // Persist first: a batched approval + payment may land before this page hears back.
        persist(cur);
        const plan = await prepareSpend(wallet, client, {
          chain: network.chain,
          token: token.address,
          spender: network.router!,
          amount,
          payment: routedPaymentCall(payArgs),
          confirmations: network.confirmations,
        });
        if (plan.kind === "approved") cur = { ...cur, approveTx: plan.approveTx };
        if (plan.kind === "batched") batchedHash = plan.hash;
      } catch (e) {
        const c = classifyTxError(e);
        setBusy(null);
        if (store) clearPayerRecord(store, request.requestId);
        setRec(null);
        setNotice(c.kind === "user_rejected" ? "You rejected it in your wallet. Nothing was sent." : c.message);
        return;
      }
    }

    // Persist the derivation before sending so an interrupted payment can be resumed.
    persist(cur);
    setBusy("pay");
    let hash: Hash | null = null;
    try {
      if (routed) {
        hash = batchedHash ?? (await submitRoutedPayment(wallet, payArgs));
        cur = apply(cur, { type: "SUBMIT_PAYMENT", txHash: hash });
        // A batched payment is already confirmed (and may come from a smart account's bundle), so
        // there is no nonce of the payer's to watch.
        if (!batchedHash) cur = await recordNonce(cur, hash);
        const receipt = await confirmRoutedPayment(client, hash, {
          network,
          token: token.address,
          stealthAddress: cur.stealthAddress,
          amount,
          payer: address,
          onReplaced: (h) => persist({ ...cur, machine: { ...cur.machine, paymentTx: h } }),
        });
        apply(cur, { type: "ROUTED_PAYMENT_CONFIRMED", txHash: receipt.transactionHash });
        setBusy(null);
        return;
      }
      hash = await submitPayment(wallet, { network, token: token.address, stealthAddress: cur.stealthAddress, amount });
      cur = apply(cur, { type: "SUBMIT_PAYMENT", txHash: hash });
      cur = await recordNonce(cur, hash);
      const receipt = await confirmPayment(client, hash, {
        network,
        token: token.address,
        stealthAddress: cur.stealthAddress,
        amount,
        payer: address,
        onReplaced: (h) => persist({ ...cur, machine: { ...cur.machine, paymentTx: h } }),
      });
      cur = apply(cur, { type: "PAYMENT_CONFIRMED", txHash: receipt.transactionHash });
    } catch (e) {
      const c = classifyTxError(e);
      setBusy(null);
      if (!hash) {
        if (store) clearPayerRecord(store, request.requestId);
        setRec(null);
        setNotice(c.kind === "user_rejected" ? "You rejected the payment in your wallet. Nothing was sent." : c.message);
      } else if (c.kind === "timeout" || c.kind === "rpc") {
        setNotice(c.message); // stays pending; the same hash can be re-checked, never resent
      } else {
        apply(cur, { type: "PAYMENT_FAILED", reason: c.message, txSubmitted: c.kind !== "reverted" });
      }
      return;
    }
    setBusy(null);
    await doAnnounce(cur);
  }, [wallet, address, derivation, pf, amountConfirmed, request, token.address, client, network, persist, apply, store, doAnnounce]);

  const recheckPayment = useCallback(async () => {
    if (!rec?.machine.paymentTx || !address) return;
    setBusy("recheck");
    setNotice(null);
    const amount = BigInt(rec.amount ?? request.amount.toString());
    // Before waiting again, see whether the transaction was dropped or replaced.
    try {
      const fate = await checkPaymentFate(client, network, rec);
      if (fate.status === "dropped" && rec.machine.state === "pending") {
        const failed = { ...rec, dropped: true, machine: transition(rec.machine, { type: "PAYMENT_FAILED", reason: "The transaction was dropped by the network and never went through. Nothing was sent.", txSubmitted: true }) };
        persist(failed);
        setBusy(null);
        return;
      }
      if (fate.status === "landed" && rec.machine.state === "pending" && fate.hash !== rec.machine.paymentTx) {
        // A replacement transaction (for example a fee bump from the wallet) carried the payment:
        // verify that one instead, exactly as the original would have been.
        const moved = { ...rec, machine: { ...rec.machine, paymentTx: fate.hash } };
        persist(moved);
        const p = { network, token: token.address, stealthAddress: rec.stealthAddress, amount, payer: address };
        if (rec.mode === "router" && fate.announced) {
          const r = await confirmRoutedPayment(client, fate.hash, p);
          apply(moved, { type: "ROUTED_PAYMENT_CONFIRMED", txHash: r.transactionHash });
        } else {
          const r = await confirmPayment(client, fate.hash, p);
          apply(moved, { type: "PAYMENT_CONFIRMED", txHash: r.transactionHash });
        }
        setBusy(null);
        return;
      }
    } catch {
      /* fall through to waiting for the receipt */
    }
    try {
      if (rec.mode === "router") {
        const r = await confirmRoutedPayment(client, rec.machine.paymentTx as Hash, {
          network,
          token: token.address,
          stealthAddress: rec.stealthAddress,
          amount,
          payer: address,
        });
        if (rec.machine.state === "pending") apply(rec, { type: "ROUTED_PAYMENT_CONFIRMED", txHash: r.transactionHash });
      } else {
        const r = await confirmPayment(client, rec.machine.paymentTx as Hash, {
          network,
          token: token.address,
          stealthAddress: rec.stealthAddress,
          amount,
          payer: address,
        });
        // Never chain into a new wallet prompt here: this also runs on page load.
        if (rec.machine.state === "pending") apply(rec, { type: "PAYMENT_CONFIRMED", txHash: r.transactionHash });
      }
    } catch (e) {
      setNotice(classifyTxError(e).message);
    } finally {
      setBusy(null);
    }
  }, [rec, address, request.amount, client, network, token.address, apply]);

  const recheckAnnouncement = useCallback(async () => {
    if (!rec?.machine.announcementTx) return;
    setBusy("announce");
    try {
      const r = await confirmAnnouncement(client, rec.machine.announcementTx as Hash, { network, stealthAddress: rec.stealthAddress });
      apply(rec, { type: "ANNOUNCEMENT_CONFIRMED", txHash: r.transactionHash });
    } catch (e) {
      apply(rec, { type: "ANNOUNCEMENT_FAILED", reason: classifyTxError(e).message });
    } finally {
      setBusy(null);
    }
  }, [rec, client, network, apply]);

  // Resume interrupted work once after reload.
  useEffect(() => {
    if (!rec || resumed.current || !wallet) return;
    if (rec.machine.state === "pending") {
      resumed.current = true;
      void recheckPayment();
    } else if (rec.machine.state === "announcement_pending" && !rec.machine.error && rec.machine.announcementTx) {
      resumed.current = true;
      void recheckAnnouncement();
    }
  }, [rec, wallet, recheckPayment, recheckAnnouncement]);

  const faucet = useCallback(async () => {
    if (!wallet) return;
    setBusy("faucet");
    try {
      const want = amountConfirmed ?? 0n;
      const base = 10n ** BigInt(token.decimals) * 1000n;
      const hash = await wallet.writeContract({
        chain: network.chain,
        account: wallet.account,
        address: token.address,
        abi: mockTokenFaucetAbi,
        functionName: "faucet",
        args: [want > base ? want : base],
      });
      await client.waitForTransactionReceipt({ hash });
      setPf(null);
    } catch (e) {
      setNotice(classifyTxError(e).message);
    } finally {
      setBusy(null);
    }
  }, [wallet, amountConfirmed, token, network.chain, client]);

  if (lookingUp) return <LoadingRows label="Checking whether your earlier payment went through" rows={3} />;

  if (unconfirmed) {
    const amountText = `${formatAmount(BigInt(unconfirmed.amount ?? request.amount.toString()), token.decimals, { group: true })} ${token.symbol}`;
    return (
      <div className="space-y-4">
        <Notice tone="warn" title="You may already have paid">
          You started paying {amountText} to this link from this browser at {new Date(unconfirmed.updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })},
          and the page closed before it finished. If you approved it in your wallet, it may still arrive. Check your wallet&apos;s activity
          before paying again.
        </Notice>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => void checkUnconfirmed(unconfirmed)}>
            Check again
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              if (store) clearPayerRecord(store, request.requestId);
              setUnconfirmed(null);
              freshStart();
            }}
          >
            It didn&apos;t go through, start a new payment
          </button>
        </div>
      </div>
    );
  }

  if (!address || (!rec && !derivation)) return <LoadingRows label="Preparing your one-time payment address" rows={4} />;

  if (rec) {
    const amountText = `${formatAmount(BigInt(rec.amount ?? request.amount.toString()), token.decimals, { group: true })} ${token.symbol}`;
    return (
      <Progress
        rec={rec}
        network={network}
        amountText={amountText}
        busy={busy}
        notice={notice}
        reusable={open}
        onRetryAnnouncement={() => doAnnounce(rec)}
        onRecheck={recheckPayment}
        onPayAgain={() => {
          if (store) clearPayerRecord(store, request.requestId);
          freshStart();
        }}
      />
    );
  }

  // Reusable link: choose an amount first.
  if (amountConfirmed === null) {
    const err = "error" in parsedAmount ? parsedAmount.error : null;
    return (
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if ("value" in parsedAmount && parsedAmount.value) {
            setPf(null);
            setAmountConfirmed(parsedAmount.value);
          }
        }}
        noValidate
      >
        <div>
          <label htmlFor="pay-amount" className="mb-2 block text-sm font-medium text-snow">
            Amount to send
          </label>
          <div className="relative">
            <input
              id="pay-amount"
              className="field pr-20 text-lg"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value.replace(",", "."))}
              aria-invalid={!!err}
              aria-describedby="pay-amount-help"
            />
            <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-haze">{token.symbol}</span>
          </div>
          <p id="pay-amount-help" className={`mt-2 text-xs ${err ? "text-bad" : "text-haze"}`}>
            {err ??
              `Between ${formatAmount(limits.min, token.decimals)} and ${formatAmount(limits.max, token.decimals, { group: true })} ${token.symbol}. Round amounts are harder to trace.`}
          </p>
        </div>
        <button type="submit" className="btn btn-primary w-full" disabled={!("value" in parsedAmount) || !parsedAmount.value}>
          Continue
        </button>
      </form>
    );
  }

  const amountText = `${formatAmount(amountConfirmed, token.decimals, { group: true })} ${token.symbol}`;
  const balanceFail = pf?.checks.find((c) => c.id === "balance")?.status === "fail";
  const routed = pf?.mode === "router";

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
        <dt className="text-haze">Amount</dt>
        <dd className="text-right text-snow">
          {amountText}
          {open && (
            <button type="button" className="ml-3 text-xs text-signal underline underline-offset-4" onClick={() => { setAmountConfirmed(null); setPf(null); }}>
              Change
            </button>
          )}
        </dd>
        <dt className="text-haze">Network</dt>
        <dd className="text-right text-snow">{network.label}</dd>
        <dt className="text-haze">From</dt>
        <dd className="text-right text-snow">
          <Mono>{shorten(address, 6)}</Mono>
        </dd>
        <dt className="text-haze">To (one-time address)</dt>
        <dd className="text-right text-snow">
          <Mono>{shorten(derivation!.stealthAddress, 6)}</Mono>
        </dd>
        {routed && pf && pf.stipend > 0n && (
          <>
            <dt className="text-haze">Recipient's claim fee</dt>
            <dd className="text-right text-snow">{formatEthCeil(pf.stipend)} ETH</dd>
          </>
        )}
      </dl>

      {/* Checks run in the background. Only a problem is shown. */}
      {pf && !checking && pf.checks.some((c) => c.status === "fail") && (
        <div className="space-y-3">
          {pf.checks
            .filter((c) => c.status === "fail")
            .map((c) => (
              <Notice key={c.id} tone="bad">
                {c.detail ?? c.label}
              </Notice>
            ))}
          <div className="flex flex-wrap gap-3">
            {balanceFail && token.isMock && (
              <button type="button" className="btn btn-sm" onClick={faucet} disabled={!!busy}>
                {busy === "faucet" ? <Spinner /> : null} Get test <span className="normal-case tracking-[0.02em]">{token.symbol}</span>
              </button>
            )}
            {pf.checks.find((c) => c.id === "gas")?.status === "fail" && network.chain.testnet && (
              <a className="btn btn-sm btn-quiet" href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noopener noreferrer">
                Testnet ETH faucet
              </a>
            )}
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setPf(null)}>
              Try again
            </button>
          </div>
        </div>
      )}

      {notice && <Notice tone="bad">{notice}</Notice>}

      <button type="button" className="btn btn-primary w-full" disabled={!pf?.ok || checking || !!busy || !wallet} onClick={doPay}>
        {checking || !pf ? (
          <>
            <Spinner /> Getting ready
          </>
        ) : busy === "approve" ? (
          <>
            <Spinner /> Confirm in your wallet
          </>
        ) : (
          <>
            {busy === "pay" ? <Spinner /> : null} Send <span className="normal-case tracking-[0.02em]">{amountText}</span>
          </>
        )}
      </button>
      {pf?.ok && pf.mode === "router" && pf.needsApproval && !busy && (
        <p className="text-center text-xs text-haze">First time only: your wallet asks you to allow QuietPay, then to pay. After that, paying takes one confirmation.</p>
      )}
    </div>
  );
}

function Progress({
  rec,
  network,
  amountText,
  busy,
  notice,
  reusable,
  onRetryAnnouncement,
  onRecheck,
  onPayAgain,
}: {
  rec: PayerRecord;
  network: LinkValidation["network"];
  amountText: string;
  busy: string | null;
  notice: string | null;
  reusable: boolean;
  onRetryAnnouncement: () => void;
  onRecheck: () => void;
  onPayAgain: () => void;
}) {
  const m = rec.machine;
  const routed = rec.mode === "router";
  const paid = m.state === "paid" || m.state === "announcement_pending" || m.state === "claimable" || m.state === "claimed";
  const announced = m.state === "claimable" || m.state === "claimed";
  const stipend = rec.stipend ? BigInt(rec.stipend) : 0n;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-snow">{amountText}</p>
        <StatusPill state={m.state} label={STATE_LABELS[m.state]} />
      </div>
      <ol className="space-y-4 text-sm">
        {routed ? (
          <Step
            n={1}
            title="Payment and announcement"
            done={announced}
            active={m.state === "pending"}
            failed={m.state === "error"}
            detail={
              m.paymentTx ? (
                <>
                  {announced
                    ? `Confirmed in one transaction${stipend > 0n ? `, including ${formatEthCeil(stipend)} ETH for the recipient's claim fee` : ""}.`
                    : m.state === "error"
                      ? "Did not complete."
                      : "Waiting for confirmation…"}{" "}
                  <ExplorerLink network={network} tx={m.paymentTx} />
                </>
              ) : null
            }
          />
        ) : (
          <>
            <Step
              n={1}
              title="Payment"
              done={paid}
              active={m.state === "pending"}
              failed={m.state === "error"}
              detail={
                m.paymentTx ? (
                  <>
                    {paid ? "Confirmed and verified onchain." : m.state === "error" ? "Did not complete." : "Waiting for confirmation…"}{" "}
                    <ExplorerLink network={network} tx={m.paymentTx} />
                  </>
                ) : null
              }
            />
            <Step
              n={2}
              title="Announcement"
              done={announced}
              active={m.state === "announcement_pending" && !m.error}
              failed={m.state === "announcement_pending" && !!m.error}
              detail={
                announced ? (
                  <>
                    Published. The recipient can now find this payment. {m.announcementTx && <ExplorerLink network={network} tx={m.announcementTx} />}
                  </>
                ) : m.announcementTx ? (
                  <>
                    {m.error ? "Not confirmed." : "Waiting for confirmation…"} <ExplorerLink network={network} tx={m.announcementTx} />
                  </>
                ) : paid ? (
                  "Needed so the recipient can discover the payment."
                ) : null
              }
            />
          </>
        )}
      </ol>

      {m.state === "error" && !rec.dropped && (
        <Notice tone="bad" title="Payment did not complete">
          {m.error} Check the explorer before trying anything else. QuietPay will not send this payment again from this browser.
        </Notice>
      )}
      {m.state === "error" && rec.dropped && (
        <div className="space-y-3">
          <Notice tone="warn" title="This payment never went through">
            {m.error} QuietPay checked: your wallet used that transaction&apos;s slot for something else and no money reached the payment
            address, so it can&apos;t go through later. You can safely pay again.
          </Notice>
          <button type="button" className="btn btn-primary w-full" onClick={onPayAgain}>
            Start a new payment
          </button>
        </div>
      )}
      {m.state === "pending" && notice && (
        <div className="space-y-3">
          <Notice tone="warn">{notice}</Notice>
          <button type="button" className="btn btn-sm" onClick={onRecheck} disabled={!!busy}>
            {busy === "recheck" ? <Spinner /> : null} Check again
          </button>
        </div>
      )}
      {!routed && canSendAnnouncement(m) && busy !== "announce" && (
        <div className="space-y-3">
          {m.error && (
            <Notice tone="warn" title="Payment sent, announcement not yet published">
              Your {amountText} payment is confirmed. Only the announcement needs to be sent; this will not resend the payment. {m.error}
            </Notice>
          )}
          <button type="button" className="btn btn-primary w-full" onClick={onRetryAnnouncement}>
            {m.error ? "Retry announcement" : "Publish announcement"}
          </button>
        </div>
      )}
      {busy === "announce" && (
        <p className="text-sm text-haze">
          <Spinner /> Confirm the announcement in your wallet…
        </p>
      )}
      {announced && (
        <Notice tone="ok" title="Payment complete">
          The payment {routed ? "is" : "and its announcement are"} confirmed. You can close this page.
        </Notice>
      )}
      {announced && reusable && (
        <button type="button" className="btn btn-quiet w-full" onClick={onPayAgain}>
          Make another payment to this link
        </button>
      )}
    </div>
  );
}

function Step({ n, title, done, active, failed, detail }: { n: number; title: string; done: boolean; active: boolean; failed: boolean; detail: React.ReactNode }) {
  const tone = done ? "border-ok text-ok" : failed ? "border-bad text-bad" : active ? "border-warn text-warn" : "border-harbor text-haze";
  return (
    <li className="flex gap-4">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold ${tone}`}>
        {active ? <Spinner className="h-3 w-3" /> : n}
      </span>
      <div className="pt-0.5">
        <p className="font-medium text-snow">
          {title}
          {done && <span className="ml-2 font-display text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ok">Confirmed</span>}
          {failed && <span className="ml-2 font-display text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-bad">Not confirmed</span>}
        </p>
        {detail && <p className="mt-0.5 text-haze">{detail}</p>}
      </div>
    </li>
  );
}
