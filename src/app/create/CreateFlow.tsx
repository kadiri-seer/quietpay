"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { EXPIRY_OPTIONS, PAYMENT_LIMITS } from "@/config/networks";
import { AmountError, checkLimits, formatAmount, limitsFor, parseAmount } from "@/lib/amount";
import { buildPayUrl } from "@/lib/link";
import { createPaymentRequest } from "@/lib/request";
import type { StoredRequest } from "@/lib/vault";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { PrivacyStatement } from "@/components/PrivacyStatement";
import { useSelectedNetwork } from "@/components/Providers";
import { CopyButton, Countdown, Notice, PageTitle, QR, Spinner, formatDateTime } from "@/components/ui";
import { useVault } from "@/components/VaultProvider";
import { VaultGate, WalletGate } from "@/components/WalletGate";
import { SetupBlocker } from "@/components/SetupBlocker";

export function CreateFlow() {
  const { network } = useSelectedNetwork();
  const readiness = useNetworkReadiness(network);
  const [created, setCreated] = useState<StoredRequest | null>(null);

  return (
    <div className="mx-auto max-w-xl px-4 pt-6 sm:px-6">
      <PageTitle light="Create a" bold="payment link">
        Each link gets its own receiving keys. Share it with one payer; the payment lands at an address nobody else can tie to you.
      </PageTitle>

      <div className="panel space-y-6 p-5 sm:p-7">
        {readiness.isLoading ? (
          <p className="text-sm text-haze">
            <Spinner /> Checking {network.label} contracts…
          </p>
        ) : readiness.data?.token && readiness.data?.announcer ? (
          <WalletGate network={network} purpose="Connect the wallet that will own this link. It only signs to protect your keys; its address is never put in the link.">
            <VaultGate>
              {created ? (
                <LinkResult request={created} onReset={() => setCreated(null)} />
              ) : (
                <CreateForm onCreated={setCreated} />
              )}
            </VaultGate>
          </WalletGate>
        ) : (
          <SetupBlocker network={network} readiness={readiness.data} error={readiness.error} />
        )}
      </div>

      <div className="mt-8">
        <PrivacyStatement compact />
      </div>
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: (r: StoredRequest) => void }) {
  const { network } = useSelectedNetwork();
  const { data } = useNetworkReadiness(network);
  const token = data!.token!;
  const client = usePublicClient(network);
  const { vault, save } = useVault();
  const [amount, setAmount] = useState("");
  const [expiry, setExpiry] = useState<number>(EXPIRY_OPTIONS[1].seconds);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const limits = useMemo(() => limitsFor(token.decimals, PAYMENT_LIMITS), [token.decimals]);
  const parsed = useMemo(() => {
    try {
      const v = parseAmount(amount, token.decimals);
      const limitErr = checkLimits(v, limits, token.decimals, token.symbol);
      return limitErr ? { error: limitErr } : { value: v };
    } catch (e) {
      return { error: e instanceof AmountError ? e.message : "Invalid amount." };
    }
  }, [amount, token.decimals, token.symbol, limits]);

  async function create() {
    setTouched(true);
    if (!("value" in parsed) || parsed.value === undefined || !vault) return;
    setBusy(true);
    setError(null);
    try {
      const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
      const record = createPaymentRequest({
        chainId: network.chain.id,
        token: token.address,
        amount: parsed.value,
        decimals: token.decimals,
        symbol: token.symbol,
        expirySeconds: expiry,
        fromBlock,
      });
      // The link is shown only after its keys are safely encrypted and stored.
      await save({ ...vault, requests: [record, ...vault.requests] });
      onCreated(record);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "Could not create the link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      noValidate
    >
      {token.isMock && (
        <Notice tone="warn" title="Testnet mock token">
          This deployment uses {token.symbol}, a QuietPay test token with no value, because no verified testnet USDG contract exists.
        </Notice>
      )}
      <div>
        <label htmlFor="amount" className="mb-2 block text-sm font-medium text-snow">
          Amount
        </label>
        <div className="relative">
          <input
            id="amount"
            className="field pr-20 text-lg"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(",", "."))}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && "error" in parsed}
            aria-describedby="amount-help"
          />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-haze">{token.symbol}</span>
        </div>
        <p id="amount-help" className={`mt-2 text-xs ${touched && "error" in parsed ? "text-bad" : "text-haze"}`}>
          {touched && "error" in parsed
            ? parsed.error
            : `Between ${formatAmount(limits.min, token.decimals)} and ${formatAmount(limits.max, token.decimals, { group: true })} ${token.symbol}.`}
        </p>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-snow">Link expires after</legend>
        <div className="grid grid-cols-3 gap-2">
          {EXPIRY_OPTIONS.map((o) => (
            <label
              key={o.seconds}
              className={`cursor-pointer rounded-[2px] border px-3 py-2.5 text-center text-sm transition-colors ${
                expiry === o.seconds ? "border-snow bg-snow/10 text-snow" : "border-harbor text-mist hover:border-mist/60"
              }`}
            >
              <input type="radio" name="expiry" value={o.seconds} checked={expiry === o.seconds} onChange={() => setExpiry(o.seconds)} className="sr-only" />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>

      <button type="submit" className="btn btn-primary w-full" disabled={busy}>
        {busy ? <Spinner /> : null} Create payment link
      </button>
      {error && <Notice tone="bad">{error}</Notice>}
    </form>
  );
}

function LinkResult({ request, onReset }: { request: StoredRequest; onReset: () => void }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const url = origin ? buildPayUrl(origin, request.link) : "";
  const amount = formatAmount(BigInt(request.amount), request.decimals, { group: true });

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="font-display text-3xl font-light text-snow">
          {amount} <span className="text-lg text-haze">{request.symbol}</span>
        </p>
        {url && <QR value={url} />}
        <p className="text-sm text-haze">
          Expires {formatDateTime(request.expiresAt * 1000)} (<Countdown to={request.expiresAt} />)
        </p>
      </div>
      <div>
        <label htmlFor="link" className="mb-2 block text-sm font-medium text-snow">
          Payment link
        </label>
        <div className="flex gap-2">
          <input id="link" className="field font-mono text-xs" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          {url && <CopyButton value={url} className="min-h-[2.9rem]" />}
        </div>
        <p className="mt-2 text-xs text-haze">
          The link holds public keys only. Anyone with it can pay it once, so share it with the intended payer.
        </p>
      </div>
      <Notice tone="warn" title="Keep your keys">
        Only this browser can claim the payment. Clearing site data loses the keys. <Link href="/receive#backup" className="underline">Export an encrypted backup</Link>{" "}
        after creating links.
      </Notice>
      <div className="flex flex-wrap gap-3">
        <Link href="/receive" className="btn btn-quiet">
          Track payments
        </Link>
        <button type="button" className="btn btn-quiet" onClick={onReset}>
          Create another
        </button>
      </div>
    </div>
  );
}
