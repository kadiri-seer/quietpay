"use client";

import { useCallback, useEffect, useState } from "react";
import { privateKeyToAccount } from "viem/accounts";
import { checkName, signReservation, NAME_MAX } from "@/lib/names/names";
import { useSelectedNetwork } from "@/components/Providers";
import { XLink } from "@/components/XLink";
import { LoadingRows, Notice, PageTitle, Spinner } from "@/components/ui";
import { useVault } from "@/components/VaultProvider";
import { VaultGate, WalletGate } from "@/components/WalletGate";

type Availability = { name: string; available: boolean; reason: string | null } | null;

async function api<T>(init?: RequestInit, query = ""): Promise<T> {
  const r = await fetch(`/api/names${query}`, { cache: "no-store", ...init });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? "Something went wrong. Try again.");
  return j;
}

export function NamesFlow() {
  const { network } = useSelectedNetwork();
  const [input, setInput] = useState("");
  const [avail, setAvail] = useState<Availability>(null);
  const [checking, setChecking] = useState(false);
  const [closed, setClosed] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const local = input ? checkName(input) : null;
  const name = local?.ok ? local.name : null;

  useEffect(() => {
    api<{ open: boolean }>()
      .then(() => setClosed(null))
      .catch((e: Error) => setClosed(e.message));
  }, []);

  // Live availability, a moment after typing stops.
  useEffect(() => {
    setAvail(null);
    if (!name) return;
    setChecking(true);
    const t = setTimeout(() => {
      api<{ name: string; available: boolean; reason: string | null }>(undefined, `?name=${encodeURIComponent(name)}`)
        .then((j) => {
          setAvail({ name: j.name, available: j.available, reason: j.reason });
        })
        .catch(() => setAvail(null))
        .finally(() => setChecking(false));
    }, 350);
    return () => {
      clearTimeout(t);
      setChecking(false);
    };
  }, [name, version]);

  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
      <PageTitle light="Claim your" bold="name">
        Pay-by-username is coming: people will pay <span className="text-snow">@you</span>, and every payment will still land at a fresh
        address. Reserve your name now. It&apos;s free, nothing goes onchain, and your wallet address is never stored.
      </PageTitle>

      {closed ? (
        <Notice tone="info" title="Not open yet">
          {closed}
        </Notice>
      ) : (
        <div className="panel space-y-6 p-5 sm:p-7">
          <div>
            <label htmlFor="name-input" className="mb-2 block text-sm font-medium text-snow">
              Username
            </label>
            <div className="flex items-center rounded-[10px] border border-harbor bg-abyss focus-within:border-signal focus-within:outline focus-within:outline-1 focus-within:outline-signal">
              <span className="pl-3.5 text-base text-haze" aria-hidden>
                @
              </span>
              <input
                id="name-input"
                className="min-h-11 w-full bg-transparent py-3 pr-3.5 pl-1 text-base text-snow outline-none placeholder:text-haze"
                placeholder="yourname"
                value={input}
                maxLength={NAME_MAX + 1}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setInput(e.target.value.replace(/\s/g, ""))}
                aria-describedby="name-status"
              />
            </div>
            <p id="name-status" className="mt-2 min-h-5 text-sm" aria-live="polite">
              {!input ? (
                <span className="text-haze">3 to {NAME_MAX} characters: letters, numbers and underscores.</span>
              ) : local && !local.ok ? (
                <span className="text-bad">{local.reason}</span>
              ) : checking || !avail ? (
                <span className="inline-flex items-center gap-2 text-haze">
                  <Spinner className="h-3 w-3" /> Checking…
                </span>
              ) : avail.available ? (
                <span className="text-ok">@{avail.name} is available.</span>
              ) : (
                <span className="text-bad">{avail.reason ?? "That name isn't available."}</span>
              )}
            </p>
          </div>

          <div className="border-t border-harbor pt-6">
            <WalletGate network={network} purpose="Connect your wallet to reserve a name. It only unlocks your QuietPay keys; the wallet's address is never sent.">
              <VaultGate>
                <Reserve name={avail?.available ? avail.name : null} onChange={() => setVersion((v) => v + 1)} />
              </VaultGate>
            </WalletGate>
          </div>
        </div>
      )}

      {!closed && (
        <div className="mt-3 flex justify-end">
          <XLink className="-mr-3" />
        </div>
      )}

      <section className="mt-10 space-y-3 text-sm leading-relaxed text-mist" aria-labelledby="names-what">
        <h2 id="names-what" className="font-display text-base font-semibold tracking-[-0.01em] text-snow">
          What is stored
        </h2>
        <p>
          Only the name, the time, and a public key your browser creates for names. That key comes from your QuietPay vault, not your wallet,
          so the list never shows which wallet owns which name. QuietPay does not store your wallet address, email or IP address with it.
        </p>
        <p>
          Your name stays tied to this vault. Export a backup on the Receive page so you can keep it on a new device. Reserved names are
          held for the launch of pay-by-username; QuietPay may remove names that impersonate others.
        </p>
      </section>
    </div>
  );
}

function Reserve({ name, onChange }: { name: string | null; onChange: () => void }) {
  const { vault } = useVault();
  const nameKey = vault?.nameKey ?? null;
  const keyAddr = nameKey ? privateKeyToAccount(nameKey).address : null;
  const [mine, setMine] = useState<{ name: string; at: number } | null | undefined>(undefined);
  const [busy, setBusy] = useState<"reserve" | "release" | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const refresh = useCallback(async () => {
    if (!keyAddr) return;
    const j = await api<{ mine: { name: string; at: number } | null }>(undefined, `?key=${keyAddr}`);
    setMine(j.mine);
  }, [keyAddr]);

  useEffect(() => {
    void refresh().catch((e: Error) => {
      setMine(null);
      setError(e.message);
    });
  }, [refresh]);

  async function act(action: "reserve" | "release", n: string) {
    if (!nameKey) return;
    setBusy(action);
    setError(null);
    try {
      const body = await signReservation(nameKey, action, n);
      await api<{ reserved?: string; released?: string }>({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await refresh();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setConfirmRelease(false);
    }
  }

  if (!nameKey) return <Notice tone="warn">Unlock your vault again to create your name key.</Notice>;
  if (mine === undefined) return <LoadingRows label="Checking your reservation" rows={2} />;

  if (mine) {
    const share = `https://x.com/intent/post?text=${encodeURIComponent(`I just reserved @${mine.name} on @quietpay_, private payment links on Robinhood Chain. Claim yours: ${origin}/names`)}`;
    return (
      <div className="space-y-4">
        <p className="font-display text-2xl font-semibold tracking-[-0.02em] text-snow">@{mine.name} is yours</p>
        <p className="text-sm text-haze">Reserved {new Date(mine.at).toLocaleDateString(undefined, { dateStyle: "medium" })}. You&apos;ll be able to use it when pay-by-username launches.</p>
        <div className="flex flex-wrap gap-2">
          <a href={share} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-primary">
            Share on X<span className="sr-only"> (opens in a new tab)</span>
          </a>
          {confirmRelease ? (
            <>
              <button type="button" className="btn btn-sm" onClick={() => act("release", mine.name)} disabled={!!busy}>
                {busy === "release" ? <Spinner /> : null} Confirm: release @{mine.name}
              </button>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirmRelease(false)} disabled={!!busy}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirmRelease(true)}>
              Release name
            </button>
          )}
        </div>
        {confirmRelease && <p className="text-xs text-haze">Anyone can reserve it after you release it.</p>}
        {error && <Notice tone="bad">{error}</Notice>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button type="button" className="btn btn-primary" onClick={() => name && act("reserve", name)} disabled={!name || !!busy}>
        {busy === "reserve" ? <Spinner /> : null} {name ? <>Reserve <span className="normal-case">@{name}</span></> : "Pick an available name"}
      </button>
      <p className="text-xs text-haze">One name per person. Signing happens in your browser with your name key; your wallet won&apos;t pop up.</p>
      {error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}
