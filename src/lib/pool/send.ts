/**
 * Sending from your shielded balance.
 *
 * The pool holds your balance as separate notes (one per payment received), and a withdrawal spends
 * from one note. To send an amount larger than any single note, QuietPay splits it across notes,
 * largest first, one relayed transaction each. Each part pays the relayer's fee.
 *
 *   - to a wallet address: private withdrawals to that address;
 *   - to a @username or personal link: pool-to-pool transfers into the recipient's locks, so the
 *     money never leaves the pool.
 */
import type { Address } from "viem";
import type { PoolNote } from "./state";

export interface Part<N extends Pick<PoolNote, "value"> = PoolNote> {
  note: N;
  amount: bigint;
}

/** Splits `amount` across spendable notes, largest first. Null if they don't add up to it. */
export function planParts<N extends Pick<PoolNote, "value">>(notes: N[], amount: bigint): Part<N>[] | null {
  if (amount <= 0n) return null;
  const sorted = [...notes].filter((n) => n.value > 0n).sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));
  const parts: Part<N>[] = [];
  let left = amount;
  for (const n of sorted) {
    if (left === 0n) break;
    const take = n.value < left ? n.value : left;
    parts.push({ note: n, amount: take });
    left -= take;
  }
  return left === 0n ? parts : null;
}

export const feeFor = (amount: bigint, feeBPS: bigint) => (amount * feeBPS) / 10_000n;

/** What the recipient gets after the relayer's fee on every part. */
export function afterFees(parts: Part<Pick<PoolNote, "value">>[], feeBPS: bigint): { fee: bigint; arrives: bigint } {
  const fee = parts.reduce((s, p) => s + feeFor(p.amount, feeBPS), 0n);
  const total = parts.reduce((s, p) => s + p.amount, 0n);
  return { fee, arrives: total - fee };
}

/** A recipient for Send: a wallet address, or a QuietPay user by @username or personal-link key. */
export type SendTo = { kind: "address"; address: Address } | { kind: "name"; name: string } | { kind: "key"; key: Address };
