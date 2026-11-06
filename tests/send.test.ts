import { describe, expect, it } from "vitest";
import { afterFees, depositFor, planParts, splitSend } from "@/lib/pool/send";
import { creditedAmount } from "@/lib/pool/receive";

const n = (value: bigint, id: string) => ({ value, id });

describe("sending across notes", () => {
  it("uses one note when it covers the amount, largest first otherwise", () => {
    const notes = [n(50n, "a"), n(100n, "b"), n(200n, "c")];
    expect(planParts(notes, 150n)!.map((p) => [p.note.id, p.amount])).toEqual([["c", 150n]]);
    expect(planParts(notes, 320n)!.map((p) => [p.note.id, p.amount])).toEqual([
      ["c", 200n],
      ["b", 100n],
      ["a", 20n],
    ]);
    expect(planParts(notes, 350n)).toHaveLength(3);
  });

  it("refuses amounts the notes can't cover, zero, and ignores empty notes", () => {
    expect(planParts([n(5n, "a")], 6n)).toBeNull();
    expect(planParts([n(5n, "a")], 0n)).toBeNull();
    expect(planParts([n(0n, "z"), n(5n, "a")], 5n)!.map((p) => p.note.id)).toEqual(["a"]);
  });

  it("charges the relayer's fee on every part", () => {
    const parts = planParts([n(100_000_000n, "a"), n(50_000_000n, "b")], 120_000_000n)!;
    expect(afterFees(parts, 50n)).toEqual({ fee: 600_000n, arrives: 119_400_000n });
  });
});

describe("sending with wallet top-up", () => {
  it("uses private money first and the wallet only for the rest", () => {
    expect(splitSend(100n, 50n, 80n)).toEqual({ fromPool: 80n, fromWallet: 0n });
    expect(splitSend(100n, 50n, 130n)).toEqual({ fromPool: 100n, fromWallet: 30n });
    expect(splitSend(0n, 50n, 50n)).toEqual({ fromPool: 0n, fromWallet: 50n });
    expect(splitSend(100n, 50n, 151n)).toBeNull();
    expect(splitSend(100n, 50n, 0n)).toBeNull();
  });

  it("pays in enough for the vetting fee to leave what's needed", () => {
    for (const bps of [0n, 10n, 100n, 250n])
      for (const x of [1n, 999n, 1_000_000n, 123_456_789n]) {
        const d = depositFor(x, bps);
        expect(creditedAmount(d, bps)).toBeGreaterThanOrEqual(x);
        expect(creditedAmount(d - 1n, bps)).toBeLessThan(x + 1n);
      }
  });
});
