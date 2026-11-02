import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { checkName, deriveNameKey, MAX_SIGNATURE_AGE_MS, ReservationError, signReservation, verifyReservation } from "@/lib/names/names";
import { MemoryStore } from "@/lib/names/store";
import { CLAIMS_PER_HOUR, lookup, submit } from "@/lib/names/service";

describe("name rules", () => {
  it("normalises and accepts good names", () => {
    expect(checkName("@Kadiri")).toEqual({ ok: true, name: "kadiri" });
    expect(checkName("abc_123")).toEqual({ ok: true, name: "abc_123" });
  });
  it("rejects bad, reserved and impersonating names", () => {
    for (const n of ["ab", "a".repeat(21), "has space", "dash-name", "_lead", "trail_", "dou__ble", "12345", "0xabc", "admin", "QuietPay", "quietpay_help", "robinhood"])
      expect(checkName(n).ok, n).toBe(false);
  });
});

describe("name key", () => {
  it("is deterministic per signature and wallet, and is not the wallet", async () => {
    const sig = `0x${"cd".repeat(65)}` as const;
    const a = await deriveNameKey(sig, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(a).toBe(await deriveNameKey(sig, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"));
    expect(a).not.toBe(await deriveNameKey(sig, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"));
    expect(privateKeyToAccount(a).address).not.toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });
});

describe("signed reservations", () => {
  const key = generatePrivateKey();
  it("verifies a fresh signature", async () => {
    const req = await signReservation(key, "reserve", "kadiri");
    await expect(verifyReservation(JSON.parse(JSON.stringify(req)))).resolves.toMatchObject({ name: "kadiri", key: privateKeyToAccount(key).address });
  });
  it("rejects tampering, other keys and stale requests", async () => {
    const req = await signReservation(key, "reserve", "kadiri");
    await expect(verifyReservation({ ...req, name: "kadiri2" })).rejects.toBeInstanceOf(ReservationError);
    await expect(verifyReservation({ ...req, action: "release" })).rejects.toBeInstanceOf(ReservationError);
    await expect(verifyReservation({ ...req, key: privateKeyToAccount(generatePrivateKey()).address })).rejects.toBeInstanceOf(ReservationError);
    const old = await signReservation(key, "reserve", "kadiri", new Date(Date.now() - MAX_SIGNATURE_AGE_MS - 1000));
    await expect(verifyReservation(old)).rejects.toThrow(/expired/);
    await expect(verifyReservation({ ...req, name: "Kadiri" })).rejects.toBeInstanceOf(ReservationError);
    await expect(verifyReservation(null)).rejects.toBeInstanceOf(ReservationError);
  });
});

describe("reservation service", () => {
  it("reserves once, blocks duplicates and second names, and only the owner can release", async () => {
    const store = new MemoryStore();
    const a = generatePrivateKey();
    const b = generatePrivateKey();
    const res = await submit(store, await signReservation(a, "reserve", "kadiri"), "1.1.1.1", "s");
    expect(res).toMatchObject({ reserved: "kadiri", count: 1 });
    await expect(submit(store, await signReservation(b, "reserve", "kadiri"), "2.2.2.2", "s")).rejects.toThrow(/already reserved/);
    await expect(submit(store, await signReservation(a, "reserve", "another"), "1.1.1.1", "s")).rejects.toThrow(/already have a name/);
    expect(await lookup(store, { name: "kadiri" }, "3.3.3.3", "s")).toMatchObject({ available: false });
    expect(await lookup(store, { key: privateKeyToAccount(a).address }, "3.3.3.3", "s")).toMatchObject({ mine: { name: "kadiri" } });
    await expect(submit(store, await signReservation(b, "release", "kadiri"), "2.2.2.2", "s")).rejects.toThrow(/isn't reserved by this key/);
    expect(await submit(store, await signReservation(a, "release", "kadiri"), "1.1.1.1", "s")).toMatchObject({ released: "kadiri", count: 0 });
    expect(await lookup(store, { name: "kadiri" }, "3.3.3.3", "s")).toMatchObject({ available: true });
  });
  it("rate-limits claims per network address", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < CLAIMS_PER_HOUR; i++) await submit(store, await signReservation(generatePrivateKey(), "reserve", `name_${i}x`), "9.9.9.9", "s");
    await expect(submit(store, await signReservation(generatePrivateKey(), "reserve", "onemore"), "9.9.9.9", "s")).rejects.toThrow(/Too many/);
    await expect(submit(store, await signReservation(generatePrivateKey(), "reserve", "onemore"), "8.8.8.8", "s")).resolves.toMatchObject({ reserved: "onemore" });
  });
});
