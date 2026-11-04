import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { homeBalance, paymentRemaining, recentActivity, type BalanceNote } from "@/lib/balance";
import type { StoredPayment, StoredRequest } from "@/lib/vault";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const A = "0x1111111111111111111111111111111111111111" as Address;
const ENTRY = "0x2222222222222222222222222222222222222222" as Address;

function note(value: bigint, over: Partial<BalanceNote> = {}): BalanceNote {
  return {
    value,
    status: "spendable",
    label: BigInt(Math.floor(Math.random() * 1e9)),
    approved: true,
    excluded: false,
    deposit: { depositor: A, commitment: 1n, label: 1n, value, precommitment: 1n, blockNumber: 10n, txHash: h(Number(value)) },
    history: [],
    ...over,
  };
}

function payment(over: Partial<StoredPayment> = {}): StoredPayment {
  return {
    stealthAddress: A,
    ephemeralPublicKey: "0x02" as Hex,
    announcementTx: h(999),
    announcementBlock: "5",
    detectedAt: 1_000,
    receivedAmount: "10000000",
    transferVerified: true,
    ...over,
  };
}

const req = (payments: StoredPayment[], chainId = 46630) => ({ chainId, payments }) as unknown as StoredRequest;

describe("one balance", () => {
  it("adds pool money (ready and waiting) and money still at one-time addresses", () => {
    const notes = [
      note(50_000_000n), // received through a username or link, approved
      note(100_000_000n, { approved: false }), // waiting for approval
      note(200_000_000n, { received: { receiveIndex: 0n } }),
    ];
    const b = homeBalance(notes, [req([payment()])], 46630);
    expect(b.pool).toEqual({ ready: 250_000_000n, waiting: 100_000_000n, notApproved: 0n });
    expect(b.oneTime).toBe(10_000_000n);
    expect(b.oneTimeCount).toBe(1);
    expect(b.total).toBe(360_000_000n);
  });

  it("doesn't count spent, exited or screened-out notes, or other networks", () => {
    const notes = [
      note(5n, { status: "spent" }),
      note(7n, { status: "ragequit" }),
      note(9n, { approved: false, excluded: true }),
      note(0n),
    ];
    const b = homeBalance(notes, [req([payment()], 4663)], 46630);
    expect(b.total).toBe(0n);
    expect(b.pool.notApproved).toBe(9n);
  });

  it("counts a one-time payment once, whatever was sent, shielded or returned", () => {
    expect(paymentRemaining(payment())).toBe(10_000_000n);
    expect(paymentRemaining(payment({ claimTx: h(1) }))).toBe(0n);
    expect(paymentRemaining(payment({ transferVerified: false }))).toBe(0n);
    const sends = [{ tx: h(2), to: ENTRY, amount: "6000000", at: 2_000 }];
    expect(paymentRemaining(payment({ sends }))).toBe(4_000_000n);
    // 6 shielded, then 6 came back from the pool: all 10 are at the address again.
    expect(paymentRemaining(payment({ sends, returns: [{ tx: h(3), amount: "6000000", at: 3_000 }] }))).toBe(10_000_000n);
    // Never negative.
    expect(paymentRemaining(payment({ sends: [{ tx: h(4), to: A, amount: "20000000", at: 1 }] }))).toBe(0n);
  });
});

describe("recent activity", () => {
  it("merges pool events and link payments, newest first, without listing pool moves twice", () => {
    const notes = [
      note(20n, { received: { receiveIndex: 0n }, deposit: { depositor: A, commitment: 1n, label: 1n, value: 20n, precommitment: 1n, blockNumber: 100n, txHash: h(20) } }),
      note(6n, {
        deposit: { depositor: A, commitment: 1n, label: 2n, value: 6n, precommitment: 2n, blockNumber: 50n, txHash: h(6) },
        history: [{ value: 2n, spentNullifier: 1n, newCommitment: 2n, blockNumber: 120n, txHash: h(2) }],
      }),
    ];
    const pay = payment({ detectedAt: 4_000, sends: [{ tx: h(6), to: ENTRY, amount: "6", at: 4_500 }, { tx: h(7), to: A, amount: "4", at: 5_000 }] });
    const times: Record<string, number> = { "100": 6_000, "50": 4_500, "120": 7_000 };
    const items = recentActivity(notes, [req([pay])], 46630, (b) => times[b.toString()], { poolEntrypoint: ENTRY });
    expect(items.map((i) => i.kind)).toEqual(["pool-withdrawal", "pool-received", "sent", "pool-deposit", "link-payment"]);
    // Unknown block times still appear, after the timed ones.
    const partial = recentActivity(notes, [], 46630, () => undefined);
    expect(partial.map((i) => i.kind)).toEqual(["pool-withdrawal", "pool-received", "pool-deposit"]);
    expect(recentActivity(notes, [req([pay])], 46630, () => 1, { limit: 2 })).toHaveLength(2);
  });
});
