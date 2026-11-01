"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import type { Hash } from "viem";
import { mockTokenFaucetAbi } from "@/config/contracts";
import { PAYMENT_LIMITS } from "@/config/networks";
import { AmountError, checkLimits, formatAmount, limitsFor, parseAmount } from "@/lib/amount";
import { extractLinkCode, validatePaymentLink, type LinkValidation } from "@/lib/link";
import {
  approveRouterIfNeeded,
  clearPayerRecord,
  confirmAnnouncement,
  confirmPayment,
  confirmRoutedPayment,
  loadPayerRecord,
  newPayerRecord,
  preflight,
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
import { PrivacyStatement } from "@/components/PrivacyStatement";
import { SetupBlocker } from "@/components/SetupBlocker";
import { CheckList, Countdown, ExplorerLink, LoadingRows, Mono, Notice, PageTitle, Skeleton, Spinner, StatusPill, shorten } from "@/components/ui";
import { WalletGate } from "@/components/WalletGate";
import { formatEthCeil } from "@/components/ui";

export function PayFlow() {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    const read = () => setCode(window.location.hash.length > 1 ? window.location.hash.slice(1) : "");
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const validation = useMemo<{ ok: LinkValidation } | { error: string } | null>(() => {
    if (!code) return null;
    try {
      return { ok: validatePaymentLink(code) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [code]);

  return (
    <div className="mx-auto max-w-xl px-4 pt-6 sm:px-6">
      <PageTitle light="Pay a" bold="payment link">
        Your payment goes to an address created for this payment alone. QuietPay checks the link before you connect anything.
      </PageTitle>
      <div className="panel p-5 sm:p-7">
        {code === null ? (
          <LoadingRows label="Reading the payment link" rows={3} />
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
      <div className="mt-8">
        <PrivacyStatement compact />
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
        </p>
      </div>
      {readiness.isLoading ? (
        <LoadingRows label="Verifying the token and announcer contracts" rows={2} />
      ) : token && readiness.data?.announcer ? (
        <>
          {token.isMock && (
            <Notice tone="warn" title="Testnet mock token">
              {token.symbol} is a QuietPay test token with no value. It is not USDG.
            </Notice>
          )}
          <WalletGate network={network} purpose="Connect the wallet you'll pay from. You'll review everything before anything is sent.">
            <PayerPanel v={v} code={code} />
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
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const resumed = useRef(false);

  const freshStart = useCallback(() => {
    setRec(null);
    setPf(null);
    setAck(false);
    setNotice(null);
    setAmountInput("");
    setAmountConfirmed(open ? null : request.amount);
    setDerivation(deriveStealthPayment(request.stealthMetaAddress));
    resumed.current = false;
  }, [open, request]);

  // Resume a payment this browser already submitted for this link, otherwise start fresh.
  useEffect(() => {
    if (!address) return;
    const existing = store ? loadPayerRecord(store, request.requestId) : null;
    if (existing && existing.payer.toLowerCase() === address.toLowerCase() && existing.machine.paymentSubmitted) {
      setRec(existing);
    } else {
      freshStart();
    }
  }, [address, request.requestId, store, freshStart]);

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

    // Router mode: exact approval first if needed (moves no funds).
    if (pf.mode === "router") {
      try {
        setBusy("approve");
        const approveTx = await approveRouterIfNeeded(wallet, client, { network, token: token.address, owner: address, amount });
        if (approveTx) cur = { ...cur, approveTx };
      } catch (e) {
        const c = classifyTxError(e);
        setBusy(null);
        setNotice(c.kind === "user_rejected" ? "You rejected the approval. Nothing was sent." : c.message);
        return;
      }
    }

    // Persist the derivation before sending so an interrupted payment can be resumed.
    persist(cur);
    setBusy("pay");
    let hash: Hash | null = null;
    try {
      if (pf.mode === "router") {
        hash = await submitRoutedPayment(wallet, {
          network,
          token: token.address,
          stealthAddress: cur.stealthAddress,
          amount,
          ephemeralPublicKey: cur.ephemeralPublicKey,
          metadata: cur.metadata,
          stipend: pf.stipend,
        });
        cur = apply(cur, { type: "SUBMIT_PAYMENT", txHash: hash });
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

      <div className="border-t border-harbor pt-5">
        {checking || !pf ? <LoadingRows label="Running checks onchain" rows={6} /> : <CheckList checks={pf.checks} />}
        {pf && !checking && (
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setPf(null)}>
              Run checks again
            </button>
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
          </div>
        )}
      </div>

      {notice && <Notice tone="bad">{notice}</Notice>}

      <label className="flex cursor-pointer gap-3 text-sm leading-relaxed text-mist">
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-signal)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>
          I understand this is not anonymous: my wallet, the amount, the one-time address and the time will be public.{" "}
          {routed
            ? pf?.needsApproval
              ? `Send ${amountText} after approving exactly that amount for the QuietPay router.`
              : `Send ${amountText} in one transaction.`
            : `Send ${amountText} in two transactions: the payment, then an announcement so the recipient can find it.`}
        </span>
      </label>

      <button type="button" className="btn btn-primary w-full" disabled={!ack || !pf?.ok || !!busy || !wallet} onClick={doPay}>
        {busy === "approve" ? (
          <>
            <Spinner /> Approve in your wallet
          </>
        ) : (
          <>
            {busy === "pay" ? <Spinner /> : null} Send <span className="normal-case tracking-[0.02em]">{amountText}</span>
          </>
        )}
      </button>
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

      {m.state === "error" && (
        <Notice tone="bad" title="Payment did not complete">
          {m.error} Check the explorer before trying anything else. QuietPay will not send this payment again from this browser.
        </Notice>
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
