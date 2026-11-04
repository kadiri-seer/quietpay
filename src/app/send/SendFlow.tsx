"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { getAddress, isAddress, type Address } from "viem";
import type { NetworkConfig } from "@/config/networks";
import { AmountError, formatAmount, parseAmount } from "@/lib/amount";
import { extractLinkCode } from "@/lib/link";
import { prepareWithdrawal, serializeWithdrawal, verifyPool, type PoolInfo } from "@/lib/pool/actions";
import { parsePayTarget, verifyLock } from "@/lib/pool/locks";
import { fetchArtifact } from "@/lib/pool/prover";
import { prepareTransfer } from "@/lib/pool/receive";
import { afterFees, feeFor, planParts, type SendTo } from "@/lib/pool/send";
import { exclusionsFrom, fetchPoolEvents, type PoolEvents } from "@/lib/pool/state";
import { classifyTxError } from "@/lib/tx-errors";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { usePoolInfo, usePoolRouter, usePoolSnapshot, useRelayerTerms, type PoolSnapshot } from "@/components/pool-hooks";
import { useSelectedNetwork } from "@/components/Providers";
import { LoadingRows, Mono, Notice, Spinner, shorten } from "@/components/ui";
import { VaultGate, WalletGate } from "@/components/WalletGate";

const load = fetchArtifact();
type Tab = "user" | "address" | "link";
type Note = PoolSnapshot["notes"][number];

export function SendFlow() {
  const { network } = useSelectedNetwork();
  return (
    <div className="mx-auto max-w-xl px-4 pt-6 sm:px-6">
      <h1 className="mb-6 font-display text-[2rem] font-bold leading-[1.08] tracking-[-0.03em] text-snow sm:text-[2.6rem]">Send</h1>
      <div className="panel p-5 sm:p-7">
        {!network.pool ? (
          <Notice tone="warn">Sending from your balance isn&apos;t available on {network.label} yet.</Notice>
        ) : (
          <WalletGate network={network} purpose="Connect the wallet you use with QuietPay. Its signature unlocks your keys on this device.">
            <VaultGate>
              <SendHub network={network} />
            </VaultGate>
          </WalletGate>
        )}
      </div>
    </div>
  );
}

/** "@kadiri", "kadiri", a personal link, or a username link. */
export function parseUserInput(input: string): SendTo | null {
  const s = input.trim();
  if (!s) return null;
  const frag = s.includes("#") ? s.slice(s.indexOf("#") + 1) : s;
  const t = parsePayTarget(frag) ?? parsePayTarget(`@${frag.replace(/^@/, "")}`);
  if (!t) return null;
  return t.kind === "name" ? { kind: "name", name: t.name } : { kind: "key", key: t.key };
}

function SendHub({ network }: { network: NetworkConfig }) {
  const [tab, setTab] = useState<Tab>("user");
  const [prefill, setPrefill] = useState("");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const to = q.get("to");
    if (to) {
      if (isAddress(to)) setTab("address");
      setPrefill(to);
    }
  }, []);
  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="Who to send to" className="grid grid-cols-3 gap-1 rounded-xl border border-harbor p-1">
        {(
          [
            ["user", "Username"],
            ["address", "Wallet address"],
            ["link", "Pay a link"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-lg px-2 py-2.5 text-sm font-medium ${tab === id ? "bg-snow text-abyss" : "text-mist hover:text-snow"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "link" ? <PayALink /> : <FromBalance key={`${tab}:${prefill}`} network={network} mode={tab} prefill={prefill} />}
    </div>
  );
}

function PayALink() {
  const [value, setValue] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const c = extractLinkCode(value);
        if (c) window.location.href = `/pay#${c}`;
      }}
    >
      <label htmlFor="paste" className="block text-sm font-medium text-snow">
        Payment link
      </label>
      <input id="paste" className="field font-mono text-base sm:text-xs" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…/pay#…" autoComplete="off" />
      <p className="text-xs text-haze">You pay it from your connected wallet.</p>
      <button className="btn btn-primary w-full" type="submit" disabled={!value.trim()}>
        Open link
      </button>
    </form>
  );
}

function FromBalance({ network, mode, prefill }: { network: NetworkConfig; mode: "user" | "address"; prefill: string }) {
  const { address } = useAccount();
  const client = usePublicClient(network);
  const queryClient = useQueryClient();
  const readiness = useNetworkReadiness(network);
  const info = usePoolInfo(network);
  const router = usePoolRouter(network);
  const snap = usePoolSnapshot(network);
  const terms = useRelayerTerms(network);
  const token = readiness.data?.token;
  const decimals = token?.decimals ?? 6;
  const symbol = token?.symbol ?? "tUSDG";
  const fmt = (v: bigint) => `${formatAmount(v, decimals, { group: true })} ${symbol}`;

  const [toInput, setToInput] = useState(prefill && (mode === "address" ? isAddress(prefill) : !isAddress(prefill)) ? prefill : "");
  const [amountInput, setAmountInput] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ amount: bigint; arrives: bigint; to: string; hashes: string[] } | null>(null);

  const notes: Note[] = useMemo(() => (snap.data?.notes ?? []).filter((n) => n.status === "spendable" && n.approved && n.value > 0n), [snap.data]);
  const available = notes.reduce((s, n) => s + n.value, 0n);
  const waiting = (snap.data?.notes ?? []).filter((n) => n.status === "spendable" && !n.approved && !n.excluded).reduce((s, n) => s + n.value, 0n);
  const feeBPS = terms.data?.feeBPS ? BigInt(terms.data.feeBPS) : null;
  const minPart = terms.data?.minWithdrawal ? BigInt(terms.data.minWithdrawal) : 0n;

  const to: SendTo | null = useMemo(() => {
    if (mode === "address") return isAddress(toInput.trim()) ? { kind: "address", address: getAddress(toInput.trim()) } : null;
    return parseUserInput(toInput);
  }, [mode, toInput]);
  const amount = useMemo(() => {
    if (!amountInput.trim()) return { value: undefined as bigint | undefined, error: null as string | null };
    try {
      const v = parseAmount(amountInput, decimals);
      if (v <= 0n) return { value: undefined, error: "Enter an amount greater than zero." };
      if (v > available) return { value: undefined, error: `You have ${fmt(available)} available to send.` };
      return { value: v, error: null };
    } catch (e) {
      return { value: undefined, error: e instanceof AmountError ? e.message : "Invalid amount." };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountInput, decimals, available]);
  const parts = amount.value !== undefined ? planParts(notes, amount.value) : null;
  const tooSmallPart = parts?.some((p) => p.amount < minPart) ?? false;
  const costs = parts && feeBPS !== null ? afterFees(parts, feeBPS) : null;
  const toWallet = to?.kind === "address" && address && to.address === getAddress(address);

  async function lockFor(t: Exclude<SendTo, { kind: "address" }>, pool: Address) {
    const q = t.kind === "name" ? `name=${encodeURIComponent(t.name)}` : `key=${t.key}`;
    const r = await fetch(`/api/locks?${q}`, { cache: "no-store" });
    const j = (await r.json().catch(() => ({}))) as { key?: Address; lock?: unknown; error?: string };
    if (!r.ok || !j.key || !j.lock) throw new Error(j.error ?? "Couldn't reach QuietPay. Try again.");
    if (t.kind === "key" && getAddress(j.key) !== t.key) throw new Error("These payment details weren't signed by the recipient. Don't pay.");
    return verifyLock(j.lock, { key: j.key, chainId: network.chain.id, pool });
  }

  async function send() {
    if (!to || !parts || feeBPS === null || !terms.data?.feeRecipient || !info.data || !snap.data) return;
    if (to.kind !== "address" && !router.data) {
      setError("Sending to usernames isn't available right now.");
      return;
    }
    setError(null);
    const feeRecipient = getAddress(terms.data.feeRecipient);
    const hashes: string[] = [];
    let poolInfo: PoolInfo = info.data;
    let events: PoolEvents = snap.data.events;
    try {
      setStage("Downloading circuit files (about 20 MB, once)");
      await Promise.all([load("withdraw.wasm"), load("withdraw.zkey")].map((p) => p.catch(() => null)));
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const label = parts.length > 1 ? ` (${i + 1} of ${parts.length})` : "";
        let j: { hash?: string; error?: string } = {};
        for (let attempt = 0; attempt < 2; attempt++) {
          setStage(`Preparing the payment on this device${label}`);
          let body: unknown;
          if (to.kind === "address") {
            const w = await prepareWithdrawal(load, { info: poolInfo, events, keys: part.note.keys, note: part.note, amount: part.amount, recipient: to.address, feeRecipient, feeBPS });
            body = serializeWithdrawal(w);
          } else {
            const lock = await lockFor(to, poolInfo.pool);
            const fee = feeFor(part.amount, feeBPS);
            const t = await prepareTransfer(load, { info: poolInfo, events, keys: part.note.keys, note: part.note, router: router.data!, amount: part.amount, to: lock, feeRecipient, fee });
            body = { kind: "transfer", ...serializeWithdrawal({ ...t, scope: poolInfo.scope, recipient: router.data!, amount: part.amount, fee }) };
          }
          setStage(`Sending${label}`);
          const r = await fetch(network.pool!.relayerUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          j = (await r.json().catch(() => ({}))) as typeof j;
          if (r.ok && j.hash) break;
          if (attempt === 0 && /approval list changed|payment details were already used/i.test(j.error ?? "")) {
            const fresh = await verifyPool(client, network);
            if (!fresh) break;
            poolInfo = fresh;
            events = await fetchPoolEvents(client, { entrypoint: fresh.entrypoint, pool: fresh.pool, fromBlock: network.pool!.fromBlock, chunkSize: network.logChunkSize, exclusions: exclusionsFrom(network.pool!.exclusionsUrl) });
            continue;
          }
          break;
        }
        if (!j.hash) {
          const sent = hashes.length ? ` ${hashes.length} of ${parts.length} parts were sent.` : " Nothing was sent.";
          throw new Error((j.error ?? "The relayer couldn't send this.") + sent);
        }
        hashes.push(j.hash);
      }
      setDone({ amount: amount.value!, arrives: costs!.arrives, to: to.kind === "address" ? shorten(to.address, 6) : to.kind === "name" ? `@${to.name}` : shorten(to.key, 4), hashes });
      setAmountInput("");
    } catch (e) {
      setError(e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message);
    } finally {
      setStage(null);
      await queryClient.invalidateQueries({ queryKey: ["pool-info"] });
      await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
    }
  }

  if (snap.isLoading || info.isLoading || readiness.isLoading) return <LoadingRows label="Reading your balance" rows={3} />;
  if (done)
    return (
      <div className="space-y-4">
        <Notice tone="ok" title="Sent">
          {fmt(done.arrives)} is on its way to {done.to}
          {done.hashes.length > 1 ? ` in ${done.hashes.length} parts` : ""}.
        </Notice>
        <button type="button" className="btn btn-quiet w-full" onClick={() => setDone(null)}>
          Send more
        </button>
      </div>
    );

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      noValidate
    >
      <p className="text-sm text-haze">
        Available <span className="text-snow">{fmt(available)}</span>
        {waiting > 0n && <> · {fmt(waiting)} awaiting approval</>}
      </p>
      <div>
        <label htmlFor="send-to" className="mb-2 block text-sm font-medium text-snow">
          {mode === "address" ? "Wallet address" : "Username or personal link"}
        </label>
        <input
          id="send-to"
          className={`field text-base ${mode === "address" ? "font-mono sm:text-xs" : ""}`}
          value={toInput}
          onChange={(e) => setToInput(e.target.value)}
          placeholder={mode === "address" ? "0x…" : "@username"}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        {toInput.trim() && !to && <p className="mt-2 text-xs text-bad">{mode === "address" ? "That isn't a valid address." : "Enter a @username or a QuietPay personal link."}</p>}
        {toWallet && <p className="mt-2 text-xs text-warn">This is your connected wallet. Sending here ties the money to it publicly.</p>}
        {to?.kind === "key" && (
          <p className="mt-2 text-xs text-haze">
            Personal link <Mono>{shorten(to.key, 4)}</Mono>
          </p>
        )}
      </div>
      <div>
        <label htmlFor="send-amount" className="mb-2 block text-sm font-medium text-snow">
          Amount
        </label>
        <div className="relative">
          <input
            id="send-amount"
            className="field pr-20 text-lg"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value.replace(",", "."))}
          />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-haze">{symbol}</span>
        </div>
        {amount.error && <p className="mt-2 text-xs text-bad">{amount.error}</p>}
        {tooSmallPart && <p className="mt-2 text-xs text-bad">Part of this is too small to send right now. Try a larger amount.</p>}
        {costs && !amount.error && (
          <p className="mt-2 text-xs text-haze">
            Fee {fmt(costs.fee)} · arrives {fmt(costs.arrives)}
            {parts && parts.length > 1 ? ` · sent in ${parts.length} parts` : ""}
          </p>
        )}
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <button type="submit" className="btn btn-primary w-full" disabled={!to || !parts || tooSmallPart || !!stage || feeBPS === null || !terms.data?.available}>
        {stage ? (
          <>
            <Spinner /> {stage}
          </>
        ) : (
          <>Send{amount.value !== undefined ? ` ${fmt(amount.value)}` : ""}</>
        )}
      </button>
      {terms.data && !terms.data.available && <Notice tone="warn">The relayer is not available right now. Try again shortly.</Notice>}
      {available === 0n && waiting === 0n && (
        <p className="text-center text-sm text-haze">
          Nothing to send yet.{" "}
          <Link href="/receive" className="underline underline-offset-4">
            Receive
          </Link>
        </p>
      )}
    </form>
  );
}
