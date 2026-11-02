"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { getAddress, isAddress } from "viem";
import type { NetworkConfig } from "@/config/networks";
import { AmountError, formatAmount, parseAmount } from "@/lib/amount";
import { depositFromAccount, afterVettingFee, type PoolInfo } from "@/lib/pool/actions";
import { SHIELD_GAS_BUDGET } from "@/lib/pool/constants";
import { fetchPoolEvents, reconstructNotes } from "@/lib/pool/state";
import { recordSend, stealthAccount, stealthBalances } from "@/lib/receive";
import { classifyTxError } from "@/lib/tx-errors";
import type { Delivery, StoredPayment, StoredRequest } from "@/lib/vault";
import { randomDeliveryTime } from "@/lib/pool/deliver";
import { usePoolKeys, useRelayerTerms } from "@/components/pool-hooks";
import { usePublicClient } from "@/components/hooks";
import { useVault } from "@/components/VaultProvider";
import { LoadingRows, Mono, Notice, Spinner, formatEthCeil, shorten } from "@/components/ui";

type Timing = Delivery["timing"];

/** "2026-11-02T15:30" in local time, for <input type="datetime-local">. */
function localInputValue(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/**
 * Deposits a payment from its one-time address into the shielded pool. Two transactions, both
 * signed locally by the one-time address and paid from its own ETH: an exact approval, then the
 * deposit. Nothing is sent from the connected wallet.
 */
export function ShieldForm({ request, payment, network, info }: { request: StoredRequest; payment: StoredPayment; network: NetworkConfig; info: PoolInfo }) {
  const client = usePublicClient(network);
  const queryClient = useQueryClient();
  const { vault, update } = useVault();
  const { address: connected } = useAccount();
  const keys = usePoolKeys();
  const terms = useRelayerTerms(network);
  const feeBPS = terms.data?.feeBPS ? BigInt(terms.data.feeBPS) : null;
  const [deliver, setDeliver] = useState(true);
  const [dest, setDest] = useState(connected ?? "");
  const [timing, setTiming] = useState<Timing>("asap");
  const [chosenAt, setChosenAt] = useState(() => localInputValue(Date.now() + 3600_000));
  useEffect(() => {
    if (connected) setDest((d) => d || connected);
  }, [connected]);
  const [amountInput, setAmountInput] = useState("");
  const [bal, setBal] = useState<{ token: bigint; eth: bigint; cost: bigint } | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fmt = (v: bigint) => `${formatAmount(v, request.decimals, { group: true })} ${request.symbol}`;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, fees] = await Promise.all([stealthBalances(client, request.token, payment.stealthAddress), client.estimateFeesPerGas()]);
      // Realistic cost for approve + deposit; the payer's stipend budgets SHIELD_GAS_BUDGET.
      const cost = ((SHIELD_GAS_BUDGET / 2n) * (fees.maxFeePerGas ?? 0n) * 3n) / 2n;
      setBal({ token: b.token, eth: b.eth, cost });
    } catch (e) {
      setError(classifyTxError(e).message);
    } finally {
      setLoading(false);
    }
  }, [client, request.token, payment.stealthAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const amount = useMemo(() => {
    if (!bal) return { error: null as string | null };
    if (!amountInput.trim()) return { value: bal.token };
    try {
      const v = parseAmount(amountInput, request.decimals);
      if (v <= 0n) return { error: "Enter an amount greater than zero." };
      if (v > bal.token) return { error: "That is more than this payment holds." };
      return { value: v };
    } catch (e) {
      return { error: e instanceof AmountError ? e.message : "Invalid amount." };
    }
  }, [amountInput, bal, request.decimals]);
  const value = "value" in amount ? amount.value : undefined;
  const belowMin = value !== undefined && value < info.minimumDeposit;
  const gasShort = !!bal && bal.eth < bal.cost;
  const destAddr = isAddress(dest.trim(), { strict: false }) ? getAddress(dest.trim()) : null;
  const chosenMs = new Date(chosenAt).getTime();
  const deliveryError = !deliver
    ? null
    : !destAddr
      ? "Enter the address to send it to."
      : timing === "chosen" && !(chosenMs > Date.now())
        ? "Pick a time in the future."
        : null;

  async function shield() {
    if (!vault || value === undefined || keys.length === 0 || deliveryError) return;
    setBusy("Checking pool history");
    setError(null);
    try {
      // Always rebuild the note index from the chain right before depositing.
      const events = await fetchPoolEvents(client, { entrypoint: info.entrypoint, pool: info.pool, fromBlock: network.pool!.fromBlock, chunkSize: network.logChunkSize });
      const { nextDepositIndex } = reconstructNotes(keys[0], info.scope, events);
      setBusy("Approving and depositing");
      const res = await depositFromAccount(client, network, info, {
        account: stealthAccount(request, payment),
        keys: keys[0],
        depositIndex: nextDepositIndex,
        amount: value,
      });
      const remaining = bal!.token - value;
      const now = Date.now();
      const notBefore = !deliver ? 0 : timing === "random" ? randomDeliveryTime(now) : timing === "chosen" ? chosenMs : now;
      const delivery: Delivery | null =
        deliver && destAddr
          ? { id: res.hash, label: res.label.toString(), poolKeyIndex: 0, depositTx: res.hash, to: destAddr, notBefore, timing, status: "scheduled" }
          : null;
      await update((v) => {
        const updated = recordSend(
          v.requests.find((r) => r.id === request.id) ?? request,
          payment.stealthAddress,
          { tx: res.hash, to: info.entrypoint, amount: value },
          remaining,
        );
        return {
          ...v,
          requests: v.requests.map((r) => (r.id === updated.id ? updated : r)),
          ...(delivery ? { deliveries: [...(v.deliveries ?? []), delivery] } : {}),
        };
      });
      // Ask the approver right away (approvals are immediate on testnet). The Pool page keeps
      // checking, so a slow or missed request here only delays approval by a few seconds.
      await fetch("/api/pool/approvals", { method: "POST" }).catch(() => null);
      await queryClient.invalidateQueries({ queryKey: ["pool-info"] });
      await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
      setDone(
        delivery
          ? `Shielded ${fmt(res.value)}. It will arrive at ${shorten(delivery.to, 4)} ${
              timing === "asap" ? "as soon as the pool approves it, usually within a minute" : `around ${when(notBefore)}`
            }. Keep QuietPay open, or it goes out the next time you open it.`
          : `Shielded ${fmt(res.value)}. It will be ready to withdraw as soon as the pool approves it, usually within seconds.`,
      );
      setAmountInput("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message);
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-mist">
        The pool mixes this payment with everyone else&apos;s deposits, then sends it on to you. Nothing onchain says which deposit it came
        from. The deposit itself is public.
      </p>
      <div>
        <label htmlFor={`shield-amt-${payment.stealthAddress}`} className="mb-2 block text-sm font-medium text-snow">
          Amount
        </label>
        <input
          id={`shield-amt-${payment.stealthAddress}`}
          className="field"
          inputMode="decimal"
          autoComplete="off"
          placeholder={bal ? `All (${formatAmount(bal.token, request.decimals, { group: true })})` : "All"}
          value={amountInput}
          onChange={(e) => {
            setAmountInput(e.target.value.replace(",", "."));
            setConfirming(false);
          }}
          aria-invalid={"error" in amount && !!amount.error}
        />
        {"error" in amount && amount.error && <p className="mt-1 text-xs text-bad">{amount.error}</p>}
        {belowMin && <p className="mt-1 text-xs text-bad">The pool&apos;s minimum deposit is {fmt(info.minimumDeposit)}.</p>}
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-2 block text-sm font-medium text-snow">After shielding</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              [true, "Send it to my wallet", "Automatically, through the pool."],
              [false, "Keep it in the pool", "Withdraw later from the Pool page."],
            ] as const
          ).map(([v, title, hint]) => (
            <label key={String(v)} className={`cursor-pointer rounded-xl border p-3 text-sm ${deliver === v ? "border-signal bg-signal/5" : "border-harbor"}`}>
              <input type="radio" className="sr-only" name={`deliver-${payment.stealthAddress}`} checked={deliver === v} onChange={() => setDeliver(v)} />
              <span className="block font-medium text-snow">{title}</span>
              <span className="mt-0.5 block text-xs text-haze">{hint}</span>
            </label>
          ))}
        </div>

        {deliver && (
          <div className="space-y-4 rounded-xl border border-harbor p-4">
            <div>
              <label htmlFor={`deliver-to-${payment.stealthAddress}`} className="mb-2 block text-sm font-medium text-snow">
                Send to
              </label>
              <input
                id={`deliver-to-${payment.stealthAddress}`}
                className="field font-mono text-base sm:text-xs"
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!dest && !destAddr}
              />
              <p className="mt-2 text-xs leading-relaxed text-haze">
                {connected && destAddr === getAddress(connected)
                  ? "Your connected wallet. Onchain it shows only that your wallet received money from the pool, not which payment it was. A fresh address is even more private."
                  : "Any address. It can start empty: the relayer pays the fee and adds a little ETH for gas."}
              </p>
            </div>

            <fieldset>
              <legend className="mb-2 block text-sm font-medium text-snow">When</legend>
              <div className="space-y-2 text-sm">
                {(
                  [
                    ["asap", "As soon as it's approved"],
                    ["chosen", "At a time I choose"],
                    ["random", "At a random time in the next 24 hours"],
                  ] as const
                ).map(([v, label]) => (
                  <label key={v} className="flex min-h-11 cursor-pointer items-center gap-3">
                    <input type="radio" className="h-4 w-4 accent-[var(--color-signal)]" name={`timing-${payment.stealthAddress}`} checked={timing === v} onChange={() => setTiming(v)} />
                    <span className="text-snow">{label}</span>
                  </label>
                ))}
              </div>
              {timing === "chosen" && (
                <input
                  type="datetime-local"
                  className="field mt-2"
                  value={chosenAt}
                  min={localInputValue(Date.now())}
                  onChange={(e) => setChosenAt(e.target.value)}
                  aria-label="Delivery time"
                />
              )}
              <p className="mt-2 text-xs leading-relaxed text-haze">A random time makes the payment more private.</p>
            </fieldset>
            {deliveryError && dest && <p className="text-xs text-bad">{deliveryError}</p>}
          </div>
        )}
      </fieldset>

      {loading && !bal ? (
        <LoadingRows label="Checking balances" rows={3} />
      ) : bal ? (
        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-haze">Available</dt>
          <dd className="text-right text-snow">{fmt(bal.token)}</dd>
          {info.vettingFeeBPS > 0n && value !== undefined && (
            <>
              <dt className="text-haze">Credited after pool fee</dt>
              <dd className="text-right text-snow">{fmt(afterVettingFee(value, info.vettingFeeBPS))}</dd>
            </>
          )}
          {deliver && feeBPS !== null && value !== undefined && (
            <>
              <dt className="text-haze">Delivery fee ({(Number(feeBPS) / 100).toString()}%)</dt>
              <dd className="text-right text-snow">{fmt((value * feeBPS) / 10_000n)}</dd>
              <dt className="text-haze">Arrives</dt>
              <dd className="text-right text-snow">{fmt(value - (value * feeBPS) / 10_000n)}</dd>
            </>
          )}
          <dt className="text-haze">Gas at address</dt>
          <dd className="text-right text-snow">{formatEthCeil(bal.eth)} ETH</dd>
          <dt className="text-haze">Gas needed</dt>
          <dd className="text-right text-snow">{formatEthCeil(bal.cost)} ETH</dd>
        </dl>
      ) : null}

      {gasShort && (
        <Notice tone="warn" title="Not enough gas at this address">
          This payment was made before the payer&apos;s fee covered shielding. Send a little ETH to this one-time address from an unrelated
          wallet, then check again. Topping up from your own wallet would link it to this payment.
        </Notice>
      )}

      {bal && bal.token > 0n && value !== undefined && !belowMin && !gasShort && keys.length > 0 && !deliveryError ? (
        confirming ? (
          <div className="space-y-2">
            <p className="text-sm text-snow">
              {deliver && destAddr ? (
                <>
                  Claim {fmt(value)} privately to <Mono>{shorten(destAddr, 4)}</Mono>? This shields it now (two transactions from the one-time
                  address), then sends it on {timing === "asap" ? "once it's approved" : timing === "random" ? "at a random time" : `around ${when(chosenMs)}`}.
                </>
              ) : (
                <>Shield {fmt(value)}? This sends two transactions from the one-time address.</>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm btn-primary" onClick={shield} disabled={!!busy}>
                {busy ? <Spinner /> : null} {busy ?? (deliver ? "Confirm" : "Confirm shield")}
              </button>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirming(false)} disabled={!!busy}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setConfirming(true)}>
            {deliver ? "Claim privately" : "Shield"} <span className="normal-case tracking-[0.02em]">{fmt(value)}</span>
          </button>
        )
      ) : null}
      {gasShort && (
        <button type="button" className="btn btn-sm btn-quiet" onClick={refresh} disabled={loading}>
          Check again
        </button>
      )}
      {done && (
        <Notice tone="ok">
          {done}{" "}
          <a href="/pool" className="text-signal underline underline-offset-4">
            Open your shielded balance
          </a>
        </Notice>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}
