import { describe, expect, it } from "vitest";
import { applyScan, mergeScannedRequest } from "@/lib/receive";
import { createPaymentRequest } from "@/lib/request";
import { emptyVault, type StoredPayment, type StoredRequest } from "@/lib/vault";
import { TEST_TOKEN } from "./helpers";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;

function req(): StoredRequest {
  return createPaymentRequest({ kind: "open", chainId: 46630, token: TEST_TOKEN, amount: 0n, decimals: 6, symbol: "tUSDG", expirySeconds: 0, fromBlock: 1n });
}
const pay = (addr: `0x${string}`, extra: Partial<StoredPayment> = {}): StoredPayment => ({
  stealthAddress: addr,
  ephemeralPublicKey: "0x02",
  announcementTx: "0xaa",
  announcementBlock: "5",
  detectedAt: 1,
  receivedAmount: "10",
  transferVerified: true,
  ...extra,
});

describe("merging a finished scan into the latest vault", () => {
  it("keeps sends made while the scan ran, and adds what the scan found", () => {
    const base = { ...req(), payments: [pay(A)] };
    // While scanning, the user sent the money on.
    const fresh = { ...base, payments: [pay(A, { sends: [{ tx: "0x01", to: B, amount: "10", at: 2 }], claimTx: "0x01" })] };
    // The scan started from the older copy and found a second payment.
    const scanned = { ...base, payments: [pay(A, { receivedAmount: "10" }), pay(B)], lastScannedBlock: "99" };
    const m = mergeScannedRequest(fresh, scanned);
    expect(m.payments).toHaveLength(2);
    expect(m.payments.find((p) => p.stealthAddress === A)?.claimTx).toBe("0x01");
    expect(m.payments.find((p) => p.stealthAddress === A)?.sends).toHaveLength(1);
    expect(m.lastScannedBlock).toBe("99");
  });

  it("never lowers the link counter or drops links and deliveries added meanwhile", () => {
    const r1 = req();
    const r2 = req();
    const recovered = { ...req(), recovered: true };
    const v = {
      ...emptyVault(WALLET),
      requests: [r1, r2],
      nextLinkIndex: 7,
      deliveries: [{ id: "d", label: "1", poolKeyIndex: 0, depositTx: "0x01", to: A, notBefore: 0, timing: "asap", status: "scheduled" }],
    } as never;
    const out = applyScan(v, { scanned: [{ ...r1, lastScannedBlock: "50" }], recovered: [recovered], nextLinkIndex: 3, checkedAt: 123 });
    expect(out.nextLinkIndex).toBe(7);
    expect(out.requests.map((r) => r.id).sort()).toEqual([r1.id, r2.id, recovered.id].sort());
    expect(out.deliveries).toHaveLength(1);
    expect(out.linksCheckedAt).toBe(123);
    // A recovered link already present (same keys) is not added twice.
    const again = applyScan(out, { scanned: [], recovered: [{ ...recovered, id: "0xdead" as `0x${string}` }], nextLinkIndex: 0, checkedAt: 124 });
    expect(again.requests).toHaveLength(3);
  });
});
