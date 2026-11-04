/**
 * One balance across everywhere QuietPay holds your money, worked out locally from your vault and
 * the pool's public history:
 *
 *   - in the shielded pool: notes you can withdraw now, and notes waiting for approval
 *     (payments received straight into the pool through links, and deposits you made yourself);
 *   - at one-time addresses: payments to links that haven't been moved yet.
 *
 *   - at refund addresses: link payments returned from the pool after failing screening.
 *
 * Money already moved from a one-time address into the pool is counted once, as a pool note.
 * Notes that failed screening are shown separately: they can only go back to where they came from.
 */
import type { Address, Hex } from "viem";
import type { PoolNote } from "./pool/state";
import type { StoredRequest } from "./vault";

export type BalanceNote = Pick<PoolNote, "value" | "status" | "label" | "deposit" | "history"> & {
  approved: boolean;
  excluded: boolean;
  received?: unknown;
};

export interface HomeBalance {
  total: bigint;
  pool: { ready: bigint; waiting: bigint; notApproved: bigint };
  /** Payments at one-time addresses that are still there (Receive page). */
  oneTime: bigint;
  /** How many one-time-address payments still hold money. */
  oneTimeCount: number;
  /** Returned from the pool to refund addresses (read from the chain). */
  refunds: bigint;
}

/** What is still at a one-time address: received, minus what was sent out, plus what came back. */
export function paymentRemaining(p: StoredRequest["payments"][number]): bigint {
  if (!p.transferVerified || !p.receivedAmount || p.claimTx) return 0n;
  const sent = (p.sends ?? []).reduce((s, x) => s + BigInt(x.amount), 0n);
  const back = (p.returns ?? []).reduce((s, x) => s + BigInt(x.amount), 0n);
  const left = BigInt(p.receivedAmount) - sent + back;
  return left > 0n ? left : 0n;
}

/**
 * Token balances read from the chain, which win over the vault's records when known: they are
 * right even if a send, a return or a payment was never recorded on this device.
 */
export interface OnchainHoldings {
  /** Total held at the one-time addresses of this wallet's link payments. */
  oneTime: bigint;
  oneTimeCount: number;
  /** Total at refund addresses of link payments returned from the pool. */
  refunds: bigint;
}

export function homeBalance(notes: BalanceNote[], requests: StoredRequest[], chainId: number, onchain?: OnchainHoldings | null): HomeBalance {
  const pool = { ready: 0n, waiting: 0n, notApproved: 0n };
  for (const n of notes) {
    if (n.status !== "spendable" || n.value === 0n) continue;
    if (n.approved) pool.ready += n.value;
    else if (n.excluded) pool.notApproved += n.value;
    else pool.waiting += n.value;
  }
  let oneTime = 0n;
  let oneTimeCount = 0;
  for (const r of requests) {
    if (r.chainId !== chainId) continue;
    for (const p of r.payments) {
      const left = paymentRemaining(p);
      if (left > 0n) {
        oneTime += left;
        oneTimeCount++;
      }
    }
  }
  const refunds = onchain?.refunds ?? 0n;
  if (onchain) {
    oneTime = onchain.oneTime;
    oneTimeCount = onchain.oneTimeCount;
  }
  // Notes that failed screening aren't spendable money, so they stay out of the total.
  return { total: pool.ready + pool.waiting + oneTime + refunds, pool, oneTime, oneTimeCount, refunds };
}

export type ActivityItem =
  | { kind: "pool-received"; amount: bigint; block: bigint; tx: Hex }
  | { kind: "pool-deposit"; amount: bigint; block: bigint; tx: Hex }
  | { kind: "pool-withdrawal"; amount: bigint; block: bigint; tx: Hex }
  | { kind: "link-payment"; amount: bigint; at: number; tx: Hex }
  | { kind: "sent"; amount: bigint; at: number; tx: Hex; to: Address };

/**
 * Recent activity, newest first. Pool events carry block numbers; `blockTime` turns them into
 * times (ms) where known, so they sort together with link payments.
 */
export function recentActivity(
  notes: BalanceNote[],
  requests: StoredRequest[],
  chainId: number,
  blockTime: (block: bigint) => number | undefined,
  opts: { poolEntrypoint?: Address | null; limit?: number } = {},
): (ActivityItem & { time: number | undefined })[] {
  const items: (ActivityItem & { time: number | undefined })[] = [];
  for (const n of notes) {
    const d = n.deposit;
    const kind = n.received ? "pool-received" : "pool-deposit";
    items.push({ kind, amount: d.value, block: d.blockNumber, tx: d.txHash, time: blockTime(d.blockNumber) });
    for (const w of n.history) items.push({ kind: "pool-withdrawal", amount: w.value, block: w.blockNumber, tx: w.txHash, time: blockTime(w.blockNumber) });
  }
  const entry = opts.poolEntrypoint?.toLowerCase();
  for (const r of requests) {
    if (r.chainId !== chainId) continue;
    for (const p of r.payments) {
      if (p.transferVerified && p.receivedAmount) items.push({ kind: "link-payment", amount: BigInt(p.receivedAmount), at: p.detectedAt, tx: p.announcementTx, time: p.detectedAt });
      // Moves into the pool already show as a pool deposit.
      for (const s of p.sends ?? []) if (s.to.toLowerCase() !== entry) items.push({ kind: "sent", amount: BigInt(s.amount), at: s.at, tx: s.tx, to: s.to, time: s.at });
    }
  }
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    const k = `${i.kind}:${i.tx}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Unknown times (block not looked up yet) sort by block among themselves, after timed items.
  unique.sort((a, b) => {
    if (a.time !== undefined && b.time !== undefined) return b.time - a.time;
    if (a.time !== undefined) return -1;
    if (b.time !== undefined) return 1;
    const ab = "block" in a ? a.block : 0n;
    const bb = "block" in b ? b.block : 0n;
    return ab === bb ? 0 : ab > bb ? -1 : 1;
  });
  return unique.slice(0, opts.limit ?? 8);
}
