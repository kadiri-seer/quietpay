"use client";

import { useMemo, useState } from "react";
import { keccak256, numberToHex, slice, type Address } from "viem";
import type { NetworkConfig } from "@/config/networks";
import { PAYMENT_LIMITS } from "@/config/networks";
import { AmountError, checkLimits, formatAmount, limitsFor, parseAmount } from "@/lib/amount";
import type { LinkValidation } from "@/lib/link";
import { verifyLock, type PayTarget } from "@/lib/pool/locks";
import { useNetworkReadiness } from "@/components/hooks";
import { usePoolInfo } from "@/components/pool-hooks";
import { LoadingRows, Notice, Spinner, shorten } from "@/components/ui";
import { WalletGate } from "@/components/WalletGate";
import { PoolPayPanel } from "./PoolPayPanel";

export const targetLabel = (t: PayTarget) => (t.kind === "name" ? `@${t.name}` : shorten(t.key, 4));

/**
 * Pays a @username or a personal link: the payer picks an amount, gets one of the recipient's
 * signed locks, checks the signature, and pays straight into the recipient's pool balance.
 */
export function PersonalPay({ target, network }: { target: PayTarget; network: NetworkConfig }) {
  const readiness = useNetworkReadiness(network);
  const token = readiness.data?.token;
  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="text-sm text-haze">Pay</p>
        <p className="mt-1 break-all font-display text-4xl font-semibold tracking-[-0.02em] text-snow">{targetLabel(target)}</p>
        <p className="mt-2 text-sm text-haze">
          {network.label} · straight into their shielded balance{token?.isMock ? " · test token, no value" : ""}
        </p>
      </div>
      {readiness.isLoading ? (
        <LoadingRows label="Getting ready" rows={2} />
      ) : !token || !network.pool?.router ? (
        <Notice tone="bad">Payments to usernames aren&apos;t available on {network.label} yet.</Notice>
      ) : (
        <WalletGate network={network} purpose="Connect the wallet you'll pay from.">
          <AmountThenPay target={target} network={network} />
        </WalletGate>
      )}
    </div>
  );
}

function AmountThenPay({ target, network }: { target: PayTarget; network: NetworkConfig }) {
  const { data: readiness } = useNetworkReadiness(network);
  const token = readiness!.token!;
  const info = usePoolInfo(network);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<LinkValidation | null>(null);
  const limits = useMemo(() => limitsFor(token.decimals, PAYMENT_LIMITS), [token.decimals]);
  const min = info.data?.minimumDeposit ?? limits.min;
  const parsed = useMemo(() => {
    if (!input.trim()) return { error: null as string | null };
    try {
      const v = parseAmount(input, token.decimals);
      if (v < min) return { error: `The smallest payment is ${formatAmount(min, token.decimals)} ${token.symbol}.` };
      const e = checkLimits(v, limits, token.decimals, token.symbol);
      return e ? { error: e } : { value: v };
    } catch (e) {
      return { error: e instanceof AmountError ? e.message : "Invalid amount." };
    }
  }, [input, token, limits, min]);

  async function next() {
    if (!("value" in parsed) || parsed.value === undefined || !info.data) return;
    setBusy(true);
    setError(null);
    try {
      const q = target.kind === "name" ? `name=${encodeURIComponent(target.name)}` : `key=${target.key}`;
      const r = await fetch(`/api/locks?${q}`, { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { key?: Address; lock?: unknown; error?: string };
      if (!r.ok || !j.key || !j.lock) throw new Error(j.error ?? "Couldn't reach QuietPay. Try again.");
      // A personal link names its key; never accept a lock signed by anyone else.
      if (target.kind === "key" && j.key.toLowerCase() !== target.key.toLowerCase()) throw new Error("These payment details weren't signed by the recipient. Don't pay.");
      const lock = await verifyLock(j.lock, { key: j.key, chainId: network.chain.id, pool: info.data.pool });
      setReady({
        network,
        request: {
          version: 2,
          kind: "fixed",
          chainId: network.chain.id,
          token: token.address,
          amount: parsed.value,
          expiresAt: Math.floor(Date.now() / 1000) + 15 * 60,
          // Identifies this payment in this browser (resuming after a reload); not sent anywhere.
          requestId: slice(keccak256(numberToHex(lock.precommitment, { size: 32 })), 0, 16),
          stealthMetaAddress: `0x${"00".repeat(66)}`,
          poolLock: lock,
        },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (ready) return <PoolPayPanel v={ready} />;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void next();
      }}
      noValidate
    >
      <div>
        <label htmlFor="pay-amount" className="mb-2 block text-sm font-medium text-snow">
          Amount
        </label>
        <div className="relative">
          <input
            id="pay-amount"
            className="field pr-20 text-lg"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={input}
            onChange={(e) => setInput(e.target.value.replace(",", "."))}
            aria-invalid={!!parsed.error}
          />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-haze">{token.symbol}</span>
        </div>
        {parsed.error && <p className="mt-2 text-xs text-bad">{parsed.error}</p>}
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <button type="submit" className="btn btn-primary w-full" disabled={!("value" in parsed) || busy || !info.data}>
        {busy ? <Spinner /> : null} Continue
      </button>
    </form>
  );
}
