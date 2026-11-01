import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import {
  announcementMatches,
  createRequestKeys,
  deriveStealthPayment,
  deriveStealthPrivateKey,
  isValidCompressedPoint,
} from "@/lib/stealth";
import { buildPaymentMetadata, parsePaymentMetadata } from "@/lib/metadata";
import { TEST_TOKEN } from "./helpers";

const REQ_ID = "0x00112233445566778899aabbccddeeff" as Hex;

describe("stealth derivation (ERC-5564 scheme 1)", () => {
  it("creates independent keys per request", () => {
    const a = createRequestKeys();
    const b = createRequestKeys();
    expect(a.spendingPrivateKey).not.toBe(b.spendingPrivateKey);
    expect(a.viewingPrivateKey).not.toBe(a.spendingPrivateKey);
    expect(a.stealthMetaAddress).toHaveLength(2 + 132);
    expect(isValidCompressedPoint(a.spendingPublicKey)).toBe(true);
    expect(isValidCompressedPoint(a.viewingPublicKey)).toBe(true);
  });

  it("payer derives a fresh address each time; recipient matches and controls it", () => {
    const keys = createRequestKeys();
    const d1 = deriveStealthPayment(keys.stealthMetaAddress);
    const d2 = deriveStealthPayment(keys.stealthMetaAddress);
    expect(d1.stealthAddress).not.toBe(d2.stealthAddress);

    for (const d of [d1, d2]) {
      const metadata = buildPaymentMetadata({ viewTag: d.viewTag, token: TEST_TOKEN, amount: 1n, requestId: REQ_ID });
      const ann = { stealthAddress: d.stealthAddress, ephemeralPubKey: d.ephemeralPublicKey, metadata };
      expect(announcementMatches(ann, keys)).toBe(true);
      const sk = deriveStealthPrivateKey(d.ephemeralPublicKey, d.stealthAddress, keys);
      expect(getAddress(privateKeyToAddress(sk))).toBe(d.stealthAddress);
    }
  });

  it("does not match announcements for other recipients", () => {
    const mine = createRequestKeys();
    const theirs = createRequestKeys();
    const d = deriveStealthPayment(theirs.stealthMetaAddress);
    const metadata = buildPaymentMetadata({ viewTag: d.viewTag, token: TEST_TOKEN, amount: 1n, requestId: REQ_ID });
    expect(announcementMatches({ stealthAddress: d.stealthAddress, ephemeralPubKey: d.ephemeralPublicKey, metadata }, mine)).toBe(false);
    expect(() => deriveStealthPrivateKey(d.ephemeralPublicKey, d.stealthAddress, mine)).toThrow(/does not control/);
  });

  it("rejects spoofed announcements (right view tag, wrong address) and junk", () => {
    const keys = createRequestKeys();
    const d = deriveStealthPayment(keys.stealthMetaAddress);
    const metadata = buildPaymentMetadata({ viewTag: d.viewTag, token: TEST_TOKEN, amount: 1n, requestId: REQ_ID });
    expect(
      announcementMatches({ stealthAddress: "0x4444444444444444444444444444444444444444", ephemeralPubKey: d.ephemeralPublicKey, metadata }, keys),
    ).toBe(false);
    expect(announcementMatches({ stealthAddress: d.stealthAddress, ephemeralPubKey: "0x1234", metadata }, keys)).toBe(false);
    expect(announcementMatches({ stealthAddress: d.stealthAddress, ephemeralPubKey: d.ephemeralPublicKey, metadata: "0x" }, keys)).toBe(false);
  });
});

describe("announcement metadata", () => {
  it("follows ERC-5564's recommended prefix and carries the request ID", () => {
    const m = buildPaymentMetadata({ viewTag: "0xAB", token: TEST_TOKEN, amount: 25_000_000n, requestId: REQ_ID });
    expect(m.slice(0, 4)).toBe("0xab");
    expect(m.slice(4, 12)).toBe("a9059cbb");
    const p = parsePaymentMetadata(m);
    expect(p).toEqual({ viewTag: "0xab", selector: "0xa9059cbb", token: TEST_TOKEN, amount: 25_000_000n, requestId: REQ_ID });
  });
  it("omits the request ID for reusable links (standard 57-byte metadata)", () => {
    const m = buildPaymentMetadata({ viewTag: "0xab", token: TEST_TOKEN, amount: 1n });
    expect((m.length - 2) / 2).toBe(57);
    expect(parsePaymentMetadata(m).requestId).toBeNull();
    expect(parsePaymentMetadata(m).amount).toBe(1n);
  });
  it("parses foreign/short metadata without throwing", () => {
    expect(parsePaymentMetadata("0x12").requestId).toBeNull();
    expect(parsePaymentMetadata(`0x12${"00".repeat(56)}`).token).toBeNull();
  });
});
