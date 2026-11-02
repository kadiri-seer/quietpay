import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createPaymentRequest } from "@/lib/request";
import { MAX_QUARANTINE, parseVault, requestStatus, type StoredPayment, type VaultData } from "@/lib/vault";
import { TEST_TOKEN } from "./helpers";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;
const payment = (over: Partial<StoredPayment> & Record<string, unknown> = {}): StoredPayment =>
  ({
    stealthAddress: "0x1111111111111111111111111111111111111111",
    ephemeralPublicKey: `0x02${"ab".repeat(32)}`,
    announcementTx: H("a"),
    announcementBlock: "100",
    detectedAt: 1_700_000_000_000,
    receivedAmount: "5000000",
    transferVerified: true,
    ...over,
  }) as StoredPayment;
function vaultWith(payments: unknown[], extra: Record<string, unknown> = {}): unknown {
  const req = createPaymentRequest({ chainId: 46630, token: TEST_TOKEN, amount: 5_000_000n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock: 1n });
  return { version: 1, address: WALLET, requests: [{ ...req, payments }], ...extra };
}

describe("strict vault records", () => {
  it("accepts well-formed data unchanged", () => {
    const v = parseVault(vaultWith([payment({ sends: [{ tx: H("b"), to: WALLET, amount: "1", at: 5 }] })]));
    expect(v.quarantine).toBeUndefined();
    expect(v.requests[0].payments).toHaveLength(1);
  });

  it("sets aside a malformed payment, keeps the rest, and leaves it out of the status", () => {
    const v = parseVault(vaultWith([payment(), payment({ stealthAddress: "0x2222222222222222222222222222222222222222", announcementTx: "0x1234" as `0x${string}` })]));
    expect(v.requests[0].payments).toHaveLength(1);
    expect(v.quarantine).toHaveLength(1);
    expect(v.quarantine![0]).toMatchObject({ kind: "payment" });
    expect(JSON.parse(v.quarantine![0].raw).payment.announcementTx).toBe("0x1234");
    expect(requestStatus(v.requests[0])).toBe("claimable");
  });

  it("rejects unexpected properties, bad addresses, impossible amounts and oversized lists", () => {
    const bad = [
      payment({ secretNote: "x" }),
      payment({ stealthAddress: "0xnot-an-address" as `0x${string}` }),
      payment({ receivedAmount: "-5" }),
      payment({ receivedAmount: "1".padEnd(80, "0") }),
      payment({ receivedAmount: null, transferVerified: true }),
      payment({ claimTx: H("c") }), // a claim must say where it went
      payment({ sends: Array.from({ length: 201 }, () => ({ tx: H("d"), to: WALLET, amount: "1", at: 1 })) }),
      payment({ detectedAt: Number.MAX_SAFE_INTEGER }),
      payment({ ephemeralPublicKey: `0x04${"ab".repeat(32)}` as `0x${string}` }),
    ];
    const v = parseVault(vaultWith(bad));
    expect(v.requests[0].payments).toHaveLength(0);
    expect(v.quarantine).toHaveLength(bad.length);
  });

  it("sets aside a link whose public keys don't match its private keys", () => {
    const raw = vaultWith([]) as { requests: { keys: Record<string, string> }[] };
    const other = createPaymentRequest({ chainId: 46630, token: TEST_TOKEN, amount: 1n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock: 1n });
    raw.requests[0].keys.viewingPublicKey = other.keys.viewingPublicKey;
    const v = parseVault(raw);
    expect(v.requests).toHaveLength(0);
    expect(v.quarantine?.[0]).toMatchObject({ kind: "request" });
  });

  it("checks deliveries and optional fields one by one", () => {
    const delivery = { id: "d1", label: "5", poolKeyIndex: 0, depositTx: H("e"), to: WALLET, notBefore: 1, timing: "asap", status: "scheduled" };
    const v = parseVault(
      vaultWith([], {
        deliveries: [delivery, { ...delivery, id: "d2", status: "delivered" }, { ...delivery, id: "d3", timing: "whenever" }],
        nextLinkIndex: -1,
        linkSeed: "0xzz",
        poolKeys: [{ masterNullifier: "1", masterSecret: "2" }],
      }),
    );
    expect(v.deliveries?.map((d) => d.id)).toEqual(["d1"]);
    expect(v.nextLinkIndex).toBeUndefined();
    expect(v.linkSeed).toBeUndefined();
    expect(v.poolKeys).toHaveLength(1);
    expect(v.quarantine?.map((q) => q.kind).sort()).toEqual(["delivery", "delivery", "linkSeed", "nextLinkIndex"]);
  });

  it("keeps earlier set-aside records and caps the list", () => {
    const prior = Array.from({ length: MAX_QUARANTINE }, (_, i) => ({ kind: "payment", reason: "old", at: i, raw: "{}" }));
    const v = parseVault(vaultWith([payment({ announcementTx: "0x00" as `0x${string}` })], { quarantine: prior }));
    expect(v.quarantine).toHaveLength(MAX_QUARANTINE);
    expect(v.quarantine!.at(-1)!.reason).not.toBe("old");
  });

  it("refuses data that isn't a vault at all", () => {
    for (const x of [null, 5, "x", [], { version: 2, address: WALLET, requests: [] }, { version: 1, address: "nope", requests: [] }, { version: 1, address: WALLET }]) {
      expect(() => parseVault(x)).toThrow();
    }
  });

  it("never crashes on random records, and its output always passes again unchanged (fuzz)", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.anything(), fc.record({ stealthAddress: fc.string(), receivedAmount: fc.oneof(fc.string(), fc.constant(null)), transferVerified: fc.boolean() }))), (junk) => {
        const v: VaultData = parseVault(vaultWith([payment(), ...junk]));
        expect(v.requests[0].payments.length).toBeGreaterThanOrEqual(1);
        const again = parseVault(JSON.parse(JSON.stringify(v)));
        expect(again.requests).toEqual(v.requests);
      }),
      { numRuns: 300 },
    );
  });
});
