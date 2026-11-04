"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { createWalletClient, getAddress, http, isAddress } from "viem";
import { erc20Abi } from "@/config/contracts";
import type { NetworkConfig } from "@/config/networks";
import { AmountError, formatAmount, parseAmount } from "@/lib/amount";
import { NotApprovedYetError, prepareWithdrawal, ragequit, serializeWithdrawal, verifyPool, type PoolInfo } from "@/lib/pool/actions";
import { exclusionsFrom, fetchPoolEvents } from "@/lib/pool/state";
import { ArtifactIntegrityError, fetchArtifact } from "@/lib/pool/prover";
import { stealthAccount } from "@/lib/receive";
import { refundAccount, refundUnapproved, verifyPoolRouter } from "@/lib/pool/receive";
import { classifyTxError } from "@/lib/tx-errors";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { usePoolInfo, usePoolSnapshot, useRelayerTerms, type PoolSnapshot, type RelayerTerms } from "@/components/pool-hooks";
import { useSelectedNetwork } from "@/components/Providers";
import { ExplorerLink, LoadingRows, Mono, Notice, PageTitle, Spinner, StatusPill, formatDateTime, shorten } from "@/components/ui";
import { useVault } from "@/components/VaultProvider";
import { VaultGate, WalletGate } from "@/components/WalletGate";

const loadArtifacts = fetchArtifact();

export function PoolFlow() {
  const { network } = useSelectedNetwork();
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
      <PageTitle light="Shielded" bold="pool">
        Shielded payments sit in a shared pool. Withdraw any amount to any fresh address: your device proves the funds are yours without
        saying which deposit they came from.
      </PageTitle>
      <div className="panel p-5 sm:p-7">
        {!network.pool ? (
          <Notice tone="info" title="Not deployed yet">
            The shielded pool is not deployed on {network.label} yet. Payments still arrive at one-time addresses and can be moved from the
            Receive page.
          </Notice>
        ) : (
          <WalletGate network={network} purpose="Connect the wallet you use with QuietPay. Its signature unlocks your pool keys on this device.">
            <VaultGate>
              <PoolDashboard network={network} />
            </VaultGate>
          </WalletGate>
        )}
      </div>
      <section className="mt-8 space-y-3 text-sm leading-relaxed text-mist" aria-labelledby="pool-how">
        <h2 id="pool-how" className="font-display text-base font-semibold tracking-[-0.01em] text-snow">
          What the pool hides, and what it doesn&apos;t
        </h2>
        <p>
          Anyone can see each deposit and each withdrawal, with amounts and times. What nobody can see is which deposit a withdrawal came
          from. Your privacy grows with the number of other deposits, so it is weaker while the pool is new.
        </p>
        <p>
          Amounts and timing can still give you away. Waiting a while, and withdrawing amounts that don&apos;t match what you deposited, makes
          it much harder to connect the two.
        </p>
        <p>
          Every deposit must be approved before it can be withdrawn privately. On mainnet, the pool first checks the deposit and the wallet
          that paid it against the US sanctions list (OFAC); a clean deposit is approved within seconds. On testnet, deposits are approved
          automatically as soon as they land. If a deposit is never approved, it can always be taken back: to its one-time address, or for a
          payment received through a link, to that link&apos;s refund address.
        </p>
      </section>
    </div>
  );
}

function PoolDashboard({ network }: { network: NetworkConfig }) {
  const readiness = useNetworkReadiness(network);
  const info = usePoolInfo(network);
  const snap = usePoolSnapshot(network);
  const terms = useRelayerTerms(network);
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const decimals = readiness.data?.token?.decimals ?? 6;
  const symbol = readiness.data?.token?.symbol ?? "tUSDG";
  const fmt = (v: bigint) => `${formatAmount(v, decimals, { group: true })} ${symbol}`;
  const waitingCount = (snap.data?.notes ?? []).filter((n) => n.status === "spendable" && !n.approved && !n.excluded).length;

  const runApprovals = useCallback(
    async (manual: boolean) => {
      if (manual) {
        setChecking(true);
        setCheckMsg(null);
      }
      try {
        const r = await fetch("/api/pool/approvals", { method: "POST" });
        const j = (await r.json()) as { updated?: boolean; error?: string; reason?: string };
        if (!r.ok) setCheckMsg(j.error ?? "The approver is not available.");
        else if (manual) setCheckMsg(j.updated ? "New deposits were approved." : "Nothing new to approve yet.");
        else setCheckMsg(null);
        if (j.updated) {
          await queryClient.invalidateQueries({ queryKey: ["pool-info"] });
          await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
        }
      } catch {
        setCheckMsg("The approver is not available.");
      } finally {
        if (manual) setChecking(false);
      }
    },
    [queryClient],
  );

  // Approvals are immediate on testnet: ask the approver as soon as a deposit is waiting, then
  // keep checking every few seconds until it is approved.
  useEffect(() => {
    if (!waitingCount) return;
    let stopped = false;
    const tick = () => {
      if (!stopped) void runApprovals(false);
    };
    tick();
    const t = setInterval(tick, 6000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [waitingCount, runApprovals]);

  if (info.isLoading || readiness.isLoading) return <LoadingRows label="Checking the pool contracts" rows={4} />;
  if (info.error) return <Notice tone="bad" title="Pool check failed">{(info.error as Error).message.split("\n")[0]}</Notice>;
  if (!info.data) return null;

  const notes = snap.data?.notes ?? [];
  const live = notes.filter((n) => n.status === "spendable");
  const ready = live.filter((n) => n.approved).reduce((s, n) => s + n.value, 0n);
  const waiting = live.filter((n) => !n.approved && !n.excluded).reduce((s, n) => s + n.value, 0n);

  return (
    <div className="space-y-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-harbor p-4">
          <p className="text-xs uppercase tracking-[0.12em] text-haze">Ready to withdraw</p>
          <p className="mt-1 font-display text-2xl font-semibold tracking-[-0.02em] text-snow">{snap.isLoading ? "…" : fmt(ready)}</p>
        </div>
        <div className="rounded-xl border border-harbor p-4">
          <p className="text-xs uppercase tracking-[0.12em] text-haze">Waiting for approval</p>
          <p className="mt-1 font-display text-2xl font-semibold tracking-[-0.02em] text-snow">{snap.isLoading ? "…" : fmt(waiting)}</p>
          {waiting > 0n && (
            <div className="mt-3 space-y-2">
              <p className="flex items-center gap-2 text-xs text-haze" aria-live="polite">
                {terms.data?.approvalDelaySeconds ? (
                  `Deposits are approved about ${Math.max(1, Math.round(terms.data.approvalDelaySeconds / 60))} minutes after they land.`
                ) : (
                  <>
                    <Spinner className="h-3 w-3" /> Approving automatically, usually within seconds.
                  </>
                )}
              </p>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => runApprovals(true)} disabled={checking}>
                {checking ? <Spinner /> : null} Check approval
              </button>
              {checkMsg && <p className="text-xs text-haze" aria-live="polite">{checkMsg}</p>}
            </div>
          )}
        </div>
      </div>

      {snap.data && !snap.data.approvalsReadable && (
        <Notice tone="warn" title="Approval list could not be checked">
          The pool&apos;s latest approval root does not match the public rule, so withdrawals are paused here. Exiting back to a one-time
          address still works.
        </Notice>
      )}

      <section aria-labelledby="notes-h" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="notes-h" className="font-display text-lg font-semibold tracking-[-0.01em] text-snow">
            Your deposits <span className="font-normal text-haze">({notes.length})</span>
          </h2>
          <button
            type="button"
            className="btn btn-sm btn-quiet"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ["pool-info"] });
              void snap.refetch();
            }}
            disabled={snap.isFetching}
          >
            {snap.isFetching ? <Spinner /> : null} Refresh
          </button>
        </div>
        {snap.isLoading ? (
          <LoadingRows label="Reading pool history" rows={3} />
        ) : snap.error ? (
          <Notice tone="bad">{classifyTxError(snap.error).message}</Notice>
        ) : notes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-harbor px-5 py-8 text-center text-sm text-haze">
            Nothing shielded yet. One-time links you create now pay straight in here. Or, on the{" "}
            <a href="/receive" className="text-signal underline underline-offset-4">
              Receive page
            </a>
            , choose Move funds, then Shielded pool.
          </div>
        ) : (
          <ul className="space-y-4">
            {notes.map((n) => (
              <NoteCard key={n.label.toString()} note={n} network={network} info={info.data!} snapshot={snap.data!} terms={terms.data} fmt={fmt} decimals={decimals} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type Note = PoolSnapshot["notes"][number];

function NoteCard(p: { note: Note; network: NetworkConfig; info: PoolInfo; snapshot: PoolSnapshot; terms?: RelayerTerms; fmt: (v: bigint) => string; decimals: number }) {
  const { note, network, fmt } = p;
  const [open, setOpen] = useState<"withdraw" | "exit" | null>(null);
  const status =
    note.status === "spent"
      ? { state: "claimed", label: "Fully withdrawn" }
      : note.status === "ragequit"
        ? { state: "claimed", label: "Exited" }
        : note.approved
          ? { state: "claimable", label: "Ready" }
          : note.excluded
            ? { state: "error", label: "Not approved" }
            : { state: "pending", label: "Waiting for approval" };
  return (
    <li className="rounded-xl border border-harbor bg-abyss/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-xl font-semibold tracking-[-0.02em] text-snow">{fmt(note.value)}</p>
          <p className="mt-1 text-xs text-haze">
            {note.received ? "Received through a payment link" : "Deposited"} {fmt(note.deposit.value)} ·{" "}
            <ExplorerLink network={network} tx={note.deposit.txHash} />
          </p>
        </div>
        <StatusPill state={status.state} label={status.label} />
      </div>
      {note.history.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-haze">
          {note.history.map((w) => (
            <li key={w.txHash}>
              Withdrew {fmt(w.value)} · <ExplorerLink network={network} tx={w.txHash} />
            </li>
          ))}
        </ul>
      )}
      {note.status === "spendable" && note.excluded && (
        <p className="mt-3 text-sm leading-relaxed text-mist">
          {note.received
            ? "This payment didn't pass the pool's sanctions screening, so it can't be withdrawn privately. Return sends it to this link's refund address."
            : "This deposit didn't pass the pool's sanctions screening, so it can't be withdrawn privately. Exit takes it back to its one-time address."}
        </p>
      )}
      {note.status === "spendable" && (
        <div className="mt-4 flex flex-wrap gap-2">
          {note.approved && (
            <button type="button" className={`btn btn-sm ${open === "withdraw" ? "btn-quiet" : "btn-primary"}`} onClick={() => setOpen(open === "withdraw" ? null : "withdraw")}>
              {open === "withdraw" ? "Close" : "Withdraw"}
            </button>
          )}
          {(!note.received || note.excluded) && (
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(open === "exit" ? null : "exit")}>
              {open === "exit" ? "Close" : note.received ? "Return to refund address" : "Exit to one-time address"}
            </button>
          )}
        </div>
      )}
      {open === "withdraw" && <WithdrawForm {...p} onDone={() => setOpen(null)} />}
      {open === "exit" && (note.received ? <RefundForm {...p} /> : <ExitForm {...p} />)}
      {note.received && note.status === "ragequit" && <RefundMove {...p} />}
    </li>
  );
}

const STAGES = {
  load: "Downloading circuit files (about 20 MB, once)",
  prove: "Generating the proof on this device",
  relay: "Relayer is submitting the withdrawal",
} as const;

function WithdrawForm({ note, network, info, snapshot, terms, fmt, decimals, onDone }: Parameters<typeof NoteCard>[0] & { onDone: () => void }) {
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const client = usePublicClient(network);
  const [dest, setDest] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [stage, setStage] = useState<keyof typeof STAGES | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ hash: `0x${string}`; amount: bigint; fee: bigint; to: string; gasDrop: boolean } | null>(null);

  const destAddr = isAddress(dest.trim(), { strict: false }) ? getAddress(dest.trim()) : null;
  const linksToConnected = !!destAddr && !!address && destAddr === getAddress(address);
  const feeBPS = terms?.feeBPS ? BigInt(terms.feeBPS) : null;
  const amount = useMemo(() => {
    if (!amountInput.trim()) return { value: note.value };
    try {
      const v = parseAmount(amountInput, decimals);
      if (v <= 0n) return { error: "Enter an amount greater than zero." };
      if (v > note.value) return { error: "That is more than this deposit holds." };
      return { value: v };
    } catch (e) {
      return { error: e instanceof AmountError ? e.message : "Invalid amount." };
    }
  }, [amountInput, note.value, decimals]);
  const value = "value" in amount ? amount.value : undefined;
  const fee = value !== undefined && feeBPS !== null ? (value * feeBPS) / 10_000n : null;
  // The relayer only takes amounts whose fee covers its network fee.
  const minW = terms?.minWithdrawal ? BigInt(terms.minWithdrawal) : null;
  const tooSmall = minW !== null && value !== undefined && value < minW;

  async function withdraw() {
    if (!destAddr || value === undefined || feeBPS === null || !terms?.feeRecipient) return;
    setError(null);
    setResult(null);
    try {
      setStage("load");
      await Promise.all([loadArtifacts("withdraw.wasm"), loadArtifacts("withdraw.zkey")].map((p) => p.catch(() => null)));
      // Approvals are published as deposits land, so the approval list can change while the proof is
      // being made. If the relayer reports that, re-read the pool and prove again (once).
      let poolInfo = info;
      let events = snapshot.events;
      let j: { hash?: `0x${string}`; fee?: string; amount?: string; gasDropHash?: string | null; error?: string } = {};
      for (let attempt = 0; attempt < 2; attempt++) {
        setStage("prove");
        const prepared = await prepareWithdrawal(loadArtifacts, {
          info: poolInfo,
          events,
          keys: note.keys,
          note,
          amount: value,
          recipient: destAddr,
          feeRecipient: terms.feeRecipient,
          feeBPS,
        });
        setStage("relay");
        const r = await fetch(network.pool!.relayerUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(serializeWithdrawal(prepared)),
        });
        j = (await r.json()) as typeof j;
        if (r.ok && j.hash) break;
        if (attempt === 0 && /approval list changed/i.test(j.error ?? "")) {
          const fresh = await verifyPool(client, network);
          if (!fresh) break;
          poolInfo = fresh;
          events = await fetchPoolEvents(client, {
            entrypoint: fresh.entrypoint,
            pool: fresh.pool,
            fromBlock: network.pool!.fromBlock,
            chunkSize: network.logChunkSize,
            exclusions: exclusionsFrom(network.pool!.exclusionsUrl),
          });
          continue;
        }
        break;
      }
      if (!j.hash) throw new Error(j.error ?? "The relayer could not submit this withdrawal.");
      setResult({ hash: j.hash, amount: BigInt(j.amount ?? value), fee: BigInt(j.fee ?? 0), to: destAddr, gasDrop: !!j.gasDropHash });
      setDest("");
      setAmountInput("");
      await queryClient.invalidateQueries({ queryKey: ["pool-info"] });
      await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
    } catch (e) {
      if (e instanceof NotApprovedYetError || e instanceof ArtifactIntegrityError) setError(e.message);
      else setError(e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message);
    } finally {
      setStage(null);
    }
  }

  if (result) {
    return (
      <div className="mt-4 space-y-3">
        <Notice tone="ok" title="Withdrawn">
          {fmt(result.amount - result.fee)} sent to <Mono>{shorten(result.to, 6)}</Mono> · <ExplorerLink network={network} tx={result.hash} />
          {result.gasDrop ? " The relayer also sent a little ETH there so you can move the tokens." : ""}
        </Notice>
        <button type="button" className="btn btn-sm btn-quiet" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4 rounded-xl border border-harbor p-4">
      {!terms?.available && (
        <Notice tone="warn" title="Relayer unavailable">
          The relayer is not running right now, so withdrawals can&apos;t be sent. Your funds stay safe in the pool.
        </Notice>
      )}
      <div>
        <label htmlFor={`wd-to-${note.label}`} className="mb-2 block text-sm font-medium text-snow">
          Send to
        </label>
        <input
          id={`wd-to-${note.label}`}
          className="field font-mono text-base sm:text-xs"
          value={dest}
          placeholder="0x… a fresh address with no history"
          onChange={(e) => setDest(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!dest && !destAddr}
        />
        {!!dest && !destAddr && <p className="mt-1 text-xs text-bad">Enter a valid address.</p>}
        {!dest && <p className="mt-2 text-xs leading-relaxed text-haze">Create a new account in your wallet and paste its address. It can start empty.</p>}
        {linksToConnected && (
          <p className="mt-2 text-xs leading-relaxed text-warn">This is your connected wallet. Withdrawing here ties the funds to it publicly.</p>
        )}
      </div>
      <div>
        <label htmlFor={`wd-amt-${note.label}`} className="mb-2 block text-sm font-medium text-snow">
          Amount
        </label>
        <input
          id={`wd-amt-${note.label}`}
          className="field"
          inputMode="decimal"
          autoComplete="off"
          placeholder={`All (${formatAmount(note.value, decimals, { group: true })})`}
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value.replace(",", "."))}
          aria-invalid={"error" in amount && !!amount.error}
        />
        {"error" in amount && amount.error && <p className="mt-1 text-xs text-bad">{amount.error}</p>}
        {tooSmall && (
          <p className="mt-1 text-xs text-bad">
            Too small to withdraw through the relayer right now: it needs at least {fmt(minW!)} so its fee covers the network fee. If you can&apos;t
            reach that, use Exit to take it back to its one-time address.
          </p>
        )}
        {value !== undefined && value === note.deposit.value && (
          <p className="mt-1 text-xs text-haze">Withdrawing exactly what you deposited is easier to match. A different amount is more private.</p>
        )}
      </div>
      {value !== undefined && fee !== null && (
        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-haze">Relayer fee ({(Number(feeBPS) / 100).toString()}%)</dt>
          <dd className="text-right text-snow">{fmt(fee)}</dd>
          <dt className="text-haze">Arrives</dt>
          <dd className="text-right text-snow">{fmt(value - fee)}</dd>
          {terms?.gasDropEth && Number(terms.gasDropEth) > 0 && (
            <>
              <dt className="text-haze">Gas included, up to</dt>
              <dd className="text-right text-snow">{terms.gasDropEth} ETH</dd>
            </>
          )}
        </dl>
      )}
      {stage ? (
        <p className="flex items-center gap-2 text-sm text-snow" aria-live="polite">
          <Spinner /> {STAGES[stage]}…
        </p>
      ) : (
        <button type="button" className="btn btn-sm btn-primary" onClick={withdraw} disabled={!destAddr || value === undefined || tooSmall || !terms?.available || feeBPS === null}>
          Withdraw {value !== undefined ? <span className="normal-case tracking-[0.02em]">{fmt(value)}</span> : null}
        </button>
      )}
      <p className="text-xs leading-relaxed text-haze">
        The proof is made in your browser and fixes the recipient and fee, so the relayer can only submit it as is. The relayer sees your IP
        address and the withdrawal, but not which deposit it came from.
      </p>
      {error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}

function ExitForm({ note, network, info, fmt }: Parameters<typeof NoteCard>[0]) {
  const { vault, update } = useVault();
  const client = usePublicClient(network);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<`0x${string}` | null>(null);
  const source = useMemo(() => {
    for (const r of vault?.requests ?? [])
      for (const pay of r.payments) if (pay.stealthAddress.toLowerCase() === note.deposit.depositor.toLowerCase()) return { request: r, payment: pay };
    return null;
  }, [vault, note.deposit.depositor]);

  async function exit() {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const hash = await ragequit(client, network, loadArtifacts, { info, account: stealthAccount(source.request, source.payment), note });
      setDone(hash);
      // The funds are back at the one-time address: reopen that payment on the Receive page.
      if (vault) {
        const back = { tx: hash, amount: note.value.toString(), at: Date.now() };
        await update((v) => ({
          ...v,
          requests: v.requests.map((r) =>
            r.id !== source.request.id
              ? r
              : {
                  ...r,
                  payments: r.payments.map((x) =>
                    x.stealthAddress !== source.payment.stealthAddress
                      ? x
                      : { ...x, claimTx: undefined, claimedTo: undefined, claimedAt: undefined, returns: [...(x.returns ?? []), back] },
                  ),
                },
          ),
        }));
      }
      await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
    } catch (e) {
      setError(e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 rounded-xl border border-harbor p-4 text-sm">
      <p className="leading-relaxed text-mist">
        Takes the full {fmt(note.value)} back to the one-time address that deposited it (<Mono>{shorten(note.deposit.depositor, 4)}</Mono>).
        This is public and gives up the pool&apos;s privacy for this deposit. Use it if a deposit is never approved.
      </p>
      {!source ? (
        <Notice tone="warn">The one-time address that made this deposit isn&apos;t loaded in this browser yet. Open the Receive page and scan to recover it.</Notice>
      ) : done ? (
        <Notice tone="ok">
          Returned to the one-time address · <ExplorerLink network={network} tx={done} />. Move it from the Receive page.
        </Notice>
      ) : (
        <button type="button" className="btn btn-sm" onClick={exit} disabled={busy}>
          {busy ? <Spinner /> : null} Exit {fmt(note.value)}
        </button>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}

/**
 * A payment received straight into the pool that was never approved: returns it to the refund
 * address its link recorded. Only that address can receive it, whoever submits the transaction.
 */
function RefundForm({ note, network, info, fmt }: Parameters<typeof NoteCard>[0]) {
  const { data: wallet } = useWalletClient({ chainId: network.chain.id });
  const client = usePublicClient(network);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<`0x${string}` | null>(null);
  const refund = note.received ? refundAccount(note.keys, info.scope, note.received.receiveIndex).address : null;

  async function run() {
    if (!wallet || !network.pool?.router) return;
    setBusy(true);
    setError(null);
    try {
      const router = await verifyPoolRouter(client, network);
      if (!router) throw new Error("The pool payment contract isn't configured on this site.");
      const hash = await refundUnapproved(wallet, loadArtifacts, { network, router, note });
      await client.waitForTransactionReceipt({ hash });
      setDone(hash);
      await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
    } catch (e) {
      setError(e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 rounded-xl border border-harbor p-4 text-sm">
      <p className="leading-relaxed text-mist">
        Sends the full {fmt(note.value)} to this link&apos;s refund address{refund && <> (<Mono>{shorten(refund, 4)}</Mono>)</>}. Your connected
        wallet pays the network fee, so this transaction is public and ties your wallet to this payment.
      </p>
      {done ? (
        <Notice tone="ok">
          Returned to the refund address · <ExplorerLink network={network} tx={done} />
        </Notice>
      ) : (
        <button type="button" className="btn btn-sm" onClick={run} disabled={busy || !wallet}>
          {busy ? <Spinner /> : null} Return {fmt(note.value)}
        </button>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}

/**
 * Money returned to a link's refund address (a payment that failed screening). The refund key
 * comes from your pool keys. The address has no ETH, so your connected wallet first sends just
 * enough for the network fee, then the refund key sends the tokens where you choose. Both steps
 * are public, and the money can't go back into the pool.
 */
function RefundMove({ note, network, info, fmt }: Parameters<typeof NoteCard>[0]) {
  const { address } = useAccount();
  const { data: wallet } = useWalletClient({ chainId: network.chain.id });
  const client = usePublicClient(network);
  const queryClient = useQueryClient();
  const refund = useMemo(() => (note.received ? refundAccount(note.keys, info.scope, note.received.receiveIndex) : null), [note, info.scope]);
  const [held, setHeld] = useState<bigint | null>(null);
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<`0x${string}` | null>(null);

  useEffect(() => {
    if (!refund || !network.token) return;
    void client.readContract({ address: network.token, abi: erc20Abi, functionName: "balanceOf", args: [refund.address] }).then(setHeld).catch(() => setHeld(null));
  }, [client, refund, network.token, done]);
  useEffect(() => {
    if (address && !dest) setDest(address);
  }, [address, dest]);

  if (!refund || !held) return null;
  const to = isAddress(dest.trim()) ? getAddress(dest.trim()) : null;

  async function move() {
    if (!refund || !to || !wallet || !held || !network.token) return;
    setError(null);
    try {
      const fees = await client.estimateFeesPerGas();
      const gas = await client.estimateContractGas({ address: network.token, abi: erc20Abi, functionName: "transfer", args: [to, held], account: refund });
      const need = ((gas * 3n) / 2n) * (fees.maxFeePerGas ?? 0n);
      const have = await client.getBalance({ address: refund.address });
      if (have < need) {
        setBusy("Sending the network fee from your wallet");
        const h = await wallet.sendTransaction({ to: refund.address, value: need - have, account: wallet.account!, chain: network.chain });
        await client.waitForTransactionReceipt({ hash: h });
      }
      setBusy("Moving the refund");
      const refundWallet = createWalletClient({ account: refund, chain: network.chain, transport: http(network.rpcUrl, { timeout: 20_000 }) });
      // Same fee settings the top-up was worked out from, so the ETH sent always covers it.
      const hash = await refundWallet.writeContract({
        address: network.token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, held],
        gas: (gas * 3n) / 2n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("The transfer reverted. Nothing moved.");
      setDone(hash);
      await queryClient.invalidateQueries({ queryKey: ["onchain-holdings"] });
    } catch (e) {
      setError(e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 space-y-3 rounded-xl border border-harbor p-4 text-sm">
      <p className="leading-relaxed text-mist">
        {fmt(held)} is at this payment&apos;s refund address (<Mono>{shorten(refund.address, 4)}</Mono>). It failed screening, so it can&apos;t go back
        into the pool. Send it to a wallet; this is public.
      </p>
      {done ? (
        <Notice tone="ok">
          Moved · <ExplorerLink network={network} tx={done} />
        </Notice>
      ) : (
        <>
          <input className="field font-mono text-base sm:text-xs" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="0x…" aria-label="Send the refund to" />
          <button type="button" className="btn btn-sm" onClick={() => void move()} disabled={!to || !!busy || !wallet}>
            {busy ? (
              <>
                <Spinner /> {busy}
              </>
            ) : (
              <>Send {fmt(held)}</>
            )}
          </button>
        </>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}
