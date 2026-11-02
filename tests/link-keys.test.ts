import { describe, expect, it } from "vitest";
import { deriveLinkKeys, deriveLinkSeed } from "@/lib/link-keys";
import { announcementMatches, deriveStealthPayment, deriveStealthPrivateKey, isValidCompressedPoint } from "@/lib/stealth";
import { buildPaymentMetadata } from "@/lib/metadata";

const SIG = `0x${"ab".repeat(65)}` as const;
const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

describe("wallet-derived link keys", () => {
  it("gives the same keys for the same wallet signature and link number", async () => {
    const seed = await deriveLinkSeed(SIG, WALLET);
    expect(seed).toBe(await deriveLinkSeed(SIG, WALLET));
    const a = await deriveLinkKeys(seed, 3);
    expect(a).toEqual(await deriveLinkKeys(seed, 3));
    expect(isValidCompressedPoint(a.spendingPublicKey)).toBe(true);
    expect(isValidCompressedPoint(a.viewingPublicKey)).toBe(true);
    expect(a.stealthMetaAddress).toBe(`0x${a.spendingPublicKey.slice(2)}${a.viewingPublicKey.slice(2)}`);
  });

  it("gives every link and every wallet unrelated keys", async () => {
    const seed = await deriveLinkSeed(SIG, WALLET);
    const other = await deriveLinkSeed(SIG, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    const k0 = await deriveLinkKeys(seed, 0);
    const k1 = await deriveLinkKeys(seed, 1);
    const o0 = await deriveLinkKeys(other, 0);
    const pubs = [k0.spendingPublicKey, k0.viewingPublicKey, k1.spendingPublicKey, k1.viewingPublicKey, o0.spendingPublicKey, o0.viewingPublicKey];
    expect(new Set(pubs).size).toBe(6);
    await expect(deriveLinkKeys(seed, -1)).rejects.toThrow();
  });

  it("works with ERC-5564 payments: only the right link matches, and it can spend", async () => {
    const seed = await deriveLinkSeed(SIG, WALLET);
    const k2 = await deriveLinkKeys(seed, 2);
    const k5 = await deriveLinkKeys(seed, 5);
    const d = deriveStealthPayment(k2.stealthMetaAddress);
    const ann = {
      stealthAddress: d.stealthAddress,
      ephemeralPubKey: d.ephemeralPublicKey,
      metadata: buildPaymentMetadata({ viewTag: d.viewTag, token: "0x271c29c9d99e0dd4ae250c7dd302052355cb3db9", amount: 1n }),
    };
    expect(announcementMatches(ann, k2)).toBe(true);
    expect(announcementMatches(ann, k5)).toBe(false);
    expect(() => deriveStealthPrivateKey(d.ephemeralPublicKey, d.stealthAddress, k2)).not.toThrow();
  });
});
