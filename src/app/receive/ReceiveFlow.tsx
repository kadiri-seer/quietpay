"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { getAddress, isAddress, type Address } from "viem";
import type { NetworkConfig } from "@/config/networks";
import { AmountError, formatAmount, parseAmount } from "@/lib/amount";
import { buildPayUrl } from "@/lib/link";
import { estimateSweepCost, leftoverEth, recordSend, sendFromStealthPayment, stealthBalances, sweepLeftoverEth } from "@/lib/receive";
import { classifyTxError } from "@/lib/tx-errors";
import { usePoolSnapshot } from "@/components/pool-hooks";
import { usePaymentScan } from "@/components/scan-hooks";
import { isExpired, requestStatus, type StoredPayment, type StoredRequest } from "@/lib/vault";
import { STATE_LABELS } from "@/lib/payment-state";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { useSelectedNetwork } from "@/components/Providers";
import { SetupBlocker } from "@/components/SetupBlocker";
import { CopyButton, Countdown, formatEthCeil, LoadingRows, ExplorerLink, Mono, Notice, Spinner, StatusPill, formatDateTime, shorten } from "@/components/ui";
import { useVault } from "@/components/VaultProvider";
import { VaultGate, WalletGate } from "@/components/WalletGate";
import { usePoolInfo } from "@/components/pool-hooks";
import { ShieldForm } from "./ShieldForm";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { privateKeyToAccount } from "viem/accounts";
import { RequestPanel } from "@/app/create/CreateFlow";
import { usePoolRouter } from "@/components/pool-hooks";
import { personalLinkUrl } from "@/lib/pool/locks";
import { QR } from "@/components/ui";
import { poolRouterAbi } from "@/lib/pool/receive";
import { spareIndex } from "@/lib/pool/request-sig";

type Tab = "link" | "request";

export function ReceiveFlow() {
  const { network } = useSelectedNetwork();
  return (
    <div className="mx-auto max-w-xl px-4 pt-6 sm:px-6">
      <h1 className="mb-6 font-display text-[2rem] font-bold leading-[1.08] tracking-[-0.03em] text-snow sm:text-[2.6rem]">Receive</h1>
      <div className="panel p-5 sm:p-7">
        <WalletGate network={network} purpose="Connect the wallet you use with QuietPay. Its signature unlocks your keys on this device.">
          <VaultGate>
            <ReceiveHub network={network} />
          </VaultGate>
        </WalletGate>
      </div>
    </div>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "link", label: "Personal link" },
  { id: "request", label: "Request" },
];

function ReceiveHub({ network }: { network: NetworkConfig }) {
  const [tab, setTab] = useState<Tab>("link");
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "link" || t === "request") setTab(t);
  }, []);
  const choose = (t: Tab) => {
    setTab(t);
    const u = new URL(window.location.href);
    u.searchParams.set("tab", t);
    window.history.replaceState(null, "", u);
  };
  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="Ways to receive" className="grid grid-cols-2 gap-1 rounded-xl border border-harbor p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => choose(t.id)}
            className={`rounded-lg px-2 py-2.5 text-sm font-medium ${tab === t.id ? "bg-snow text-abyss" : "text-mist hover:text-snow"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "link" && <PersonalLinkCard network={network} />}
      {tab === "request" && (
        <div className="space-y-10">
          <RequestPanel />
          <Dashboard network={network} />
        </div>
      )}
    </div>
  );
}

/** Whether payments can reach you yet: locks are uploaded in the background by LockKeeper. */
function useReceiveReady(network: NetworkConfig, key: Address | null) {
  const router = usePoolRouter(network);
  const q = useQuery({
    queryKey: ["lock-counts", key],
    enabled: !!key && !!router.data,
    refetchInterval: (query) => ((query.state.data as { available: number } | undefined)?.available ? 60_000 : 4_000),
    queryFn: async () => {
      const r = await fetch(`/api/locks?key=${key}&counts=1`, { cache: "no-store" });
      if (!r.ok) throw new Error("unavailable");
      return (await r.json()) as { available: number; total: number };
    },
  });
  if (!network.pool?.router || router.isError) return "unavailable" as const;
  if (q.isError) return "unavailable" as const;
  if (!q.data) return "checking" as const;
  return q.data.available > 0 ? ("ready" as const) : ("preparing" as const);
}

function ReadyNote({ state }: { state: ReturnType<typeof useReceiveReady> }) {
  if (state === "ready") return <p className="text-center text-sm text-haze">Payments go straight into your shielded balance.</p>;
  if (state === "unavailable") return <Notice tone="warn">Receiving by personal link isn&apos;t available right now. Use a request instead.</Notice>;
  return (
    <p className="flex items-center justify-center gap-2 text-sm text-haze" aria-live="polite">
      <Spinner className="h-3 w-3" /> Getting ready to receive payments…
    </p>
  );
}

function ShareBlock({ url, label }: { url: string; label: string }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        <QR value={url} />
      </div>
      <div className="flex gap-2">
        <input aria-label={label} className="field font-mono text-base sm:text-xs" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <CopyButton value={url} className="min-h-[2.9rem]" />
      </div>
    </div>
  );
}

function PersonalLinkCard({ network }: { network: NetworkConfig }) {
  const { vault } = useVault();
  const key = vault?.nameKey ? privateKeyToAccount(vault.nameKey).address : null;
  const state = useReceiveReady(network, key);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  if (!key) return <Notice tone="warn">Unlock again to set up your personal link.</Notice>;
  return (
    <div className="space-y-5">
      <p className="text-center text-sm leading-relaxed text-mist">One link for anyone to pay you any amount, as many times as they like. It never shows your wallet.</p>
      {origin && <ShareBlock url={personalLinkUrl(origin, key)} label="Your personal link" />}
      <ReadyNote state={state} />
    </div>
  );
}

function Dashboard({ network }: { network: NetworkConfig }) {
  const { vault } = useVault();
  const readiness = useNetworkReadiness(network);
  const { scan, cancel, scanning, progress, message: scanMsg } = usePaymentScan(network);
  const requests = useMemo(() => (vault?.requests ?? []).filter((r) => r.chainId === network.chain.id), [vault, network.chain.id]);
  const token = readiness.data?.token;

  // On a device that hasn't checked yet (new phone, cleared data), recover links automatically.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !vault || vault.linksCheckedAt || !token || !network.announcer) return;
    autoRan.current = true;
    void scan(true);
  }, [vault, token, network.announcer, scan]);

  if (readiness.isLoading) return <LoadingRows label={`Checking ${network.label} contracts`} rows={4} />;
  if (!readiness.data?.announcer || !readiness.data?.token)
    return <SetupBlocker network={network} readiness={readiness.data} error={readiness.error} />;

  const setAside = vault?.quarantine?.length ?? 0;
  return (
    <div className="space-y-8">
      {setAside > 0 && (
        <Notice tone="warn" title="Some saved records couldn't be read">
          {setAside === 1 ? "One saved record was" : `${setAside} saved records were`} damaged or in an unexpected format, so QuietPay set{" "}
          {setAside === 1 ? "it" : "them"} aside instead of using {setAside === 1 ? "it" : "them"}. Nothing was deleted, and balances don&apos;t
          count {setAside === 1 ? "it" : "them"}. Your links and money can still be found from your wallet with Search full history.
        </Notice>
      )}

      <section aria-labelledby="links-h" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="links-h" className="font-display text-lg font-semibold tracking-[-0.01em] text-snow">
            Your requests <span className="font-normal text-haze">({requests.length})</span>
          </h2>
          {scanning ? (
            <button type="button" className="btn btn-sm btn-quiet" onClick={cancel}>
              <Spinner /> {progress}% · Cancel
            </button>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => scan(true)} title="Look through the whole chain history for links this wallet made on other devices">
                Search full history
              </button>
              <button type="button" className="btn btn-sm" onClick={() => scan(false)}>
                Scan for payments
              </button>
            </div>
          )}
        </div>
        {scanning && (
          <div className="h-1 overflow-hidden rounded bg-harbor" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-signal" style={{ width: `${progress}%` }} />
          </div>
        )}
        {scanMsg && <p className="text-sm text-haze" aria-live="polite">{scanMsg}</p>}
        <p className="text-xs leading-relaxed text-haze">
          Scanning asks the public RPC for all announcements in a block range. The RPC can see your IP address and which blocks you read, but
          never your keys.
        </p>
        {requests.length === 0 ? (
          <div className="rounded-xl border border-dashed border-harbor px-5 py-8 text-center text-sm text-haze">
            {scanning ? (
              "Looking for links this wallet already made…"
            ) : (
              <>
                No requests on {network.label} yet.
              </>
            )}
          </div>
        ) : (
          <ul className="space-y-4">
            {requests.map((r) => (
              <RequestCard key={r.id} request={r} network={network} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RequestCard({ request, network }: { request: StoredRequest; network: NetworkConfig }) {
  // A link that pays into the pool: its payment is a pool note (found by its lock), not a
  // payment at a one-time address.
  const snap = usePoolSnapshot(network);
  const client = usePublicClient(network);
  // Signed requests (router v2): paid only when the router recorded a full payment, which may have
  // gone into the link's own lock or one of its spares.
  const signed = request.pool?.requestKey && request.pool.router ? { key: request.pool.requestKey, router: request.pool.router } : null;
  const paidQ = useQuery({
    queryKey: ["request-paid", signed?.router, signed?.key],
    enabled: !!signed,
    refetchInterval: (q) => (q.state.data ? false : 15_000),
    queryFn: () => client.readContract({ address: signed!.router, abi: poolRouterAbi, functionName: "requestPaid", args: [signed!.key] }),
  });
  const lockIndexes = request.pool ? [BigInt(request.pool.receiveIndex), ...[0, 1, 2, 3].map((j) => spareIndex(request.pool!.receiveIndex, j))] : [];
  const lockNotes = request.pool ? (snap.data?.notes ?? []).filter((n) => n.received && lockIndexes.includes(n.received.receiveIndex)) : [];
  const poolNote = signed ? (paidQ.data ? lockNotes.find((n) => n.deposit.value > 0n) ?? lockNotes[0] : undefined) : lockNotes.find((n) => n.received!.receiveIndex === lockIndexes[0]);
  // Money someone put into this link's lock without paying the request in full (it's yours anyway).
  const stray = signed && !paidQ.data ? lockNotes : [];
  const status = poolNote || (signed && paidQ.data) ? "claimed" : requestStatus(request);
  const open = request.kind === "open";
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const fmt = (v: bigint) => `${formatAmount(v, request.decimals, { group: true })} ${request.symbol}`;
  const total = request.payments.reduce((sum, p) => sum + (p.transferVerified && p.receivedAmount ? BigInt(p.receivedAmount) : 0n), 0n);
  const shareable = !poolNote && !!request.link && !request.recovered && !isExpired(request) && (open || status === "created");
  return (
    <li className="rounded-xl border border-harbor bg-abyss/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-xl font-semibold tracking-[-0.02em] text-snow">
            {request.recovered ? (open ? "Recovered reusable link" : "Recovered one-time link") : open ? "Any amount" : fmt(BigInt(request.amount))}
          </p>
          <p className="mt-1 text-xs text-haze">
            {request.recovered ? (
              `Found from your wallet · first paid ${formatDateTime(request.createdAt)}`
            ) : (
              <>
                {open ? "Reusable link" : "One-time link"} · created {formatDateTime(request.createdAt)} ·{" "}
              </>
            )}
            {request.recovered ? null : request.expiresAt === 0 ? (
              "never expires"
            ) : isExpired(request) ? (
              `expired ${formatDateTime(request.expiresAt * 1000)}`
            ) : (
              <Countdown to={request.expiresAt} />
            )}
          </p>
          {open && request.payments.length > 0 && (
            <p className="mt-1 text-sm text-mist">
              {request.payments.length} payment{request.payments.length === 1 ? "" : "s"}, {fmt(total)} received
            </p>
          )}
        </div>
        <StatusPill state={status} label={poolNote || (signed && paidQ.data) ? "In your pool balance" : STATE_LABELS[status]} />
      </div>
      {request.pool && (
        <p className="mt-2 text-sm text-mist">
          {poolNote ? (
            <>
              Paid {fmt(poolNote.deposit.value)} straight into your shielded pool ·{" "}
              <a href="/pool" className="underline underline-offset-4 hover:text-snow">
                Pool
              </a>
            </>
          ) : signed && paidQ.data ? (
            "Paid in full, straight into your shielded pool balance."
          ) : (
            "Pays straight into your shielded pool balance."
          )}
        </p>
      )}
      {stray.length > 0 && (
        <p className="mt-2 text-xs text-haze">
          Someone deposited {fmt(stray.reduce((t, n) => t + n.deposit.value, 0n))} into this link&apos;s lock without paying the request. It&apos;s in
          your balance, and the link can still be paid in full.
        </p>
      )}
      {shareable && origin && (
        <div className="mt-3">
          <CopyButton value={buildPayUrl(origin, request.link)} label="Copy link" />
        </div>
      )}
      {request.payments.length > 0 && (
        <ul className="mt-4 space-y-5 border-t border-harbor pt-4">
          {[...request.payments]
            .sort((x, y) => y.detectedAt - x.detectedAt)
            .map((p) => (
              <PaymentRow key={p.stealthAddress} request={request} payment={p} network={network} />
            ))}
        </ul>
      )}
    </li>
  );
}

function PaymentRow({ request, payment, network }: { request: StoredRequest; payment: StoredPayment; network: NetworkConfig }) {
  const received = payment.receivedAmount ? BigInt(payment.receivedAmount) : 0n;
  const mismatch = request.kind !== "open" && !request.recovered && payment.transferVerified && received !== BigInt(request.amount);
  const sent =
    (payment.sends ?? []).reduce((s, x) => s + BigInt(x.amount), 0n) - (payment.returns ?? []).reduce((s, x) => s + BigInt(x.amount), 0n);
  const fmt = (v: bigint) => `${formatAmount(v, request.decimals, { group: true })} ${request.symbol}`;
  return (
    <li className="space-y-3 text-sm">
      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        <p>
          <span className="text-haze">Received </span>
          <span className="text-snow">{payment.transferVerified ? fmt(received) : "No verified transfer"}</span>
        </p>
        <p>
          <span className="text-haze">Detected </span>
          <span className="text-snow">{formatDateTime(payment.detectedAt)}</span>
        </p>
        <p>
          <span className="text-haze">Address </span>
          <ExplorerLink network={network} address={payment.stealthAddress} />
        </p>
        <p>
          <span className="text-haze">Status </span>
          <span className="text-snow">
            {payment.claimTx
              ? "Fully moved"
              : !payment.transferVerified
                ? "Announced, awaiting funds"
                : sent > 0n
                  ? `${fmt(received - sent)} left`
                  : "Ready to move"}
          </span>
        </p>
      </div>
      {(payment.sends ?? []).length > 0 && (
        <ul className="space-y-1 text-xs text-haze">
          {(payment.returns ?? []).map((x) => (
            <li key={x.tx}>
              {fmt(BigInt(x.amount))} came back from the pool · <ExplorerLink network={network} tx={x.tx} />
            </li>
          ))}
          {payment.sends!.map((x) => (
            <li key={x.tx}>
              {network.pool && x.to.toLowerCase() === network.pool.entrypoint.toLowerCase() ? (
                <>
                  Shielded {fmt(BigInt(x.amount))} in the{" "}
                  <a href="/pool" className="text-signal underline underline-offset-4">
                    pool
                  </a>
                </>
              ) : (
                <>
                  Sent {fmt(BigInt(x.amount))} to <Mono>{shorten(x.to, 4)}</Mono>
                </>
              )}{" "}
              · <ExplorerLink network={network} tx={x.tx} />
              <DeliveryStatus depositTx={x.tx} network={network} fmt={fmt} />
            </li>
          ))}
        </ul>
      )}
      {mismatch && <Notice tone="warn">The amount received differs from the amount requested.</Notice>}
      {!payment.claimTx && payment.transferVerified && <SendPanel request={request} payment={payment} network={network} />}
      {payment.claimTx && <LeftoverGas request={request} payment={payment} network={network} />}
    </li>
  );
}

/**
 * The payer's gas money that a one-time address didn't use. It's small, so this stays out of the
 * way: one link to check it, then an address to send it to.
 */
function LeftoverGas({ request, payment, network }: { request: StoredRequest; payment: StoredPayment; network: NetworkConfig }) {
  const client = usePublicClient(network);
  const [state, setState] = useState<"idle" | "checking" | "ready" | "sending" | "done">("idle");
  const [movable, setMovable] = useState(0n);
  const [dest, setDest] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const destAddr = isAddress(dest.trim(), { strict: false }) ? getAddress(dest.trim()) : null;

  async function check() {
    setState("checking");
    setMsg(null);
    try {
      const l = await leftoverEth(client, payment.stealthAddress);
      setMovable(l.movable);
      setState(l.movable > 0n ? "ready" : "idle");
      if (l.movable === 0n) setMsg(l.eth > 0n ? "The ETH left here is less than the fee to move it." : "No ETH left at this address.");
    } catch (e) {
      setState("idle");
      setMsg(classifyTxError(e).message);
    }
  }

  async function send() {
    if (!destAddr) return;
    setState("sending");
    setMsg(null);
    try {
      const r = await sweepLeftoverEth(client, network, { request, payment, to: destAddr });
      setState("done");
      setMsg(`Sent ${formatEthCeil(r.amount)} ETH.`);
    } catch (e) {
      setState("ready");
      setMsg(e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message);
    }
  }

  if (state === "idle" || state === "checking") {
    return (
      <p className="text-xs text-haze">
        <button type="button" className="underline underline-offset-2 hover:text-snow disabled:opacity-50" disabled={state === "checking"} onClick={check}>
          {state === "checking" ? "Checking…" : "Check for leftover gas ETH"}
        </button>
        {msg && <span className="ml-2">{msg}</span>}
      </p>
    );
  }
  if (state === "done") return <p className="text-xs text-haze">{msg}</p>;
  return (
    <div className="space-y-2 rounded-lg border border-harbor p-3 text-xs">
      <p className="text-snow">{formatEthCeil(movable)} ETH of the payer&apos;s gas money is left at this address.</p>
      <input
        className="field font-mono text-sm"
        placeholder="0x… address to send it to"
        value={dest}
        onChange={(e) => setDest(e.target.value)}
        aria-label="Send leftover ETH to"
        spellCheck={false}
        autoComplete="off"
      />
      <p className="text-haze">Sending it to a wallet that&apos;s known to be yours links that wallet to this payment.</p>
      <button type="button" className="btn btn-sm" disabled={!destAddr || state === "sending"} onClick={send}>
        {state === "sending" ? <Spinner /> : null} Send leftover ETH
      </button>
      {msg && <p className="text-bad">{msg}</p>}
    </div>
  );
}

/** Move all or part of a payment to any address. The connected wallet is never pre-filled. */
function SendPanel({ request, payment, network }: { request: StoredRequest; payment: StoredPayment; network: NetworkConfig }) {
  const { address } = useAccount();
  const { data: wallet } = useWalletClient({ chainId: network.chain.id });
  const client = usePublicClient(network);
  const { vault, update } = useVault();
  const [open, setOpen] = useState(false);
  const [dest, setDest] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [info, setInfo] = useState<{ token: bigint; eth: bigint; cost: bigint } | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<"topup" | "send" | null>(null);
  const [busy, setBusy] = useState<"topup" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const pool = usePoolInfo(network);
  const poolReady = !!pool.data && !pool.data.dead;
  const [mode, setMode] = useState<"pool" | "address" | null>(null);
  const effectiveMode = mode ?? (poolReady ? "pool" : "address");

  const destValid = isAddress(dest.trim(), { strict: false });
  const destAddr = destValid ? getAddress(dest.trim()) : null;
  const linksToConnected = !!destAddr && !!address && destAddr === getAddress(address);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const b = await stealthBalances(client, request.token, payment.stealthAddress);
      // Estimate against a placeholder destination when none is entered yet.
      const to = destAddr ?? ("0x000000000000000000000000000000000000dEaD" as Address);
      const est = b.token > 0n ? await estimateSweepCost(client, request.token, payment.stealthAddress, to, b.token) : { cost: 0n };
      setInfo({ token: b.token, eth: b.eth, cost: est.cost });
    } catch (e) {
      setError(classifyTxError(e).message);
    } finally {
      setLoading(false);
    }
  }, [client, request.token, payment.stealthAddress, destAddr]);

  useEffect(() => {
    if (open && effectiveMode === "address") void refresh();
  }, [open, refresh, effectiveMode]);

  const amount = useMemo(() => {
    if (!info) return { error: null as string | null };
    if (!amountInput.trim()) return { value: info.token, all: true };
    try {
      const v = parseAmount(amountInput, request.decimals);
      if (v <= 0n) return { error: "Enter an amount greater than zero." };
      if (v > info.token) return { error: "That is more than this payment holds." };
      return { value: v, all: v === info.token };
    } catch (e) {
      return { error: e instanceof AmountError ? e.message : "Invalid amount." };
    }
  }, [amountInput, info, request.decimals]);

  const shortfall = info ? (info.cost > info.eth ? info.cost - info.eth : 0n) : 0n;
  const topUpAmount = shortfall === 0n ? 0n : ((shortfall + 10n ** 12n - 1n) / 10n ** 12n) * 10n ** 12n;
  const fmt = (v: bigint) => `${formatAmount(v, request.decimals, { group: true })} ${request.symbol}`;

  async function topUp() {
    if (!wallet || topUpAmount === 0n) return;
    setBusy("topup");
    setError(null);
    try {
      const hash = await wallet.sendTransaction({ to: payment.stealthAddress, value: topUpAmount, chain: network.chain, account: wallet.account });
      await client.waitForTransactionReceipt({ hash, confirmations: network.confirmations });
      await refresh();
    } catch (e) {
      setError(classifyTxError(e).message);
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  async function send() {
    if (!destAddr || !vault || !("value" in amount) || !amount.value) return;
    setBusy("send");
    setError(null);
    try {
      const res = await sendFromStealthPayment(client, network, { request, payment, to: destAddr, amount: amount.value });
      await update((v) => {
        const updated = recordSend(v.requests.find((r) => r.id === request.id) ?? request, payment.stealthAddress, { tx: res.hash, to: destAddr, amount: res.amount }, res.remaining);
        return { ...v, requests: v.requests.map((r) => (r.id === updated.id ? updated : r)) };
      });
      setDone(`Sent ${fmt(res.amount)}.`);
      setAmountInput("");
      setDest("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message);
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>
        Move funds
      </button>
    );
  }

  const chooser = poolReady ? (
    <fieldset>
      <legend className="mb-2 block text-sm font-medium text-snow">Move to</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ["pool", "Shielded pool", "Private. Through the pool to your wallet."],
            ["address", "An address", "Direct. Linked to this payment onchain."],
          ] as const
        ).map(([value, title, hint]) => (
          <label
            key={value}
            className={`cursor-pointer rounded-xl border p-3 text-sm ${effectiveMode === value ? "border-signal bg-signal/5" : "border-harbor"}`}
          >
            <input
              type="radio"
              className="sr-only"
              name={`mode-${payment.stealthAddress}`}
              value={value}
              checked={effectiveMode === value}
              onChange={() => {
                setMode(value);
                setConfirming(null);
                setDone(null);
              }}
            />
            <span className="block font-medium text-snow">{title}</span>
            <span className="mt-0.5 block text-xs text-haze">{hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  ) : null;

  if (effectiveMode === "pool" && pool.data) {
    return (
      <div className="space-y-4 rounded-xl border border-harbor p-4">
        {chooser}
        <ShieldForm request={request} payment={payment} network={network} info={pool.data} />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-harbor p-4">
      {chooser}
      <div>
        <label htmlFor={`dest-${payment.stealthAddress}`} className="mb-2 block text-sm font-medium text-snow">
          Send to
        </label>
        <input
          id={`dest-${payment.stealthAddress}`}
          className="field font-mono text-base sm:text-xs"
          value={dest}
          placeholder="0x… an address that has never been linked to you"
          onChange={(e) => {
            setDest(e.target.value);
            setConfirming(null);
            setDone(null);
          }}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!dest && !destValid}
        />
        {!!dest && !destValid && <p className="mt-1 text-xs text-bad">Enter a valid address.</p>}
        {!dest && (
          <p className="mt-2 text-xs leading-relaxed text-haze">
            For the most privacy, create a new account in your wallet and paste its address here, or pay someone directly from this payment.
          </p>
        )}
        {linksToConnected && (
          <p className="mt-2 text-xs leading-relaxed text-warn">
            This is your connected wallet. Sending here publicly links this payment to it, and the payer can see that.
          </p>
        )}
      </div>

      <div>
        <label htmlFor={`amt-${payment.stealthAddress}`} className="mb-2 block text-sm font-medium text-snow">
          Amount
        </label>
        <div className="flex gap-2">
          <input
            id={`amt-${payment.stealthAddress}`}
            className="field"
            inputMode="decimal"
            autoComplete="off"
            placeholder={info ? `All (${formatAmount(info.token, request.decimals, { group: true })})` : "All"}
            value={amountInput}
            onChange={(e) => {
              setAmountInput(e.target.value.replace(",", "."));
              setConfirming(null);
            }}
            aria-invalid={"error" in amount && !!amount.error}
          />
          {info && amountInput && (
            <button type="button" className="btn btn-sm btn-quiet min-h-[2.9rem]" onClick={() => setAmountInput("")}>
              All
            </button>
          )}
        </div>
        {"error" in amount && amount.error && <p className="mt-1 text-xs text-bad">{amount.error}</p>}
      </div>

      {loading ? (
        <LoadingRows label="Checking balances" rows={3} />
      ) : info ? (
        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-haze">Available</dt>
          <dd className="text-right text-snow">{fmt(info.token)}</dd>
          <dt className="text-haze">Gas at address</dt>
          <dd className="text-right text-snow">{formatEthCeil(info.eth)} ETH</dd>
          <dt className="text-haze">Gas needed</dt>
          <dd className="text-right text-snow">{formatEthCeil(info.cost)} ETH</dd>
        </dl>
      ) : null}

      {info && topUpAmount > 0n && (
        <div className="space-y-3">
          <Notice tone="warn" title="Not enough gas at this address">
            The payer didn&apos;t include enough ETH for fees. Send about {formatEthCeil(topUpAmount)} ETH to it first. QuietPay never funds
            addresses automatically, and topping up from your connected wallet publicly links that wallet to this payment.
          </Notice>
          {confirming === "topup" ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm btn-primary" onClick={topUp} disabled={!!busy || !wallet}>
                {busy === "topup" ? <Spinner /> : null} Confirm: send <span className="normal-case tracking-[0.02em]">{formatEthCeil(topUpAmount)} ETH</span>
              </button>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirming(null)} disabled={!!busy}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => setConfirming("topup")}>
              Top up gas from my wallet
            </button>
          )}
          <p className="break-all text-xs text-haze">
            Or send ETH to <Mono>{payment.stealthAddress}</Mono> from an unrelated wallet, then check again.
          </p>
          <button type="button" className="btn btn-sm btn-quiet" onClick={refresh} disabled={loading}>
            Check again
          </button>
        </div>
      )}

      {info && info.token > 0n && topUpAmount === 0n && destAddr && "value" in amount && amount.value ? (
        confirming === "send" ? (
          <div className="space-y-2">
            <p className="text-sm text-snow">
              Send {fmt(amount.value)} to <Mono>{shorten(destAddr, 6)}</Mono>?
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm btn-primary" onClick={send} disabled={!!busy}>
                {busy === "send" ? <Spinner /> : null} Confirm send
              </button>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirming(null)} disabled={!!busy}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setConfirming("send")}>
            Send <span className="normal-case tracking-[0.02em]">{fmt(amount.value)}</span>
          </button>
        )
      ) : null}
      {info && info.token === 0n && <Notice tone="info">This address holds no tokens. It may already have been moved from another device.</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}

/** Status of a private claim (shielded, then sent on to an address) for a shielded payment. */
function DeliveryStatus({ depositTx, network, fmt }: { depositTx: string; network: NetworkConfig; fmt: (v: bigint) => string }) {
  const { vault, update } = useVault();
  const d = vault?.deliveries?.find((x) => x.depositTx.toLowerCase() === depositTx.toLowerCase());
  if (!d) return null;
  const set = (change: Partial<NonNullable<typeof d>>) =>
    update((v) => ({ ...v, deliveries: (v.deliveries ?? []).map((x) => (x.id === d.id ? { ...x, ...change } : x)) }));
  const time = new Date(d.notBefore).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <span className="mt-1 block text-haze">
      {d.status === "delivered" ? (
        <>
          Delivered {d.amount ? fmt(BigInt(d.amount) - BigInt(d.fee ?? "0")) : ""} to <Mono>{shorten(d.to, 4)}</Mono> privately
          {d.tx ? (
            <>
              {" "}
              · <ExplorerLink network={network} tx={d.tx} />
            </>
          ) : null}
        </>
      ) : d.status === "cancelled" ? (
        <>Delivery to <Mono>{shorten(d.to, 4)}</Mono> stopped. {d.lastError ?? "It stays in the pool."}</>
      ) : (
        <>
          On its way to <Mono>{shorten(d.to, 4)}</Mono>
          {d.notBefore > Date.now() ? (d.timing === "random" ? `, at a random time (around ${time})` : `, around ${time}`) : ", as soon as it's approved"}
          {d.lastError ? `. Last try: ${d.lastError}` : ""}
          <span className="ml-2 inline-flex gap-3">
            {d.notBefore > Date.now() && (
              <button type="button" className="underline underline-offset-4 hover:text-snow" onClick={() => set({ notBefore: Date.now(), retryAt: undefined })}>
                Send now
              </button>
            )}
            <button type="button" className="underline underline-offset-4 hover:text-snow" onClick={() => set({ status: "cancelled", lastError: "It stays in the pool." })}>
              Cancel
            </button>
          </span>
        </>
      )}
    </span>
  );
}
