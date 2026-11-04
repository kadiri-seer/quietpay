"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import type { Hash } from "viem";
import type { LinkValidation } from "@/lib/link";
import { formatAmount } from "@/lib/amount";
import { verifyPool, type PoolInfo } from "@/lib/pool/actions";
import { creditedAmount, payIntoPool, poolPayPreflight, verifyPoolRouter } from "@/lib/pool/receive";
import type { PreflightCheck } from "@/lib/payer";
import { classifyTxError } from "@/lib/tx-errors";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { ExplorerLink, Notice, Spinner } from "@/components/ui";
import { mockTokenFaucetAbi } from "@/config/contracts";

/** Remembers a submitted pool payment per link, so a reload resumes instead of paying twice. */
const storeKey = (requestId: string) => `quietpay:poolpay:${requestId.toLowerCase()}`;
function loadSent(requestId: string): Hash | null {
  try {
    const v = localStorage.getItem(storeKey(requestId));
    return v && /^0x[0-9a-f]{64}$/i.test(v) ? (v as Hash) : null;
  } catch {
    return null;
  }
}
function saveSent(requestId: string, hash: Hash | null) {
  try {
    if (hash) localStorage.setItem(storeKey(requestId), hash);
    else localStorage.removeItem(storeKey(requestId));
  } catch {
    /* storage blocked: the onchain lock check still stops a second payment */
  }
}

type Phase =
  | { k: "checking" }
  | { k: "blocked"; reason: string }
  | { k: "review"; info: PoolInfo; router: `0x${string}`; checks: PreflightCheck[]; ok: boolean }
  | { k: "sending"; step: string }
  | { k: "waiting"; hash: Hash }
  | { k: "done"; hash: Hash | null }
  | { k: "failed"; message: string };

/**
 * Pays a one-time link straight into the recipient's shielded pool balance through the pool
 * router. The link's lock can be used once, so the pool itself refuses a second payment.
 */
export function PoolPayPanel({ v }: { v: LinkValidation }) {
  const { request, network } = v;
  const lock = request.poolLock!;
  const { address } = useAccount();
  const { data: wallet } = useWalletClient({ chainId: network.chain.id });
  const client = usePublicClient(network);
  const { data: readiness } = useNetworkReadiness(network);
  const token = readiness!.token!;
  const [phase, setPhase] = useState<Phase>({ k: "checking" });
  const [faucetBusy, setFaucetBusy] = useState(false);
  const fmt = useMemo(() => (x: bigint) => `${formatAmount(x, token.decimals, { group: true })} ${token.symbol}`, [token]);

  const check = useCallback(async () => {
    if (!address) return;
    setPhase({ k: "checking" });
    try {
      const router = await verifyPoolRouter(client, network);
      const info = await verifyPool(client, network);
      if (!router || !info) {
        setPhase({ k: "blocked", reason: "This link pays into QuietPay's shielded pool, which isn't available on this site right now. Nothing was sent." });
        return;
      }
      // A payment this browser already sent for this link: follow it instead of offering another.
      const sent = loadSent(request.requestId);
      const pf = await poolPayPreflight(client, { info, token: token.address, symbol: token.symbol, decimals: token.decimals, payer: address, amount: request.amount, lock });
      if (pf.alreadyPaid) {
        setPhase({ k: "done", hash: sent });
        return;
      }
      if (sent) {
        const r = await client.getTransactionReceipt({ hash: sent }).catch(() => null);
        if (!r) {
          setPhase({ k: "waiting", hash: sent });
          return;
        }
        // It landed but failed (the link is still unpaid): forget it and offer a fresh payment.
        saveSent(request.requestId, null);
      }
      setPhase({ k: "review", info, router, checks: pf.checks, ok: pf.ok });
    } catch (e) {
      setPhase({ k: "blocked", reason: e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message });
    }
  }, [address, client, network, request, token, lock]);

  useEffect(() => {
    void check();
  }, [check]);

  // Follow a submitted payment until it lands (or is dropped and the link is still unpaid).
  useEffect(() => {
    if (phase.k !== "waiting") return;
    let stop = false;
    void (async () => {
      try {
        const r = await client.waitForTransactionReceipt({ hash: phase.hash, timeout: 120_000 });
        if (stop) return;
        if (r.status === "success") setPhase({ k: "done", hash: phase.hash });
        else {
          saveSent(request.requestId, null);
          setPhase({ k: "failed", message: "The payment reverted onchain. No tokens moved." });
        }
      } catch {
        if (!stop) setPhase({ k: "failed", message: "The payment hasn't shown up onchain yet. Check your wallet, then check again." });
      }
    })();
    return () => {
      stop = true;
    };
  }, [phase, client, request.requestId]);

  async function faucet() {
    if (!wallet) return;
    setFaucetBusy(true);
    try {
      const base = 10n ** BigInt(token.decimals) * 1000n;
      const hash = await wallet.writeContract({
        chain: network.chain,
        account: wallet.account,
        address: token.address,
        abi: mockTokenFaucetAbi,
        functionName: "faucet",
        args: [request.amount > base ? request.amount : base],
      });
      await client.waitForTransactionReceipt({ hash });
      await check();
    } catch (e) {
      setPhase({ k: "failed", message: classifyTxError(e).message });
    } finally {
      setFaucetBusy(false);
    }
  }

  async function pay() {
    if (phase.k !== "review" || !wallet) return;
    const { router } = phase;
    try {
      setPhase({ k: "sending", step: "Confirm in your wallet" });
      const { hash } = await payIntoPool(wallet, client, { network, router, token: token.address, lock, amount: request.amount });
      saveSent(request.requestId, hash);
      setPhase({ k: "waiting", hash });
    } catch (e) {
      const c = classifyTxError(e);
      setPhase({ k: "failed", message: c.message });
    }
  }

  if (phase.k === "checking")
    return (
      <button type="button" className="btn btn-primary w-full" disabled>
        <Spinner /> Getting ready
      </button>
    );
  if (phase.k === "blocked") return <Notice tone="bad">{phase.reason}</Notice>;
  if (phase.k === "done")
    return (
      <Notice tone="ok" title="Paid">
        {phase.hash ? (
          <>
            The payment went straight into the recipient&apos;s shielded pool balance · <ExplorerLink network={network} tx={phase.hash} />
          </>
        ) : (
          "This one-time link has already been paid."
        )}
      </Notice>
    );
  if (phase.k === "waiting")
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm text-mist" aria-live="polite">
          <Spinner /> Waiting for the payment to land · <ExplorerLink network={network} tx={phase.hash} />
        </p>
      </div>
    );
  if (phase.k === "sending")
    return (
      <p className="flex items-center gap-2 text-sm text-mist" aria-live="polite">
        <Spinner /> {phase.step}…
      </p>
    );
  if (phase.k === "failed")
    return (
      <div className="space-y-3">
        <Notice tone="bad">{phase.message}</Notice>
        <button type="button" className="btn btn-quiet" onClick={() => void check()}>
          Check again
        </button>
      </div>
    );

  const credited = creditedAmount(request.amount, phase.info.vettingFeeBPS);
  const problems = phase.checks.filter((c) => c.status === "fail");
  const lowBalance = problems.some((c) => c.id === "balance");
  const lowGas = problems.some((c) => c.id === "gas");
  return (
    <div className="space-y-4">
      {/* Checks run in the background. Only a problem is shown. */}
      {problems.map((c) => (
        <Notice key={c.id} tone="bad">
          {c.id === "balance" ? `Not enough ${token.symbol}. ${c.detail ?? ""}` : (c.detail ?? c.label)}
        </Notice>
      ))}
      {(lowBalance || lowGas) && (
        <div className="flex flex-wrap gap-3">
          {lowBalance && token.isMock && (
            <button type="button" className="btn btn-sm" onClick={() => void faucet()} disabled={faucetBusy}>
              {faucetBusy ? <Spinner /> : null} Get test <span className="normal-case tracking-[0.02em]">{token.symbol}</span>
            </button>
          )}
          {lowGas && network.chain.testnet && (
            <a className="btn btn-sm btn-quiet" href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noopener noreferrer">
              Testnet ETH faucet
            </a>
          )}
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => void check()}>
            Try again
          </button>
        </div>
      )}
      {credited !== request.amount && (
        <p className="text-sm text-haze">
          The pool keeps a {fmt(request.amount - credited)} fee, so the recipient gets {fmt(credited)}.
        </p>
      )}
      <button type="button" className="btn btn-primary w-full" disabled={!phase.ok || !wallet} onClick={() => void pay()}>
        Pay {fmt(request.amount)}
      </button>
    </div>
  );
}
