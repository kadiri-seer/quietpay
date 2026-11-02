"use client";

/**
 * Carries out scheduled private claims ("claim privately to my wallet"). While QuietPay is open
 * and the vault is unlocked, it checks every few seconds for deliveries that are due, makes the
 * withdrawal proof on this device and hands it to the relayer. Nothing runs when QuietPay is
 * closed: a delivery that comes due then goes out the next time the site is open.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getAddress } from "viem";
import { deliverNote } from "@/lib/pool/deliver";
import { fetchArtifact } from "@/lib/pool/prover";
import type { Delivery } from "@/lib/vault";
import { usePublicClient } from "./hooks";
import { useRelayerTerms } from "./pool-hooks";
import { useSelectedNetwork } from "./Providers";
import { useVault } from "./VaultProvider";

const load = fetchArtifact();
const TICK_MS = 15_000;

export function DeliveryRunner() {
  const { network } = useSelectedNetwork();
  const { status, vault, update } = useVault();
  const client = usePublicClient(network);
  const terms = useRelayerTerms(network);
  const queryClient = useQueryClient();
  const busy = useRef(false);
  const latest = useRef(vault);
  latest.current = vault;

  useEffect(() => {
    if (status !== "unlocked" || !network.pool || !terms.data?.available || !terms.data.feeRecipient) return;
    const feeRecipient = getAddress(terms.data.feeRecipient);
    const feeBPS = BigInt(terms.data.feeBPS ?? "0");

    const patch = (id: string, change: Partial<Delivery>) =>
      update((v) => ({ ...v, deliveries: (v.deliveries ?? []).map((d) => (d.id === id ? { ...d, ...change } : d)) }));

    // Only one QuietPay tab sends deliveries at a time; the others skip their turn.
    async function tick() {
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      if (!locks) return run();
      await locks.request("quietpay-deliveries", { ifAvailable: true }, async (lock) => {
        if (lock) await run();
      });
    }

    async function run() {
      if (busy.current) return;
      const v = latest.current;
      const now = Date.now();
      const due = (v?.deliveries ?? []).filter((d) => d.status === "scheduled" && d.notBefore <= now && (d.retryAt ?? 0) <= now);
      if (!v || due.length === 0) return;
      busy.current = true;
      try {
        for (const d of due) {
          const k = v.poolKeys?.[d.poolKeyIndex];
          if (!k) continue;
          try {
            const out = await deliverNote(client, network, load, {
              keys: { masterNullifier: BigInt(k.masterNullifier), masterSecret: BigInt(k.masterSecret) },
              label: BigInt(d.label),
              to: d.to,
              terms: { feeRecipient, feeBPS },
            });
            if (out.status === "delivered") {
              await patch(d.id, { status: "delivered", tx: out.hash, amount: out.amount.toString(), fee: out.fee.toString(), deliveredAt: Date.now(), lastError: undefined });
              await queryClient.invalidateQueries({ queryKey: ["pool-snapshot"] });
              await queryClient.invalidateQueries({ queryKey: ["pool-info"] });
            } else if (out.status === "gone") {
              await patch(d.id, { status: "cancelled", lastError: "Already moved out of the pool." });
            } else if (out.status === "excluded") {
              await patch(d.id, {
                status: "cancelled",
                lastError: "This deposit didn't pass the pool's sanctions screening. Exit it from the Pool page to take it back.",
              });
            } else if (out.status === "too-small") {
              // Gas prices can change, so try again later rather than giving up.
              await patch(d.id, {
                lastError: "Too small for the relayer at today's network fee. It stays in the pool; QuietPay will try again in an hour.",
                retryAt: Date.now() + 60 * 60_000,
              });
            }
          } catch (e) {
            await patch(d.id, { lastError: e instanceof Error ? e.message.split("\n")[0] : "Delivery failed.", retryAt: Date.now() + 2 * 60_000 });
          }
        }
      } finally {
        busy.current = false;
      }
    }

    void tick();
    const t = setInterval(() => void tick(), TICK_MS);
    return () => clearInterval(t);
  }, [status, network, client, terms.data, update, queryClient]);

  return null;
}
