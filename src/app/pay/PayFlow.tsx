"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import type { Hash } from "viem";
import { mockTokenFaucetAbi } from "@/config/contracts";
import { formatAmount } from "@/lib/amount";
import { extractLinkCode, validatePaymentLink, type LinkValidation } from "@/lib/link";
import {
  confirmAnnouncement,
  confirmPayment,
  loadPayerRecord,
  newPayerRecord,
  preflight,
  savePayerRecord,
  submitAnnouncement,
  submitPayment,
  type PayerRecord,
  type PreflightResult,
} from "@/lib/payer";
import { canSendAnnouncement, canSendPayment, STATE_LABELS, transition, type PaymentEvent } from "@/lib/payment-state";
import { deriveStealthPayment } from "@/lib/stealth";
import { classifyTxError } from "@/lib/tx-errors";
import { browserStore } from "@/lib/vault";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { PrivacyStatement } from "@/components/PrivacyStatement";
import { SetupBlocker } from "@/components/SetupBlocker";
import { CheckList, Countdown, ExplorerLink, LoadingRows, Mono, Notice, PageTitle, Skeleton, Spinner, StatusPill, shorten } from "@/components/ui";
import { WalletGate } from "@/components/WalletGate";

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

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="text-sm text-haze">Payment request</p>
        <p className="mt-1 font-display text-4xl font-light text-snow">
          {token ? (
            <>
              {formatAmount(request.amount, token.decimals, { group: true })} <span className="text-xl text-haze">{token.symbol}</span>
            </>
          ) : (
            <Skeleton className="mx-auto mt-1 h-10 w-44" />
          )}
        </p>
        <p className="mt-2 text-sm text-haze">
          {network.label} · <Countdown to={request.expiresAt} />
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
  const { address } = useAccount();
  const { data: wallet } = useWalletClient({ chainId: network.chain.id });
  const client = usePublicClient(network);
  const { data: readiness } = useNetworkReadiness(network);
  const token = readiness!.token!;
  const store = useMemo(() => browserStore(), []);

  const [rec, setRec] = useState<PayerRecord | null>(null);
  const [pf, setPf] = useState<PreflightResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const resumed = useRef(false);

  // Load an existing local record for this link (resume), or derive a fresh stealth address.
  useEffect(() => {
    if (!address) return;
    const existing = store ? loadPayerRecord(store, request.requestId) : null;
    if (existing && existing.payer.toLowerCase() === address.toLowerCase() && existing.machine.paymentSubmitted) {
      setRec(existing);
    } else {
      setRec(newPayerRecord(request, address, deriveStealthPayment(request.stealthMetaAddress), token.address));
    }
  }, [address, request, store, token.address]);

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

  const runPreflight = useCallback(async () => {
    if (!rec || !address || rec.machine.paymentSubmitted) return;
    setChecking(true);
    try {
      setPf(
        await preflight(client, {
          network,
          request,
          payer: address,
          derivation: { stealthAddress: rec.stealthAddress, ephemeralPublicKey: rec.ephemeralPublicKey, viewTag: rec.viewTag },
        }),
      );
    } catch (e) {
      setPf({ ok: false, checks: [{ id: "rpc", label: "Checks failed", status: "fail", detail: classifyTxError(e).message }], existingPayments: [] });
    } finally {
      setChecking(false);
    }
  }, [rec, address, client, network, request]);

  useEffect(() => {
    if (rec && !rec.machine.paymentSubmitted && !pf && !checking) void runPreflight();
  }, [rec, pf, checking, runPreflight]);

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
    if (!rec || !wallet || !address || !pf?.ok || !canSendPayment(rec.machine)) return;
    // Final guard: refuse if expired since the checks ran.
    if (request.expiresAt <= Math.floor(Date.now() / 1000)) {
      setNotice("This link expired while you were reviewing it.");
      return;
    }
    setBusy("pay");
    setNotice(null);
    // Persist the derivation before sending so the announcement can always be retried.
    persist(rec);
    let cur = rec;
    let hash: Hash | null = null;
    try {
      hash = await submitPayment(wallet, { network, token: token.address, stealthAddress: rec.stealthAddress, amount: request.amount });
      cur = apply(cur, { type: "SUBMIT_PAYMENT", txHash: hash });
      const receipt = await confirmPayment(client, hash, {
        network,
        token: token.address,
        stealthAddress: rec.stealthAddress,
        amount: request.amount,
        payer: address,
        onReplaced: (h) => persist({ ...cur, machine: { ...cur.machine, paymentTx: h } }),
      });
      cur = apply(cur, { type: "PAYMENT_CONFIRMED", txHash: receipt.transactionHash });
    } catch (e) {
      const c = classifyTxError(e);
      setBusy(null);
      if (!hash) {
        cur = apply(cur, c.kind === "user_rejected" ? { type: "USER_REJECTED" } : { type: "PAYMENT_FAILED", reason: c.message, txSubmitted: false });
      } else if (c.kind === "timeout" || c.kind === "rpc") {
        setNotice(c.message); // stays pending; user can re-check without resending
      } else {
        // Reverted with no transfer is safe to retry; replaced/cancelled is not.
        apply(cur, { type: "PAYMENT_FAILED", reason: c.message, txSubmitted: c.kind !== "reverted" });
      }
      return;
    }
    setBusy(null);
    await doAnnounce(cur);
  }, [rec, wallet, address, pf, request, network, token.address, client, apply, persist, doAnnounce]);

  const recheckPayment = useCallback(async () => {
    if (!rec?.machine.paymentTx || !address) return;
    setBusy("recheck");
    setNotice(null);
    let cur = rec;
    try {
      const receipt = await confirmPayment(client, rec.machine.paymentTx as Hash, {
        network,
        token: token.address,
        stealthAddress: rec.stealthAddress,
        amount: request.amount,
        payer: address,
      });
      // Never chain into a new wallet prompt here: this also runs on page load. The user
      // publishes the announcement with an explicit click.
      if (cur.machine.state === "pending") apply(cur, { type: "PAYMENT_CONFIRMED", txHash: receipt.transactionHash });
      setBusy(null);
    } catch (e) {
      setNotice(classifyTxError(e).message);
      setBusy(null);
    }
  }, [rec, address, client, network, token.address, request.amount, apply]);

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
      const amount = request.amount > 10n ** BigInt(token.decimals) * 1000n ? request.amount : 10n ** BigInt(token.decimals) * 1000n;
      const hash = await wallet.writeContract({
        chain: network.chain,
        account: wallet.account,
        address: token.address,
        abi: mockTokenFaucetAbi,
        functionName: "faucet",
        args: [amount],
      });
      await client.waitForTransactionReceipt({ hash });
      setPf(null);
    } catch (e) {
      setNotice(classifyTxError(e).message);
    } finally {
      setBusy(null);
    }
  }, [wallet, request.amount, token, network.chain, client]);

  if (!rec || !address) return <LoadingRows label="Preparing your one-time payment address" rows={4} />;
  const m = rec.machine;
  const amountText = `${formatAmount(request.amount, token.decimals, { group: true })} ${token.symbol}`;

  if (m.paymentSubmitted || m.state === "paid" || m.state === "announcement_pending" || m.state === "claimable") {
    return (
      <Progress
        rec={rec}
        network={network}
        amountText={amountText}
        busy={busy}
        notice={notice}
        onRetryAnnouncement={() => doAnnounce(rec)}
        onRecheck={recheckPayment}
      />
    );
  }

  const balanceFail = pf?.checks.find((c) => c.id === "balance")?.status === "fail";

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
        <dt className="text-haze">Amount</dt>
        <dd className="text-right text-snow">{amountText}</dd>
        <dt className="text-haze">Network</dt>
        <dd className="text-right text-snow">{network.label}</dd>
        <dt className="text-haze">From</dt>
        <dd className="text-right text-snow">
          <Mono>{shorten(address, 6)}</Mono>
        </dd>
        <dt className="text-haze">To (one-time address)</dt>
        <dd className="text-right text-snow">
          <Mono>{shorten(rec.stealthAddress, 6)}</Mono>
        </dd>
      </dl>

      <div className="border-t border-harbor pt-5">
        {checking || !pf ? (
          <LoadingRows label="Running checks onchain" rows={6} />
        ) : (
          <CheckList checks={pf.checks} />
        )}
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

      {m.state === "expired" && <Notice tone="bad">This link has expired.</Notice>}
      {m.error && <Notice tone="bad">{m.error}</Notice>}
      {notice && <Notice tone="bad">{notice}</Notice>}

      <label className="flex cursor-pointer gap-3 text-sm leading-relaxed text-mist">
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[#5bb8ea]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I understand this is not anonymous: my wallet, the amount, the one-time address and the time will be public. Send {amountText} in two transactions: the payment, then an announcement so the recipient can find it.</span>
      </label>

      <button type="button" className="btn btn-primary w-full" disabled={!ack || !pf?.ok || !!busy || !wallet} onClick={doPay}>
        {busy === "pay" ? <Spinner /> : null} Send <span className="normal-case tracking-[0.02em]">{amountText}</span>
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
  onRetryAnnouncement,
  onRecheck,
}: {
  rec: PayerRecord;
  network: LinkValidation["network"];
  amountText: string;
  busy: string | null;
  notice: string | null;
  onRetryAnnouncement: () => void;
  onRecheck: () => void;
}) {
  const m = rec.machine;
  const paid = m.state === "paid" || m.state === "announcement_pending" || m.state === "claimable" || m.state === "claimed";
  const announced = m.state === "claimable" || m.state === "claimed";
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-snow">{amountText}</p>
        <StatusPill state={m.state} label={STATE_LABELS[m.state]} />
      </div>
      <ol className="space-y-4 text-sm">
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
      {canSendAnnouncement(m) && busy !== "announce" && (
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
      {announced && <Notice tone="ok" title="Payment complete">The payment and its announcement are confirmed. You can close this page.</Notice>}
    </div>
  );
}

function Step({ n, title, done, active, failed, detail }: { n: number; title: string; done: boolean; active: boolean; failed: boolean; detail: React.ReactNode }) {
  const tone = done ? "border-ok text-ok" : failed ? "border-bad text-bad" : active ? "border-warn text-warn" : "border-harbor text-haze";
  return (
    <li className="flex gap-4">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[2px] border text-xs font-semibold ${tone}`}>
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
