"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import type { Address, Hash, Hex } from "viem";
import type { LinkValidation } from "@/lib/link";
import { formatAmount } from "@/lib/amount";
import { verifyPool, type PoolInfo } from "@/lib/pool/actions";
import { creditedAmount, payIntoPool, payRequestIntoPool, poolPayPreflight, poolRouterAbi, verifyPoolRouterInfo } from "@/lib/pool/receive";
import { requestKeyOf } from "@/lib/pool/request-sig";
import { verifyLock } from "@/lib/pool/locks";
import { Entrypoint } from "@/config/pool-contracts.generated";
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
  | { k: "review"; info: PoolInfo; router: `0x${string}`; checks: PreflightCheck[]; ok: boolean; target: Target }
  | { k: "sending"; step: string }
  | { k: "waiting"; hash: Hash }
  | { k: "done"; hash: Hash | null }
  | { k: "failed"; message: string };

/** Where the money goes: the link's lock, or for a signed request possibly one of its spares. */
interface Target {
  lock: { precommitment: bigint; refund: Address; sig?: Hex };
  /** Signed requests (router v2): paid with payRequest, and paid status read from the router. */
  requestKey?: Address;
}

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
      const routerInfo = await verifyPoolRouterInfo(client, network);
      const info = await verifyPool(client, network);
      if (!routerInfo || !info) {
        setPhase({ k: "blocked", reason: "This link pays into QuietPay's shielded pool, which isn't available on this site right now. Nothing was sent." });
        return;
      }
      const router = routerInfo.address;
      // A payment this browser already sent for this link: follow it instead of offering another.
      const sent = loadSent(request.requestId);
      let target: Target = { lock };
      if (request.termsSig && lock.sig) {
        // A signed request: only router v2 takes it, and it is paid only when the router says so.
        if (routerInfo.version !== 2) {
          setPhase({ k: "blocked", reason: "This link needs a newer QuietPay payment contract than this site has. Nothing was sent." });
          return;
        }
        const requestKey = await requestKeyOf(
          { chainId: network.chain.id, router, token: token.address, requestId: request.requestId, amount: request.amount, expiresAt: request.expiresAt },
          request.termsSig,
          { pool: info.pool, precommitment: lock.precommitment, refund: lock.refund, sig: lock.sig },
        );
        const paid = await client.readContract({ address: router, abi: poolRouterAbi, functionName: "requestPaid", args: [requestKey] });
        if (paid) {
          setPhase({ k: "done", hash: sent });
          return;
        }
        target = { lock: { precommitment: lock.precommitment, refund: lock.refund, sig: lock.sig }, requestKey };
        // Someone deposited into this link's lock directly (that never counts as paying it). Use one
        // of the request's spare locks instead, signed by the same key.
        const burned = await client.readContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "usedPrecommitments", args: [lock.precommitment] });
        if (burned) {
          const r = await fetch(`/api/locks?key=${requestKey}`, { cache: "no-store" });
          const j = (await r.json().catch(() => ({}))) as { key?: Address; lock?: { s?: Hex }; error?: string };
          if (!r.ok || !j.lock || j.key?.toLowerCase() !== requestKey.toLowerCase())
            throw new Error("This link's payment details were used by someone else and no spare is available. Ask the recipient for a new link. Nothing was sent.");
          const spare = await verifyLock(j.lock, { key: requestKey, chainId: network.chain.id, pool: info.pool });
          if ((j.lock as { v?: number }).v !== 2) throw new Error("The recipient's payment details are malformed.");
          target = { lock: { ...spare, sig: j.lock.s as Hex }, requestKey };
        }
      }
      const pf = await poolPayPreflight(client, { info, token: token.address, symbol: token.symbol, decimals: token.decimals, payer: address, amount: request.amount, lock: target.lock });
      if (pf.alreadyPaid && !target.requestKey) {
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
      setPhase({ k: "review", info, router, checks: pf.checks, ok: pf.ok, target });
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
        if (r.status === "success") {
          setPhase({ k: "done", hash: phase.hash });
          // Ask the pool's approver to look at it now, so it's spendable for the recipient sooner.
          void fetch("/api/pool/approvals", { method: "POST" }).catch(() => null);
        }
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
    const { router, target } = phase;
    try {
      setPhase({ k: "sending", step: "Confirm in your wallet" });
      const { hash } =
        target.requestKey && target.lock.sig && request.termsSig
          ? await payRequestIntoPool(wallet, client, {
              network,
              router,
              token: token.address,
              request: { requestId: request.requestId, amount: request.amount, expiresAt: request.expiresAt, termsSig: request.termsSig },
              lock: { precommitment: target.lock.precommitment, refund: target.lock.refund, sig: target.lock.sig },
            })
          : await payIntoPool(wallet, client, { network, router, token: token.address, lock: target.lock, amount: request.amount });
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
      {/* The pool's fee as it is onchain right now, read before paying. */}
      <p className="text-sm text-haze">
        {credited !== request.amount
          ? `Pool fee ${fmt(request.amount - credited)} (${Number(phase.info.vettingFeeBPS) / 100}%), so the recipient gets ${fmt(credited)}.`
          : "No pool fee: the recipient gets the full amount."}
      </p>
      <button type="button" className="btn btn-primary w-full" disabled={!phase.ok || !wallet} onClick={() => void pay()}>
        Pay {fmt(request.amount)}
      </button>
    </div>
  );
}
