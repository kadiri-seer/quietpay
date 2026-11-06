/**
 * Private claims: send a shielded payment on from the pool to an address, through the relayer.
 * Used by the delivery runner for scheduled ("claim privately to my wallet") withdrawals.
 * Everything here runs in the browser: the proof is made locally and only the finished proof
 * goes to the relayer.
 */
import type { Address, PublicClient } from "viem";
import type { NetworkConfig } from "@/config/networks";
import { prepareWithdrawal, serializeWithdrawal, verifyPool } from "./actions";
import type { PoolMasterKeys } from "./crypto";
import type { ArtifactLoader } from "./prover";
import { currentApprovalSet, exclusionsFrom, fetchPoolEvents, latestExclusions, reconstructNotes } from "./state";

export type DeliveryOutcome =
  | { status: "delivered"; hash: `0x${string}`; amount: bigint; fee: bigint }
  /** Not approved yet; the approver was asked. Try again shortly. */
  | { status: "waiting" }
  /** Nothing left to send: already withdrawn or exited some other way. */
  | { status: "gone" }
  /** The deposit failed the pool's screening. It can only exit back to its one-time address. */
  | { status: "excluded" }
  /** The relayer won't take this amount: its fee wouldn't cover the network fee. */
  | { status: "too-small"; minWithdrawal: bigint };

export interface RelayerTermsLite {
  feeRecipient: Address;
  feeBPS: bigint;
}

async function loadState(client: PublicClient, network: NetworkConfig) {
  const info = await verifyPool(client, network);
  if (!info) throw new Error("No pool is configured.");
  const events = await fetchPoolEvents(client, {
    entrypoint: info.entrypoint,
    pool: info.pool,
    fromBlock: network.pool!.fromBlock,
    chunkSize: network.logChunkSize,
    exclusions: exclusionsFrom(network.pool!.exclusionsUrl),
  });
  return { info, events };
}

export async function deliverNote(
  client: PublicClient,
  network: NetworkConfig,
  load: ArtifactLoader,
  p: { keys: PoolMasterKeys; label: bigint; to: Address; terms: RelayerTermsLite },
): Promise<DeliveryOutcome> {
  let { info, events } = await loadState(client, network);
  const find = () => reconstructNotes(p.keys, info.scope, events).notes.find((n) => n.label === p.label);
  let note = find();
  if (!note || note.status !== "spendable" || note.value === 0n) return { status: "gone" };
  const approvals = currentApprovalSet(events, info.aspRoot);
  if (approvals?.excluded.includes(p.label)) return { status: "excluded" };
  if (!approvals?.labels.includes(p.label)) {
    if ((await latestExclusions(network.pool!.exclusionsUrl)).has(p.label.toString())) return { status: "excluded" };
    await fetch("/api/pool/approvals", { method: "POST" }).catch(() => null);
    return { status: "waiting" };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const prepared = await prepareWithdrawal(load, {
      info,
      events,
      keys: p.keys,
      note,
      amount: note.value,
      recipient: p.to,
      feeRecipient: p.terms.feeRecipient,
      feeBPS: p.terms.feeBPS,
    });
    const r = await fetch(network.pool!.relayerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(serializeWithdrawal(prepared)),
    });
    const j = (await r.json()) as { hash?: `0x${string}`; amount?: string; fee?: string; error?: string; minWithdrawal?: string };
    if (r.ok && j.hash) return { status: "delivered", hash: j.hash, amount: BigInt(j.amount ?? note.value), fee: BigInt(j.fee ?? 0) };
    if (r.status === 422 && j.minWithdrawal) return { status: "too-small", minWithdrawal: BigInt(j.minWithdrawal) };
    if (attempt === 0 && /approval list changed|pool moved on/i.test(j.error ?? "")) {
      ({ info, events } = await loadState(client, network));
      note = find();
      if (!note || note.status !== "spendable") return { status: "gone" };
      continue;
    }
    throw new Error(j.error ?? "The relayer could not submit the delivery.");
  }
  throw new Error("The relayer could not submit the delivery.");
}

/** A random time between now and `withinMs` from now, at least 10 minutes away. */
export function randomDeliveryTime(nowMs = Date.now(), withinMs = 24 * 3600_000): number {
  const min = 10 * 60_000;
  const r = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return nowMs + min + Math.floor(r * (withinMs - min));
}
