"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { getAddress, isAddress, type Address } from "viem";
import type { NetworkConfig } from "@/config/networks";
import { AmountError, formatAmount, parseAmount } from "@/lib/amount";
import { buildPayUrl } from "@/lib/link";
import { estimateSweepCost, fetchAnnouncementsForRequests, recordSend, scanRequest, sendFromStealthPayment, stealthBalances } from "@/lib/receive";
import { classifyTxError } from "@/lib/tx-errors";
import { isExpired, mergeVaults, parseVault, requestStatus, type StoredPayment, type StoredRequest } from "@/lib/vault";
import { checkPassphrase, createBackup, restoreBackup } from "@/lib/vault-crypto";
import { STATE_LABELS } from "@/lib/payment-state";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { PrivacyStatement } from "@/components/PrivacyStatement";
import { useSelectedNetwork } from "@/components/Providers";
import { SetupBlocker } from "@/components/SetupBlocker";
import { CopyButton, Countdown, formatEthCeil, LoadingRows, ExplorerLink, Mono, Notice, PageTitle, Spinner, StatusPill, formatDateTime, shorten } from "@/components/ui";
import { useVault } from "@/components/VaultProvider";
import { VaultGate, WalletGate } from "@/components/WalletGate";

export function ReceiveFlow() {
  const { network } = useSelectedNetwork();
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
      <PageTitle light="Receive and" bold="claim">
        Your browser scans public announcements and recognises your payments with each link&apos;s private viewing key. Keys never leave this
        device.
      </PageTitle>
      <div className="panel p-5 sm:p-7">
        <WalletGate network={network} purpose="Connect the wallet you used to create your links. It unlocks the keys stored in this browser.">
          <VaultGate>
            <Dashboard network={network} />
          </VaultGate>
        </WalletGate>
      </div>
      <div className="mt-8">
        <PrivacyStatement compact />
      </div>
    </div>
  );
}

function Dashboard({ network }: { network: NetworkConfig }) {
  const { vault, save } = useVault();
  const readiness = useNetworkReadiness(network);
  const client = usePublicClient(network);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const requests = useMemo(() => (vault?.requests ?? []).filter((r) => r.chainId === network.chain.id), [vault, network.chain.id]);

  const scan = useCallback(async () => {
    if (!vault || requests.length === 0) return;
    abort.current = new AbortController();
    setScanning(true);
    setScanMsg(null);
    setProgress(0);
    try {
      const { anns, toBlock } = await fetchAnnouncementsForRequests(
        client,
        network,
        requests,
        (done, total) => setProgress(total > 0n ? Number((done * 100n) / total) : 100),
        abort.current.signal,
      );
      let found = 0;
      const updated = new Map<string, StoredRequest>();
      for (const r of requests) {
        const res = await scanRequest(client, network, r, anns, toBlock);
        found += res.newPayments;
        updated.set(r.id, res.request);
      }
      await save({ ...vault, requests: vault.requests.map((r) => updated.get(r.id) ?? r) });
      setScanMsg(found ? `Found ${found} new payment${found === 1 ? "" : "s"}.` : "No new payments. Scanned up to block " + toBlock.toString() + ".");
    } catch (e) {
      setScanMsg((e as Error).name === "AbortError" ? "Scan cancelled." : classifyTxError(e).message);
    } finally {
      setScanning(false);
    }
  }, [vault, requests, client, network, save]);

  if (readiness.isLoading) return <LoadingRows label={`Checking ${network.label} contracts`} rows={4} />;
  if (!readiness.data?.announcer || !readiness.data?.token)
    return <SetupBlocker network={network} readiness={readiness.data} error={readiness.error} />;

  return (
    <div className="space-y-8">
      <Notice tone="warn" title="Your keys live only in this browser">
        Clearing browser data, private windows, or a lost device will lose them, and with them any unclaimed funds. Keep an encrypted backup.
      </Notice>

      <section aria-labelledby="links-h" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="links-h" className="font-display text-lg font-semibold uppercase tracking-[0.06em] text-snow">
            Your links <span className="font-light text-haze">({requests.length})</span>
          </h2>
          {scanning ? (
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => abort.current?.abort()}>
              <Spinner /> {progress}% · Cancel
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={scan} disabled={requests.length === 0}>
              Scan for payments
            </button>
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
          <div className="rounded-[3px] border border-dashed border-harbor px-5 py-8 text-center text-sm text-haze">
            No links on {network.label} in this browser yet.{" "}
            <a href="/create" className="text-signal underline underline-offset-4">
              Create a payment link
            </a>{" "}
            or restore a backup below.
          </div>
        ) : (
          <ul className="space-y-4">
            {requests.map((r) => (
              <RequestCard key={r.id} request={r} network={network} />
            ))}
          </ul>
        )}
      </section>

      <BackupPanel />
    </div>
  );
}

function RequestCard({ request, network }: { request: StoredRequest; network: NetworkConfig }) {
  const status = requestStatus(request);
  const open = request.kind === "open";
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const fmt = (v: bigint) => `${formatAmount(v, request.decimals, { group: true })} ${request.symbol}`;
  const total = request.payments.reduce((sum, p) => sum + (p.transferVerified && p.receivedAmount ? BigInt(p.receivedAmount) : 0n), 0n);
  const shareable = !isExpired(request) && (open || status === "created");
  return (
    <li className="rounded-[3px] border border-harbor bg-abyss/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-xl font-light text-snow">{open ? "Any amount" : fmt(BigInt(request.amount))}</p>
          <p className="mt-1 text-xs text-haze">
            {open ? "Reusable link" : "One-time link"} · created {formatDateTime(request.createdAt)} ·{" "}
            {request.expiresAt === 0 ? (
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
        <StatusPill state={status} label={STATE_LABELS[status]} />
      </div>
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
  const mismatch = request.kind !== "open" && payment.transferVerified && received !== BigInt(request.amount);
  const sent = (payment.sends ?? []).reduce((s, x) => s + BigInt(x.amount), 0n);
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
          {payment.sends!.map((x) => (
            <li key={x.tx}>
              Sent {fmt(BigInt(x.amount))} to <Mono>{shorten(x.to, 4)}</Mono> · <ExplorerLink network={network} tx={x.tx} />
            </li>
          ))}
        </ul>
      )}
      {mismatch && <Notice tone="warn">The amount received differs from the amount requested.</Notice>}
      {!payment.claimTx && payment.transferVerified && <SendPanel request={request} payment={payment} network={network} />}
    </li>
  );
}

/** Move all or part of a payment to any address. The connected wallet is never pre-filled. */
function SendPanel({ request, payment, network }: { request: StoredRequest; payment: StoredPayment; network: NetworkConfig }) {
  const { address } = useAccount();
  const { data: wallet } = useWalletClient({ chainId: network.chain.id });
  const client = usePublicClient(network);
  const { vault, save } = useVault();
  const [open, setOpen] = useState(false);
  const [dest, setDest] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [info, setInfo] = useState<{ token: bigint; eth: bigint; cost: bigint } | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<"topup" | "send" | null>(null);
  const [busy, setBusy] = useState<"topup" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

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
    if (open) void refresh();
  }, [open, refresh]);

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
      const updated = recordSend(request, payment.stealthAddress, { tx: res.hash, to: destAddr, amount: res.amount }, res.remaining);
      await save({ ...vault, requests: vault.requests.map((r) => (r.id === updated.id ? updated : r)) });
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

  return (
    <div className="space-y-4 rounded-[3px] border border-harbor p-4">
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

function BackupPanel() {
  const { vault, save } = useVault();
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState<"export" | "restore" | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [restorePass, setRestorePass] = useState("");

  async function doExport() {
    if (!vault) return;
    const err = checkPassphrase(pass) ?? (pass !== pass2 ? "Passphrases don't match." : null);
    if (err) return setMsg({ tone: "bad", text: err });
    setBusy("export");
    setMsg(null);
    try {
      const backup = await createBackup(vault, pass);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `quietpay-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setPass("");
      setPass2("");
      setMsg({ tone: "ok", text: `Backup saved with ${vault.requests.length} link${vault.requests.length === 1 ? "" : "s"}. Store it and the passphrase separately.` });
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function doRestore() {
    if (!vault || !file) return;
    setBusy("restore");
    setMsg(null);
    try {
      if (file.size > 5_000_000) throw new Error("That file is too large to be a QuietPay backup.");
      const json = JSON.parse(await file.text());
      const data = parseVault(await restoreBackup(json, restorePass));
      const { vault: merged, added } = mergeVaults(vault, { ...data, address: vault.address as Address });
      await save(merged);
      setRestorePass("");
      setFile(null);
      setMsg({ tone: "ok", text: `Restored. ${added} new link${added === 1 ? "" : "s"} added; existing links were kept.` });
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof SyntaxError ? "That file is not valid JSON." : (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section id="backup" aria-labelledby="backup-h" className="scroll-mt-24 space-y-5 border-t border-harbor pt-6">
      <h2 id="backup-h" className="font-display text-lg font-semibold uppercase tracking-[0.06em] text-snow">
        Backup and restore
      </h2>
      <div className="grid gap-6 sm:grid-cols-2">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void doExport();
          }}
        >
          <p className="text-sm text-haze">Download every link&apos;s keys, encrypted with a passphrase you choose (12+ characters).</p>
          <input type="password" className="field" placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" aria-label="Backup passphrase" />
          <input type="password" className="field" placeholder="Repeat passphrase" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" aria-label="Repeat backup passphrase" />
          <button type="submit" className="btn btn-sm" disabled={!!busy || !vault?.requests.length}>
            {busy === "export" ? <Spinner /> : null} Export backup
          </button>
        </form>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void doRestore();
          }}
        >
          <p className="text-sm text-haze">Restore links from a QuietPay backup file into this browser.</p>
          <input
            type="file"
            accept="application/json,.json"
            className="block w-full text-sm text-mist file:mr-3 file:rounded-[2px] file:border file:border-mist/40 file:bg-transparent file:px-3 file:py-1.5 file:text-mist"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            aria-label="Backup file"
          />
          <input type="password" className="field" placeholder="Backup passphrase" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} autoComplete="current-password" aria-label="Passphrase for the backup file" />
          <button type="submit" className="btn btn-sm" disabled={!!busy || !file || !restorePass}>
            {busy === "restore" ? <Spinner /> : null} Restore backup
          </button>
        </form>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </section>
  );
}
