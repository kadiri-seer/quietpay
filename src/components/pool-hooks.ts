"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { NetworkConfig } from "@/config/networks";
import { verifyPool } from "@/lib/pool/actions";
import type { PoolMasterKeys } from "@/lib/pool/crypto";
import { currentApprovalSet, fetchPoolEvents, reconstructNotes, type PoolNote } from "@/lib/pool/state";
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
  notes: (PoolNote & { keys: PoolMasterKeys; approved: boolean })[];
  nextDepositIndex: bigint;
  events: Awaited<ReturnType<typeof fetchPoolEvents>>;
  approvalsReadable: boolean;
}

/** Pool events and the user's notes, rebuilt locally from public chain data. */
export function usePoolSnapshot(network: NetworkConfig) {
  const client = usePublicClient(network);
  const info = usePoolInfo(network);
  const keys = usePoolKeys();
  return useQuery<PoolSnapshot>({
    queryKey: ["pool-snapshot", network.key, info.data?.pool, info.data?.aspRoot?.toString(), keys.map((k) => k.masterNullifier.toString()).join(",")],
    enabled: !!info.data && keys.length > 0,
    staleTime: 15_000,
    queryFn: async () => {
      const events = await fetchPoolEvents(client, {
        entrypoint: info.data!.entrypoint,
        pool: info.data!.pool,
        fromBlock: network.pool!.fromBlock,
        chunkSize: network.logChunkSize,
      });
      const approvals = currentApprovalSet(events, info.data!.aspRoot);
      const approved = new Set(approvals?.labels.map(String) ?? []);
      const notes: PoolSnapshot["notes"] = [];
      let nextDepositIndex = 0n;
      keys.forEach((k, i) => {
        const r = reconstructNotes(k, info.data!.scope, events);
        if (i === 0) nextDepositIndex = r.nextDepositIndex;
        for (const n of r.notes) notes.push({ ...n, keys: k, approved: approved.has(String(n.label)) });
      });
      notes.sort((a, b) => (a.deposit.blockNumber > b.deposit.blockNumber ? -1 : 1));
      return { notes, nextDepositIndex, events, approvalsReadable: !!approvals || events.rootUpdates.length === 0 };
    },
  });
}
