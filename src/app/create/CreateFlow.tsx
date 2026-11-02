"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { EXPIRY_OPTIONS, OPEN_EXPIRY_OPTIONS, PAYMENT_LIMITS } from "@/config/networks";
import type { LinkKind } from "@/lib/link";
import { AmountError, checkLimits, formatAmount, limitsFor, parseAmount } from "@/lib/amount";
import { buildPayUrl } from "@/lib/link";
import { createPaymentRequest } from "@/lib/request";
import { deriveLinkKeys } from "@/lib/link-keys";
import { discoverLinks } from "@/lib/receive";
import type { StoredRequest } from "@/lib/vault";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { PrivacyStatement } from "@/components/PrivacyStatement";
import { useSelectedNetwork } from "@/components/Providers";
import { CopyButton, Countdown, Notice, PageTitle, QR, Skeleton, Spinner, formatDateTime } from "@/components/ui";
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
        Each link gets its own receiving keys, worked out from your wallet. Share it with one payer; the payment lands at an address nobody
        else can tie to you.
      </PageTitle>

      <div className="panel space-y-6 p-5 sm:p-7">
        {readiness.isLoading ? (
          <FormSkeleton label={`Checking ${network.label} contracts`} />
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
  const { vault, update } = useVault();
  const [kind, setKind] = useState<LinkKind>("fixed");
  const [amount, setAmount] = useState("");
  const [expiry, setExpiry] = useState<number>(EXPIRY_OPTIONS[1].seconds);
  const expiryOptions: readonly { label: string; seconds: number }[] = kind === "fixed" ? EXPIRY_OPTIONS : OPEN_EXPIRY_OPTIONS;
  const chooseKind = (k: LinkKind) => {
    setKind(k);
    setExpiry(k === "fixed" ? EXPIRY_OPTIONS[1].seconds : OPEN_EXPIRY_OPTIONS[0].seconds);
    setError(null);
  };
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<string | false>(false);
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
    if (!vault) return;
    if (kind === "fixed" && (!("value" in parsed) || parsed.value === undefined)) return;
    setBusy("Creating link");
    setError(null);
    try {
      if (!vault.linkSeed) throw new Error("Unlock your vault again to create links.");
      // The first time on this device, look for links this wallet already made elsewhere, so the
      // new link gets an unused number (and keys nobody else holds).
      let found: { requests: StoredRequest[]; nextLinkIndex: number } | null = null;
      if (!vault.linksCheckedAt) {
        setBusy("Checking your existing links");
        const d = await discoverLinks(client, network, {
          seed: vault.linkSeed,
          nextLinkIndex: vault.nextLinkIndex ?? 0,
          known: vault.requests,
          token,
          fullHistory: true,
        });
        found = { requests: d.found, nextLinkIndex: d.nextLinkIndex };
        setBusy("Creating link");
      }
      const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
      // Take the link number from the latest saved vault, inside the update, so two tabs (or a
      // scan running elsewhere) can never hand out the same number twice.
      let record: StoredRequest | null = null;
      await update(async (v) => {
        let cur = v;
        if (found) {
          const ids = new Set(cur.requests.map((r) => r.id));
          cur = {
            ...cur,
            requests: [...found.requests.filter((r) => !ids.has(r.id)), ...cur.requests],
            nextLinkIndex: Math.max(cur.nextLinkIndex ?? 0, found.nextLinkIndex),
            linksCheckedAt: Date.now(),
          };
        }
        const index = cur.nextLinkIndex ?? 0;
        const keys = await deriveLinkKeys(cur.linkSeed!, network.chain.id, index);
        record = createPaymentRequest({
          kind,
          chainId: network.chain.id,
          token: token.address,
          amount: kind === "fixed" && "value" in parsed && parsed.value ? parsed.value : 0n,
          decimals: token.decimals,
          symbol: token.symbol,
          expirySeconds: expiry,
          fromBlock,
          keys,
          index,
        });
        // The link is shown only after it is saved; its keys can always be re-derived from the wallet.
        return { ...cur, requests: [record, ...cur.requests], nextLinkIndex: index + 1 };
      });
      if (!record) throw new Error("Could not create the link.");
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
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-snow">What should the payer send?</legend>
        <div className="grid grid-cols-2 gap-2" role="radiogroup">
          {(
            [
              { k: "fixed", title: "Fixed amount", hint: "An invoice. Paid once." },
              { k: "open", title: "Any amount", hint: "Reusable. Payer chooses." },
            ] as const
          ).map((o) => (
            <label
              key={o.k}
              className={`cursor-pointer rounded-lg border px-3 py-3 text-left ${
                kind === o.k ? "border-snow bg-snow/10" : "border-harbor hover:border-mist/60"
              }`}
            >
              <input type="radio" name="kind" value={o.k} checked={kind === o.k} onChange={() => chooseKind(o.k)} className="sr-only" />
              <span className="block text-sm font-medium text-snow">{o.title}</span>
              <span className="mt-0.5 block text-xs text-haze">{o.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {kind === "fixed" ? (
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
      ) : (
        <p className="rounded-xl border border-harbor px-4 py-3 text-sm leading-relaxed text-mist">
          Share one link and get paid any number of times. Every payment still lands at its own one-time address, and payments to this
          link aren&apos;t grouped together onchain.
        </p>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-snow">{kind === "fixed" ? "Link expires after" : "Link expires"}</legend>
        <div className="grid grid-cols-3 gap-2">
          {expiryOptions.map((o) => (
            <label
              key={o.seconds}
              className={`cursor-pointer rounded-lg border px-3 py-2.5 text-center text-sm ${
                expiry === o.seconds ? "border-snow bg-snow/10 text-snow" : "border-harbor text-mist hover:border-mist/60"
              }`}
            >
              <input type="radio" name="expiry" value={o.seconds} checked={expiry === o.seconds} onChange={() => setExpiry(o.seconds)} className="sr-only" />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>

      <button type="submit" className="btn btn-primary w-full" disabled={!!busy}>
        {busy ? (
          <>
            <Spinner /> {busy}…
          </>
        ) : (
          "Create payment link"
        )}
      </button>
      {error && <Notice tone="bad">{error}</Notice>}
    </form>
  );
}

function LinkResult({ request, onReset }: { request: StoredRequest; onReset: () => void }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const url = origin ? buildPayUrl(origin, request.link) : "";
  const open = request.kind === "open";
  const amount = formatAmount(BigInt(request.amount), request.decimals, { group: true });

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="font-display text-3xl font-semibold tracking-[-0.02em] text-snow">
          {open ? "Any amount" : amount} <span className="text-lg text-haze">{request.symbol}</span>
        </p>
        {url && <QR value={url} />}
        <p className="text-sm text-haze">
          {request.expiresAt === 0 ? (
            "Reusable. Never expires."
          ) : (
            <>
              Expires {formatDateTime(request.expiresAt * 1000)} (<Countdown to={request.expiresAt} />)
            </>
          )}
        </p>
      </div>
      <div>
        <label htmlFor="link" className="mb-2 block text-sm font-medium text-snow">
          Payment link
        </label>
        <div className="flex gap-2">
          <input id="link" className="field font-mono text-base sm:text-xs" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          {url && <CopyButton value={url} className="min-h-[2.9rem]" />}
        </div>
        <p className="mt-2 text-xs text-haze">
          {open
            ? "The link holds public keys only. Anyone with it can pay you, as many times as they like."
            : "The link holds public keys only. Anyone with it can pay it once, so share it with the intended payer."}
        </p>
      </div>
      <Notice tone="info" title="Recoverable from your wallet">
        This link&apos;s keys come from your wallet. On any device, connect the same wallet and QuietPay finds its payments again.
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

function FormSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-6" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-3 w-48" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-36" />
        <div className="grid grid-cols-3 gap-2">
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
      </div>
      <Skeleton className="h-11 w-full" />
      <p className="text-xs text-haze" aria-hidden>
        {label}
      </p>
    </div>
  );
}
