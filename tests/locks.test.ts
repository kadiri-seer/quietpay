import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { masterKeysFromSeeds } from "@/lib/pool/crypto";
import { lockMessage, parsePayTarget, personalLock, PERSONAL_INDEX_BASE, signLock, verifyLock } from "@/lib/pool/locks";
import { receiveLock } from "@/lib/pool/receive";
import { HOLD_MS, MemoryLocks } from "@/lib/pool/lock-store";
import { lockCounts, takeLock, uploadLocks, type LockDeps } from "@/lib/pool/lock-service";
import { MemoryStore } from "@/lib/names/store";

const POOL = getAddress("0x9d7c155c9572e9e233990de9b417c7801fd66257");
const CHAIN = 46630;
const keys = masterKeysFromSeeds(1n, 2n);
const SCOPE = 12345n;

async function signed(nameKey: `0x${string}`, j: number) {
  const l = personalLock(keys, SCOPE, BigInt(j));
  return signLock(nameKey, { chainId: CHAIN, pool: POOL, precommitment: l.precommitment, refund: l.refund });
}

describe("signed locks", () => {
  it("are verified against the recipient's key, chain and pool", async () => {
    const k = generatePrivateKey();
    const key = privateKeyToAccount(k).address;
    const l = await signed(k, 0);
    const ok = await verifyLock(l, { key, chainId: CHAIN, pool: POOL });
    expect(ok.precommitment.toString()).toBe(l.p);
    const other = privateKeyToAccount(generatePrivateKey()).address;
    await expect(verifyLock(l, { key: other, chainId: CHAIN, pool: POOL })).rejects.toThrow(/weren't signed/);
    await expect(verifyLock(l, { key, chainId: 4663, pool: POOL })).rejects.toThrow(/weren't signed/);
    await expect(verifyLock({ ...l, r: other }, { key, chainId: CHAIN, pool: POOL })).rejects.toThrow(/weren't signed/);
    await expect(verifyLock({ ...l, p: "0" }, { key, chainId: CHAIN, pool: POOL })).rejects.toThrow(/malformed/);
    await expect(verifyLock({ ...l, s: "0x1234" }, { key, chainId: CHAIN, pool: POOL })).rejects.toThrow(/malformed/);
    expect(lockMessage({ chainId: CHAIN, pool: POOL, precommitment: 5n, refund: other })).toContain("Chain: 46630");
  });

  it("personal locks use their own receive range, apart from one-time links", () => {
    expect(personalLock(keys, SCOPE, 0n)).toEqual(receiveLock(keys, SCOPE, PERSONAL_INDEX_BASE));
    expect(personalLock(keys, SCOPE, 0n).precommitment).not.toBe(receiveLock(keys, SCOPE, 0n).precommitment);
  });

  it("reads who to pay from a link", () => {
    expect(parsePayTarget("#@Kadiri")).toEqual({ kind: "name", name: "kadiri" });
    expect(parsePayTarget("to=0x70997970c51812dc3a010c7d01b50e0d17dc79c8")).toEqual({ kind: "key", key: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
    expect(parsePayTarget("AgAAtiZ…")).toBeNull();
    expect(parsePayTarget("@ab")).toBeNull();
    expect(parsePayTarget("to=0x123")).toBeNull();
  });
});

describe("lock service", () => {
  function deps(now: number, used = new Set<string>()): LockDeps {
    return { locks, names, chainId: CHAIN, pool: POOL, isUsed: async (p) => used.has(p.toString()), now };
  }
  const locks = new MemoryLocks();
  const names = new MemoryStore();
  const k = generatePrivateKey();
  const key = privateKeyToAccount(k).address as Address;

  it("accepts only locks signed by the key they're filed under", async () => {
    const mine = [await signed(k, 0), await signed(k, 1), await signed(k, 2)];
    expect(await uploadLocks(deps(0), { key, locks: mine })).toEqual({ total: 3 });
    // Re-uploading the same locks adds nothing.
    expect(await uploadLocks(deps(0), { key, locks: mine })).toEqual({ total: 3 });
    const someoneElse = await signed(generatePrivateKey(), 3);
    await expect(uploadLocks(deps(0), { key, locks: [someoneElse] })).rejects.toThrow(/signed by the key/);
    await expect(uploadLocks(deps(0), { key, locks: [] })).rejects.toThrow();
  });

  it("hands each payer a different lock, holds it, reissues it if unpaid, and drops used ones", async () => {
    await names.reserve("alice", key, 0);
    const t0 = 1_000_000;
    const a = await takeLock(deps(t0), { name: "alice" }, "1.1.1.1", "s");
    const b = await takeLock(deps(t0), { key }, "1.1.1.2", "s");
    expect(a.key).toBe(key);
    expect(a.lock.p).not.toBe(b.lock.p);
    expect(await lockCounts(deps(t0), key)).toEqual({ available: 1, total: 3 });
    // `a` was paid; `b` was abandoned. After the hold, `b` is offered again and `a` is dropped.
    const used = new Set([a.lock.p]);
    const c = await takeLock(deps(t0, used), { key }, "1.1.1.3", "s");
    const later = t0 + HOLD_MS + 1;
    const d = await takeLock(deps(later, used), { key }, "1.1.1.4", "s");
    const e = await takeLock(deps(later, used), { key }, "1.1.1.5", "s");
    expect([c.lock.p, d.lock.p, e.lock.p]).not.toContain(a.lock.p);
    expect(new Set([c.lock.p, d.lock.p, e.lock.p]).size).toBe(2);
    // Nothing free now.
    await expect(takeLock(deps(later, used), { key }, "1.1.1.6", "s")).rejects.toThrow(/can't receive payments right now/);
  });

  it("refuses unknown usernames and rate-limits askers", async () => {
    await expect(takeLock(deps(0), { name: "nobody_here" }, "2.2.2.2", "s")).rejects.toThrow(/No QuietPay user/);
    const flood = await Promise.allSettled(Array.from({ length: 25 }, () => takeLock(deps(0), { name: "nobody_here" }, "3.3.3.3", "s")));
    expect(flood.some((r) => r.status === "rejected" && /Too many/.test(String(r.reason)))).toBe(true);
  });
});
