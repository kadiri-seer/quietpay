"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NetworkConfig } from "@/config/networks";
import { AmountError, formatAmount, parseAmount } from "@/lib/amount";
import { depositFromAccount, afterVettingFee, type PoolInfo } from "@/lib/pool/actions";
import { SHIELD_GAS_BUDGET } from "@/lib/pool/constants";
import { fetchPoolEvents, reconstructNotes } from "@/lib/pool/state";
import { recordSend, stealthAccount, stealthBalances } from "@/lib/receive";
import { classifyTxError } from "@/lib/tx-errors";
import type { StoredPayment, StoredRequest } from "@/lib/vault";
import { usePoolKeys } from "@/components/pool-hooks";
import { usePublicClient } from "@/components/hooks";
import { useVault } from "@/components/VaultProvider";
import { LoadingRows, Notice, Spinner, formatEthCeil } from "@/components/ui";

/**
 * Deposits a payment from its one-time address into the shielded pool. Two transactions, both
 * signed locally by the one-time address and paid from its own ETH: an exact approval, then the
 * deposit. Nothing is sent from the connected wallet.
 */
export function ShieldForm({ request, payment, network, info }: { request: StoredRequest; payment: StoredPayment; network: NetworkConfig; info: PoolInfo }) {
  const client = usePublicClient(network);
  const queryClient = useQueryClient();
  const { vault, save } = useVault();
  const keys = usePoolKeys();
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

  async function shield() {
    if (!vault || value === undefined || keys.length === 0) return;
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
      const updated = recordSend(request, payment.stealthAddress, { tx: res.hash, to: info.entrypoint, amount: value }, remaining);
      await save({ ...vault, requests: vault.requests.map((r) => (r.id === updated.id ? updated : r)) });
      await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
      setDone(`Shielded ${fmt(res.value)}. It can be withdrawn once the pool approves the deposit.`);
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
        The pool mixes this payment with everyone else&apos;s deposits. Later you withdraw any amount to any fresh address, and nothing
        onchain says which deposit it came from. The deposit itself is public.
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

      {bal && bal.token > 0n && value !== undefined && !belowMin && !gasShort && keys.length > 0 ? (
        confirming ? (
          <div className="space-y-2">
            <p className="text-sm text-snow">Shield {fmt(value)}? This sends two transactions from the one-time address.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm btn-primary" onClick={shield} disabled={!!busy}>
                {busy ? <Spinner /> : null} {busy ?? "Confirm shield"}
              </button>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirming(false)} disabled={!!busy}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setConfirming(true)}>
            Shield <span className="normal-case tracking-[0.02em]">{fmt(value)}</span>
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
