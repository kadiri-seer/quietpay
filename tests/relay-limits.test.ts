import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { approvalRootDecision, relayRevertReason } from "@/lib/pool/relayer";
import { decideGasDrop, gasDropLimitsFromEnv, type GasDropLimits } from "@/lib/server/gas-drops";
import { MemoryKv } from "@/lib/server/guard";

describe("F2: approval roots on a fixed cadence", () => {
  const base = { intervalSec: 60, maxDeferSec: 180, relayBusyUntilSec: null };
  it("publishes the first root right away", () => {
    expect(approvalRootDecision({ ...base, nowSec: 1000, lastRootAtSec: null })).toEqual({ publish: true });
  });
  it("repeated deposits and calls can't publish more than one root per interval", () => {
    // A burst of small deposits, each followed by a call to the approver.
    for (let t = 1001; t < 1060; t += 3) expect(approvalRootDecision({ ...base, nowSec: t, lastRootAtSec: 1000 })).toMatchObject({ publish: false, reason: "interval", retryAtSec: 1060 });
    expect(approvalRootDecision({ ...base, nowSec: 1060, lastRootAtSec: 1000 })).toEqual({ publish: true });
  });
  it("consecutive roots are always at least an interval apart", () => {
    let last = 0;
    const published: number[] = [];
    for (let t = 0; t < 600; t++) {
      if (approvalRootDecision({ ...base, nowSec: t, lastRootAtSec: published.length ? last : null }).publish) {
        published.push(t);
        last = t;
      }
    }
    for (let i = 1; i < published.length; i++) expect(published[i] - published[i - 1]).toBeGreaterThanOrEqual(60);
  });
  it("holds back while a relay is in progress, but never beyond the maximum", () => {
    expect(approvalRootDecision({ ...base, nowSec: 1100, lastRootAtSec: 1000, relayBusyUntilSec: 1130 })).toMatchObject({ publish: false, reason: "relay-in-progress", retryAtSec: 1130 });
    expect(approvalRootDecision({ ...base, nowSec: 1131, lastRootAtSec: 1000, relayBusyUntilSec: 1130 })).toEqual({ publish: true });
    // Someone keeping relays busy forever can't stop roots: after maxDefer they go out anyway.
    expect(approvalRootDecision({ ...base, nowSec: 1180, lastRootAtSec: 1000, relayBusyUntilSec: 99_999 })).toEqual({ publish: true });
  });
  it("the relayer recognises a root change in any form and asks for a new proof", () => {
    expect(relayRevertReason('reverted with the following signature:\n0xa6a78244', "x")).toMatch(/approval list changed/);
    expect(relayRevertReason("IncorrectASPRoot()", "x")).toMatch(/approval list changed/);
    expect(relayRevertReason("0xfd3d3c4c", "x")).toMatch(/pool moved on/);
    expect(relayRevertReason("0xb115d857", "x")).toMatch(/already spent/);
    expect(relayRevertReason("something else", "fallback")).toBe("fallback");
  });
});

describe("F4: gas top-ups are limited", () => {
  const limits: GasDropLimits = { cooldownSec: 86_400, perCallerDaily: 3, dailyMax: 5, minBalanceWei: parseEther("0.02") };
  const want = parseEther("0.0002");
  const rich = parseEther("1");
  it("one top-up per receiving address per cooldown", async () => {
    const kv = new MemoryKv();
    expect((await decideGasDrop({ kv, limits, relayerBalance: rich }, { recipient: "0xAa", caller: "c1", want })).amount).toBe(want);
    expect(await decideGasDrop({ kv, limits, relayerBalance: rich }, { recipient: "0xaa", caller: "c2", want })).toEqual({ amount: 0n, denied: "recipient" });
  });
  it("a caller using many fresh addresses is capped per day, and so is everyone together", async () => {
    const kv = new MemoryKv();
    const got = [];
    for (let i = 0; i < 6; i++) got.push((await decideGasDrop({ kv, limits, relayerBalance: rich }, { recipient: `0x${i}`, caller: "same", want })).amount);
    expect(got.filter((a) => a > 0n)).toHaveLength(3);
    const all = [];
    for (let i = 0; i < 10; i++) all.push(await decideGasDrop({ kv, limits, relayerBalance: rich }, { recipient: `0xb${i}`, caller: `c${i}`, want }));
    // 3 already given today; the daily total of 5 leaves 2 more.
    expect(all.filter((d) => d.amount > 0n)).toHaveLength(2);
    expect(all.some((d) => d.denied === "daily")).toBe(true);
  });
  it("stops top-ups when the relayer runs low, and records it", async () => {
    const kv = new MemoryKv();
    const seen: string[] = [];
    const d = await decideGasDrop({ kv, limits, relayerBalance: parseEther("0.02"), watch: async (e) => void seen.push(e) }, { recipient: "0x1", caller: "c", want });
    expect(d).toEqual({ amount: 0n, denied: "low-balance" });
    expect(seen).toEqual(["relayer.low-balance"]);
  });
  it("nothing wanted, nothing given or counted", async () => {
    const kv = new MemoryKv();
    expect(await decideGasDrop({ kv, limits, relayerBalance: rich }, { recipient: "0x1", caller: "c", want: 0n })).toEqual({ amount: 0n });
    expect((await decideGasDrop({ kv, limits, relayerBalance: rich }, { recipient: "0x1", caller: "c", want })).amount).toBe(want);
  });
  it("reads its limits from the environment, within bounds", () => {
    expect(gasDropLimitsFromEnv({})).toEqual({ cooldownSec: 86_400, perCallerDaily: 3, dailyMax: 50, minBalanceWei: parseEther("0.02") });
    expect(gasDropLimitsFromEnv({ RELAYER_DROP_COOLDOWN_SECONDS: "1", RELAYER_DROPS_PER_DAY: "999999", RELAYER_MIN_BALANCE_ETH: "0.5" })).toMatchObject({ cooldownSec: 60, dailyMax: 10_000, minBalanceWei: parseEther("0.5") });
  });
});
