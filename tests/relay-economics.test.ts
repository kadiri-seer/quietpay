import { describe, expect, it } from "vitest";
import { relayEconomics } from "@/lib/pool/relayer";

const gwei = 10n ** 9n;
const usdg = (n: number) => BigInt(Math.round(n * 1e6));
const base = { feeBPS: 50n, tokenUnitsPerEth: usdg(3000), gasPrice: gwei / 10n }; // 0.1 gwei

describe("relayer economics", () => {
  const relayCost = 750_000n * base.gasPrice; // 0.000075 ETH = 0.225 USDG

  it("refuses withdrawals whose fee can't pay for the relay, and quotes the minimum", () => {
    const r = relayEconomics({ ...base, amount: usdg(10), relayCost, wantDrop: 0n }); // fee 0.05 USDG
    expect(r.ok).toBe(false);
    expect(r.drop).toBe(0n);
    expect(r.minWithdrawal).toBe(usdg(45)); // 0.5% of 45 = 0.225
    expect(relayEconomics({ ...base, amount: r.minWithdrawal, relayCost, wantDrop: 0n }).ok).toBe(true);
    expect(relayEconomics({ ...base, amount: r.minWithdrawal - 1n, relayCost, wantDrop: 0n }).ok).toBe(false);
  });

  it("only tops up with ETH the fee has paid for", () => {
    const want = 2n * 10n ** 14n; // 0.0002 ETH
    // 100 USDG: fee 0.5 = 0.0001667 ETH; minus relay 0.000075 and a transfer's gas.
    const r = relayEconomics({ ...base, amount: usdg(100), relayCost, wantDrop: want });
    expect(r.ok).toBe(true);
    expect(r.drop).toBeGreaterThan(0n);
    expect(r.drop).toBeLessThan(want);
    const feeWei = (usdg(0.5) * 10n ** 18n) / base.tokenUnitsPerEth;
    expect(r.drop + relayCost + 21_000n * base.gasPrice).toBeLessThanOrEqual(feeWei);
    // A large withdrawal gets the full top-up, never more.
    expect(relayEconomics({ ...base, amount: usdg(10_000), relayCost, wantDrop: want }).drop).toBe(want);
  });

  it("can't be drained: many small withdrawals never pay out more ETH than they paid in fees", () => {
    let paidIn = 0n;
    let paidOut = 0n;
    for (let amount = usdg(1); amount <= usdg(200); amount += usdg(7)) {
      const r = relayEconomics({ ...base, amount, relayCost, wantDrop: 10n ** 15n });
      if (!r.ok) continue;
      paidIn += (((amount * base.feeBPS) / 10_000n) * 10n ** 18n) / base.tokenUnitsPerEth;
      paidOut += relayCost + (r.drop > 0n ? r.drop + 21_000n * base.gasPrice : 0n);
    }
    expect(paidOut).toBeLessThanOrEqual(paidIn);
  });

  it("a free relayer (0 fee) takes nothing", () => {
    expect(relayEconomics({ ...base, feeBPS: 0n, amount: usdg(1000), relayCost, wantDrop: 0n }).ok).toBe(false);
  });
});
