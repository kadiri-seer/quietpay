"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { privateKeyToAccount } from "viem/accounts";
import { useVault } from "@/components/VaultProvider";
import { getAddress, isAddress, type Address } from "viem";
import type { NetworkConfig } from "@/config/networks";
import { AmountError, formatAmount, parseAmount } from "@/lib/amount";
import { extractLinkCode } from "@/lib/link";
import { prepareWithdrawal, serializeWithdrawal, verifyPool, type PoolInfo } from "@/lib/pool/actions";
import { parsePayTarget, verifyLock } from "@/lib/pool/locks";
import { fetchArtifact } from "@/lib/pool/prover";
import { creditedAmount, prepareTransfer } from "@/lib/pool/receive";
import { useDepositToSelf, useWalletToken } from "@/components/wallet-funds";
import { afterFees, depositFor, feeFor, planParts, splitSend, type SendTo } from "@/lib/pool/send";
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

/** A personal link (…/pay#to=0x…, or just "to=0x…"). */
export function parseUserInput(input: string): SendTo | null {
  const s = input.trim();
  if (!s) return null;
  const frag = s.includes("#") ? s.slice(s.indexOf("#") + 1) : s;
  const t = parsePayTarget(frag);
  return t ? { kind: "key", key: t.key } : null;
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
            ["user", "Personal link"],
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
  // Money in your connected wallet counts too. Sending it pays it into your own shielded balance
  // first (one signature), then it goes out through the pool like everything else.
  const walletBal = useWalletToken(network);
  const inWallet = walletBal.data ?? 0n;
  const self = useDepositToSelf(network);

  // Your own link key: payments to your own personal link aren't allowed.
  const { vault } = useVault();
  const ownKey = vault?.nameKey ? privateKeyToAccount(vault.nameKey).address : null;
  const [toInput, setToInput] = useState(prefill && (mode === "address" ? isAddress(prefill) : !isAddress(prefill)) ? prefill : "");
  const [amountInput, setAmountInput] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ amount: bigint; arrives: bigint; to: string; hashes: string[]; parts: number } | null>(null);
  // Set after wallet money was paid in: the send carries on once the pool approves it.
  const [awaiting, setAwaiting] = useState<{ need: bigint; since: number; hash: string } | null>(null);

  const notes: Note[] = useMemo(() => (snap.data?.notes ?? []).filter((n) => n.status === "spendable" && n.approved && n.value > 0n), [snap.data]);
  const available = notes.reduce((s, n) => s + n.value, 0n);
  const waiting = (snap.data?.notes ?? []).filter((n) => n.status === "spendable" && !n.approved && !n.excluded).reduce((s, n) => s + n.value, 0n);
  const feeBPS = terms.data?.feeBPS ? BigInt(terms.data.feeBPS) : null;
  const minPart = terms.data?.minWithdrawal ? BigInt(terms.data.minWithdrawal) : 0n;
  const vetting = info.data?.vettingFeeBPS ?? 0n;
  // What wallet money is worth once it's in the pool (the pool's vetting fee comes off).
  const walletUsable = creditedAmount(inWallet, vetting);

  const to: SendTo | null = useMemo(() => {
    if (mode === "address") return isAddress(toInput.trim()) ? { kind: "address", address: getAddress(toInput.trim()) } : null;
    return parseUserInput(toInput);
  }, [mode, toInput]);
  const amount = useMemo(() => {
    if (!amountInput.trim()) return { value: undefined as bigint | undefined, error: null as string | null };
    try {
      const v = parseAmount(amountInput, decimals);
      if (v <= 0n) return { value: undefined, error: "Enter an amount greater than zero." };
      if (v > available + walletUsable) return { value: undefined, error: `You have ${fmt(available + walletUsable)} available to send.` };
      return { value: v, error: null };
    } catch (e) {
      return { value: undefined, error: e instanceof AmountError ? e.message : "Invalid amount." };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountInput, decimals, available, walletUsable]);
  const split = amount.value !== undefined ? splitSend(available, walletUsable, amount.value) : null;
  const fromWallet = split?.fromWallet ?? 0n;
  // Paid in from the wallet: enough to cover the shortfall after the vetting fee, at least the pool minimum.
  const minDeposit = info.data?.minimumDeposit ?? 0n;
  const payIn = fromWallet > 0n ? (depositFor(fromWallet, vetting) > minDeposit ? depositFor(fromWallet, vetting) : minDeposit) : 0n;
  const payInTooBig = payIn > inWallet;
  // Fees: the relayer's on the whole amount, plus the pool's vetting fee on what's paid in.
  const parts = split ? (fromWallet > 0n ? null : planParts(notes, split.fromPool)) : null;
  const tooSmallPart = parts?.some((p) => p.amount < minPart) ?? false;
  const costs = amount.value !== undefined && feeBPS !== null ? (parts ? afterFees(parts, feeBPS) : { fee: feeFor(amount.value, feeBPS), arrives: amount.value - feeFor(amount.value, feeBPS) }) : null;
  const payInFee = payIn - creditedAmount(payIn, vetting);
  const toWallet = to?.kind === "address" && address && to.address === getAddress(address);
  const toSelf = to?.kind === "key" && !!ownKey && to.key === ownKey;
  const canSend = !!to && !toSelf && !!split && (fromWallet > 0n ? !payInTooBig && self.ready : !!parts && !tooSmallPart) && feeBPS !== null && !!terms.data?.available;

  async function lockFor(t: Exclude<SendTo, { kind: "address" }>, pool: Address) {
    const r = await fetch(`/api/locks?key=${t.key}`, { cache: "no-store" });
    const j = (await r.json().catch(() => ({}))) as { key?: Address; lock?: unknown; error?: string };
    if (!r.ok || !j.key || !j.lock) throw new Error(j.error ?? "Couldn't reach QuietPay. Try again.");
    if (getAddress(j.key) !== t.key) throw new Error("These payment details weren't signed by the recipient. Don't pay.");
    if (ownKey && getAddress(j.key) === ownKey) throw new Error("That's you. You can't send a payment to yourself.");
    return verifyLock(j.lock, { key: j.key, chainId: network.chain.id, pool });
  }

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["pool-info"] });
    await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
    await queryClient.invalidateQueries({ queryKey: ["wallet-token"] });
  };

  async function send() {
    if (!canSend || !to || amount.value === undefined) return;
    if (to.kind !== "address" && !router.data) {
      setError("Sending to personal links isn't available right now.");
      return;
    }
    setError(null);
    if (fromWallet > 0n) {
      // Step 1: your wallet money goes into your own shielded balance (one signature).
      try {
        setStage("Confirm in your wallet");
        const hash = await self.deposit(payIn);
        setStage("Waiting for the pool to accept it");
        setAwaiting({ need: amount.value, since: Date.now(), hash });
      } catch (e) {
        setStage(null);
        setError(e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message);
      }
      return;
    }
    await sendFromPool([]);
  }

  // Step 2, once the pool has approved what was paid in: send everything from the pool.
  useEffect(() => {
    if (!awaiting) return;
    if (available >= awaiting.need && parts && !stage?.startsWith("Sending")) {
      const prior = [awaiting.hash];
      setAwaiting(null);
      void sendFromPool(prior);
      return;
    }
    if (Date.now() - awaiting.since > 4 * 60_000) {
      setAwaiting(null);
      setStage(null);
      setError("Your wallet money is in your private balance, but the pool hasn't approved it yet. Try sending again in a minute.");
      return;
    }
    const t = setTimeout(() => {
      void fetch("/api/pool/approvals", { method: "POST" }).catch(() => null);
      void refresh();
    }, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaiting, available, parts, snap.dataUpdatedAt]);

  async function sendFromPool(prior: string[]) {
    if (!to || !parts || feeBPS === null || !terms.data?.feeRecipient || !info.data || !snap.data) return;
    const feeRecipient = getAddress(terms.data.feeRecipient);
    const hashes: string[] = [...prior];
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
          const sent = hashes.length > prior.length ? ` ${hashes.length - prior.length} of ${parts.length} parts were sent.` : " Nothing was sent.";
          const kept = prior.length ? " The money from your wallet is safe in your private balance." : "";
          throw new Error((j.error ?? "The relayer couldn't send this.") + sent + kept);
        }
        hashes.push(j.hash);
      }
      const c = afterFees(parts, feeBPS);
      setDone({ amount: amount.value!, arrives: c.arrives, to: to.kind === "address" ? shorten(to.address, 6) : shorten(to.key, 4), hashes, parts: parts.length });
      setAmountInput("");
    } catch (e) {
      setError(e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message);
    } finally {
      setStage(null);
      await refresh();
    }
  }

  if (snap.isLoading || info.isLoading || readiness.isLoading) return <LoadingRows label="Reading your balance" rows={3} />;
  if (done)
    return (
      <div className="space-y-4">
        <Notice tone="ok" title="Sent">
          {fmt(done.arrives)} is on its way to {done.to}
          {done.parts > 1 ? ` in ${done.parts} parts` : ""}.
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
        Available <span className="text-snow">{fmt(available + walletUsable)}</span>
        {inWallet > 0n && (
          <>
            {" "}
            ({fmt(available)} private · {fmt(inWallet)} in your wallet)
          </>
        )}
        {waiting > 0n && <> · {fmt(waiting)} awaiting approval</>}
      </p>
      <div>
        <label htmlFor="send-to" className="mb-2 block text-sm font-medium text-snow">
          {mode === "address" ? "Wallet address" : "Personal link"}
        </label>
        <input
          id="send-to"
          className={`field text-base ${mode === "address" ? "font-mono sm:text-xs" : ""}`}
          value={toInput}
          disabled={!!stage}
          onChange={(e) => setToInput(e.target.value)}
          placeholder={mode === "address" ? "0x…" : "https://quietpay.sbs/pay#to=0x…"}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        {toInput.trim() && !to && <p className="mt-2 text-xs text-bad">{mode === "address" ? "That isn't a valid address." : "Paste a QuietPay personal link."}</p>}
        {toSelf && <p className="mt-2 text-xs text-bad">That&apos;s you. You can&apos;t send a payment to yourself.</p>}
        {toWallet && <p className="mt-2 text-xs text-warn">This is your connected wallet. Moving money here ties it to your wallet publicly.</p>}
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
            disabled={!!stage}
            onChange={(e) => setAmountInput(e.target.value.replace(",", "."))}
          />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-haze">{symbol}</span>
        </div>
        {amount.error && !awaiting && <p className="mt-2 text-xs text-bad">{amount.error}</p>}
        {tooSmallPart && <p className="mt-2 text-xs text-bad">Part of this is too small to send right now. Try a larger amount.</p>}
        {costs && !amount.error && !awaiting && (
          <p className="mt-2 text-xs text-haze">
            Fee {fmt(costs.fee + payInFee)} · arrives {fmt(costs.arrives)}
            {parts && parts.length > 1 ? ` · sent in ${parts.length} parts` : ""}
          </p>
        )}
        {fromWallet > 0n && !amount.error && !awaiting && (
          <p className="mt-2 text-xs text-haze">
            {fmt(payIn)} goes from your wallet into your private balance first (one signature), then everything is sent through the pool.
          </p>
        )}
        {payInTooBig && !amount.error && !awaiting && <p className="mt-2 text-xs text-bad">The pool takes at least {fmt(minDeposit)} at a time. Try a different amount.</p>}
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <button type="submit" className="btn btn-primary w-full" disabled={!canSend || !!stage}>
        {stage ? (
          <>
            <Spinner /> {stage}
          </>
        ) : (
          <>Send{amount.value !== undefined ? ` ${fmt(amount.value)}` : ""}</>
        )}
      </button>
      {terms.data && !terms.data.available && <Notice tone="warn">The relayer is not available right now. Try again shortly.</Notice>}
      {awaiting && <p className="text-center text-xs text-haze">Your wallet money is in. The rest happens on its own; keep this page open.</p>}
      {available === 0n && waiting === 0n && inWallet === 0n && (
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
