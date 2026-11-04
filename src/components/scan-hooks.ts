"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { NetworkConfig } from "@/config/networks";
import { applyScan, discoverLinks, scanRequest } from "@/lib/receive";
import { classifyTxError } from "@/lib/tx-errors";
import type { StoredRequest } from "@/lib/vault";
import { useNetworkReadiness, usePublicClient } from "./hooks";
import { useVault } from "./VaultProvider";

/**
 * Finds payments to known links, and links this wallet made that this browser doesn't have yet
 * (new device, cleared data, or another device). Everything is matched locally. Used by Receive
 * (on demand) and Home (on open, so the balance is current).
 */
export function usePaymentScan(network: NetworkConfig) {
  const { vault, update } = useVault();
  const readiness = useNetworkReadiness(network);
  const client = usePublicClient(network);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const running = useRef(false);
  const token = readiness.data?.token;
  const requests = useMemo(() => (vault?.requests ?? []).filter((r) => r.chainId === network.chain.id), [vault, network.chain.id]);

  const scan = useCallback(
    async (fullHistory: boolean) => {
      if (!vault || !vault.linkSeed || !token || !network.announcer || running.current) return;
      running.current = true;
      abort.current = new AbortController();
      setScanning(true);
      setMessage(null);
      setProgress(0);
      try {
        const d = await discoverLinks(client, network, {
          seed: vault.linkSeed,
          nextLinkIndex: vault.nextLinkIndex ?? 0,
          known: vault.requests,
          token: { address: token.address, decimals: token.decimals, symbol: token.symbol },
          fullHistory: fullHistory || !vault.linksCheckedAt,
          onProgress: (done, total) => setProgress(total > 0n ? Number((done * 100n) / total) : 100),
          signal: abort.current.signal,
        });
        let payments = 0;
        const updated = new Map<string, StoredRequest>();
        for (const r of [...d.found, ...requests]) {
          const res = await scanRequest(client, network, r, d.anns, d.toBlock);
          payments += res.newPayments;
          updated.set(r.id, res.request);
        }
        const recovered = d.found.map((r) => updated.get(r.id)!);
        const foundIds = new Set(d.found.map((r) => r.id));
        await update((v) =>
          applyScan(v, {
            scanned: [...updated.values()].filter((r) => !foundIds.has(r.id)),
            recovered,
            nextLinkIndex: d.nextLinkIndex,
            checkedAt: Date.now(),
          }),
        );
        const parts = [
          d.found.length ? `Recovered ${d.found.length} link${d.found.length === 1 ? "" : "s"} from your wallet.` : "",
          payments ? `Found ${payments} new payment${payments === 1 ? "" : "s"}.` : "",
        ].filter(Boolean);
        setMessage(parts.length ? parts.join(" ") : `No new payments. Scanned up to block ${d.toBlock.toString()}.`);
        setLastRun(Date.now());
        return { found: d.found.length, payments };
      } catch (e) {
        setMessage((e as Error).name === "AbortError" ? "Scan cancelled." : classifyTxError(e).message);
      } finally {
        running.current = false;
        setScanning(false);
      }
    },
    [vault, requests, token, client, network, update],
  );

  const cancel = useCallback(() => abort.current?.abort(), []);
  return { scan, cancel, scanning, progress, message, lastRun, ready: !!vault && !!token && !!network.announcer };
}
