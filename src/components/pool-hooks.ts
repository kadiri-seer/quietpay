"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { NetworkConfig } from "@/config/networks";
import { verifyPool } from "@/lib/pool/actions";
import { refundAccount, verifyPoolRouter, verifyPoolRouterInfo } from "@/lib/pool/receive";
import { PERSONAL_INDEX_BASE } from "@/lib/pool/locks";
import { erc20Abi } from "@/config/contracts";
import type { OnchainHoldings } from "@/lib/balance";
import type { PoolMasterKeys } from "@/lib/pool/crypto";
import { currentApprovalSet, exclusionsFrom, fetchPoolEvents, latestExclusions, reconstructNotes, reconstructReceived, reconstructSpares, RECEIVE_INDEX_BASE, type PoolNote } from "@/lib/pool/state";
import { useVault } from "./VaultProvider";
import { usePublicClient } from "./hooks";

/** Verified pool deployment for the network, or null when none is configured. */
export function usePoolInfo(network: NetworkConfig) {
  const client = usePublicClient(network);
  return useQuery({
    queryKey: ["pool-info", network.key, network.pool?.entrypoint, network.pool?.pool],
    enabled: !!network.pool,
    staleTime: 30_000,
    queryFn: () => verifyPool(client, network),
  });
}

/** The pool router after checking its code and bindings; null when none is configured. */
export function usePoolRouter(network: NetworkConfig) {
  const client = usePublicClient(network);
  return useQuery({
    queryKey: ["pool-router", network.key, network.pool?.router],
    enabled: !!network.pool?.router,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => verifyPoolRouter(client, network),
  });
}

/** The configured pool router's address and version (2 takes signed requests). */
export function usePoolRouterInfo(network: NetworkConfig) {
  const client = usePublicClient(network);
  return useQuery({
    queryKey: ["pool-router-info", network.key, network.pool?.router],
    enabled: !!network.pool?.router,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => verifyPoolRouterInfo(client, network),
  });
}

export interface RelayerTerms {
  available: boolean;
  feeRecipient?: `0x${string}`;
  feeBPS?: string;
  gasDrop?: string;
  gasDropEth?: string;
  approvalDelaySeconds?: number;
  /** Smallest withdrawal the relayer takes right now (token base units), or null if unknown. */
  minWithdrawal?: string | null;
}

export function useRelayerTerms(network: NetworkConfig) {
  return useQuery<RelayerTerms>({
    queryKey: ["relayer", network.key, network.pool?.relayerUrl],
    enabled: !!network.pool,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(network.pool!.relayerUrl, { cache: "no-store" });
      if (!r.ok) return { available: false };
      return (await r.json()) as RelayerTerms;
    },
  });
}

/** The vault's pool keys as bigints. The first set is used for new deposits. */
export function usePoolKeys(): PoolMasterKeys[] {
  const { vault } = useVault();
  return useMemo(
    () => (vault?.poolKeys ?? []).map((k) => ({ masterNullifier: BigInt(k.masterNullifier), masterSecret: BigInt(k.masterSecret) })),
    [vault?.poolKeys],
  );
}

export interface PoolSnapshot {
  /** `excluded`: the deposit failed screening; it can only exit back to its depositor. */
  notes: (PoolNote & { keys: PoolMasterKeys; approved: boolean; excluded: boolean; received?: { receiveIndex: bigint } })[];
  nextDepositIndex: bigint;
  /** First receive lock not seen in the pool (locks below it have been paid, possibly from another device). */
  nextReceiveIndex: bigint;
  events: Awaited<ReturnType<typeof fetchPoolEvents>>;
  approvalsReadable: boolean;
}

/** Pool events and the user's notes, rebuilt locally from public chain data. */
export function usePoolSnapshot(network: NetworkConfig) {
  const client = usePublicClient(network);
  const info = usePoolInfo(network);
  const keys = usePoolKeys();
  const { vault } = useVault();
  // Payment links that pay into the pool use lock i = link number i.
  const issued = BigInt(vault?.nextLinkIndex ?? 0);
  // Locks uploaded for personal-link payments.
  const locksIssued = BigInt(vault?.lockCount ?? 0);
  return useQuery<PoolSnapshot>({
    queryKey: ["pool-snapshot", network.key, info.data?.pool, info.data?.aspRoot?.toString(), keys.map((k) => k.masterNullifier.toString()).join(","), issued.toString(), locksIssued.toString()],
    enabled: !!info.data && keys.length > 0,
    staleTime: 15_000,
    queryFn: async () => {
      const events = await fetchPoolEvents(client, {
        entrypoint: info.data!.entrypoint,
        pool: info.data!.pool,
        fromBlock: network.pool!.fromBlock,
        chunkSize: network.logChunkSize,
        exclusions: exclusionsFrom(network.pool!.exclusionsUrl),
      });
      const approvals = currentApprovalSet(events, info.data!.aspRoot);
      const approved = new Set(approvals?.labels.map(String) ?? []);
      const excluded = new Set(approvals?.excluded.map(String) ?? []);
      for (const l of await latestExclusions(network.pool!.exclusionsUrl)) excluded.add(l);
      const notes: PoolSnapshot["notes"] = [];
      let nextDepositIndex = 0n;
      let nextReceiveIndex = 0n;
      keys.forEach((k, i) => {
        const r = reconstructNotes(k, info.data!.scope, events);
        if (i === 0) nextDepositIndex = r.nextDepositIndex;
        for (const n of r.notes) {
          const ok = approved.has(String(n.label));
          notes.push({ ...n, keys: k, approved: ok, excluded: !ok && excluded.has(String(n.label)) });
        }
        // Payments received straight into the pool through payment links.
        const rr = reconstructReceived(k, info.data!.scope, events, i === 0 ? issued : 0n);
        if (i === 0) nextReceiveIndex = rr.nextReceiveIndex;
        // Payments to your personal link.
        // (Every key set is checked: a device that unlocked before 2 November signs locks with its older keys.)
        const personal = reconstructReceived(k, info.data!.scope, events, locksIssued, 20, PERSONAL_INDEX_BASE).notes;
        // Spare locks of signed requests (used when a link's own lock was burned).
        const spares = reconstructSpares(k, info.data!.scope, events, i === 0 ? issued : 0n);
        for (const n of [...rr.notes, ...personal, ...spares]) {
          const ok = approved.has(String(n.label));
          notes.push({ ...n, keys: k, approved: ok, excluded: !ok && excluded.has(String(n.label)), received: { receiveIndex: n.depositIndex - RECEIVE_INDEX_BASE } });
        }
      });
      notes.sort((a, b) => (a.deposit.blockNumber > b.deposit.blockNumber ? -1 : 1));
      return { notes, nextDepositIndex, nextReceiveIndex, events, approvalsReadable: !!approvals || events.rootUpdates.length === 0 };
    },
  });
}

/**
 * Token balances of this wallet's one-time addresses (link payments) and of the refund addresses
 * of link payments returned from the pool, read from the chain.
 */
export function useOnchainHoldings(network: NetworkConfig, notes: PoolSnapshot["notes"] | undefined, scope: bigint | undefined) {
  const client = usePublicClient(network);
  const { vault } = useVault();
  const token = network.token;
  const stealth = useMemo(() => {
    const out = new Set<string>();
    for (const r of vault?.requests ?? []) if (r.chainId === network.chain.id) for (const p of r.payments) out.add(p.stealthAddress.toLowerCase());
    return [...out].sort();
  }, [vault, network.chain.id]);
  const refunds = useMemo(() => {
    if (scope === undefined) return [];
    const out = new Set<string>();
    for (const n of notes ?? []) if (n.received && n.status === "ragequit") out.add(refundAccount(n.keys, scope, n.received.receiveIndex).address.toLowerCase());
    return [...out].sort();
  }, [notes, scope]);
  return useQuery<OnchainHoldings>({
    queryKey: ["onchain-holdings", network.key, token, stealth.join(","), refunds.join(",")],
    enabled: !!token,
    staleTime: 15_000,
    queryFn: async () => {
      const read = async (addrs: string[]) => {
        const out: bigint[] = [];
        for (let i = 0; i < addrs.length; i += 20) {
          const part = await Promise.all(
            addrs.slice(i, i + 20).map((a) => client.readContract({ address: token!, abi: erc20Abi, functionName: "balanceOf", args: [a as `0x${string}`] })),
          );
          out.push(...part);
        }
        return out;
      };
      const [s, r] = await Promise.all([read(stealth), read(refunds)]);
      return {
        oneTime: s.reduce((a, b) => a + b, 0n),
        oneTimeCount: s.filter((b) => b > 0n).length,
        refunds: r.reduce((a, b) => a + b, 0n),
      };
    },
  });
}
