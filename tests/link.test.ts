import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  LINK_VERSION,
  LinkError,
  buildPayUrl,
  decodePaymentLink,
  encodePaymentLink,
  extractLinkCode,
  fromBase64Url,
  toBase64Url,
  validatePaymentLink,
  type PaymentRequestLink,
} from "@/lib/link";
import { createRequestKeys } from "@/lib/stealth";
import { ROBINHOOD_MAINNET_ID, ROBINHOOD_TESTNET_ID } from "@/config/networks";
import { TEST_TOKEN, testNetworks } from "./helpers";

const NOW = 1_800_000_000;

function sample(over: Partial<PaymentRequestLink> = {}): PaymentRequestLink {
  return {
    version: LINK_VERSION,
    chainId: ROBINHOOD_TESTNET_ID,
    token: TEST_TOKEN,
    amount: 25_500_000n,
    expiresAt: NOW + 3600,
    requestId: "0x0123456789abcdef0123456789abcdef",
    stealthMetaAddress: createRequestKeys().stealthMetaAddress,
    ...over,
  };
}

describe("payment link encoding", () => {
  it("round-trips all fields", () => {
    const req = sample();
    const code = encodePaymentLink(req);
    expect(code).toHaveLength(176);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = decodePaymentLink(code);
    expect(back).toEqual({ ...req, token: getAddress(req.token), stealthMetaAddress: req.stealthMetaAddress.toLowerCase() });
  });

  it("contains only public fields (no private keys)", () => {
    const keys = createRequestKeys();
    const code = encodePaymentLink(sample({ stealthMetaAddress: keys.stealthMetaAddress }));
    const raw = Buffer.from(fromBase64Url(code)).toString("hex");
    expect(raw).not.toContain(keys.spendingPrivateKey.slice(2));
    expect(raw).not.toContain(keys.viewingPrivateKey.slice(2));
    expect(raw).toContain(keys.stealthMetaAddress.slice(2).toLowerCase());
  });

  it("detects tampering via checksum", () => {
    const bytes = fromBase64Url(encodePaymentLink(sample()));
    bytes[30] ^= 0x01; // flip a bit in the amount
    expect(() => decodePaymentLink(toBase64Url(bytes))).toThrow(/checksum/);
  });

  it("rejects truncated, oversized and non-base64url links", () => {
    const code = encodePaymentLink(sample());
    expect(() => decodePaymentLink(code.slice(0, 100))).toThrow(LinkError);
    expect(() => decodePaymentLink(code + "AAAA")).toThrow(LinkError);
    expect(() => decodePaymentLink("not a link!")).toThrow(LinkError);
    expect(() => decodePaymentLink("")).toThrow(LinkError);
  });

  it("rejects unknown versions", () => {
    const bytes = fromBase64Url(encodePaymentLink(sample()));
    bytes[0] = 2;
    expect(() => decodePaymentLink(toBase64Url(bytes))).toThrow(/version/);
  });

  it("refuses to encode out-of-range amounts", () => {
    expect(() => encodePaymentLink(sample({ amount: 0n }))).toThrow(LinkError);
    expect(() => encodePaymentLink(sample({ amount: 1n << 128n }))).toThrow(LinkError);
  });

  it("builds and extracts fragment URLs", () => {
    const code = encodePaymentLink(sample());
    const url = buildPayUrl("https://quietpay.example/", code);
    expect(url).toBe(`https://quietpay.example/pay#${code}`);
    expect(extractLinkCode(url)).toBe(code);
    expect(extractLinkCode(`#${code}`)).toBe(code);
    expect(extractLinkCode(code)).toBe(code);
  });
});

describe("payment link policy validation", () => {
  const networks = testNetworks();

  it("accepts a valid testnet link", () => {
    const { network, request } = validatePaymentLink(encodePaymentLink(sample()), { nowSeconds: NOW, networks });
    expect(network.key).toBe("testnet");
    expect(request.amount).toBe(25_500_000n);
  });

  it("rejects links for a non-allowlisted token", () => {
    const code = encodePaymentLink(sample({ token: "0x2222222222222222222222222222222222222222" }));
    expect(() => validatePaymentLink(code, { nowSeconds: NOW, networks })).toThrow(/does not accept/);
  });

  it("rejects mainnet links while mainnet is disabled", () => {
    const code = encodePaymentLink(sample({ chainId: ROBINHOOD_MAINNET_ID }));
    expect(() => validatePaymentLink(code, { nowSeconds: NOW, networks })).toThrow(/disabled/);
  });

  it("rejects unknown chains", () => {
    const code = encodePaymentLink(sample({ chainId: 1 }));
    expect(() => validatePaymentLink(code, { nowSeconds: NOW, networks })).toThrow(/unsupported network/);
  });

  it("rejects expired links and implausibly long expiries", () => {
    expect(() => validatePaymentLink(encodePaymentLink(sample({ expiresAt: NOW - 1 })), { nowSeconds: NOW, networks })).toThrow(/expired/);
    expect(() =>
      validatePaymentLink(encodePaymentLink(sample({ expiresAt: NOW + 30 * 86400 })), { nowSeconds: NOW, networks }),
    ).toThrow(/further out/);
  });

  it("rejects invalid meta-address points and zero request IDs", () => {
    const bad = `0x02${"ff".repeat(32)}03${"ff".repeat(32)}` as const; // x >= p: not on curve
    expect(() => validatePaymentLink(encodePaymentLink(sample({ stealthMetaAddress: bad })), { nowSeconds: NOW, networks })).toThrow(
      /receiving keys/,
    );
    expect(() =>
      validatePaymentLink(encodePaymentLink(sample({ requestId: `0x${"00".repeat(16)}` })), { nowSeconds: NOW, networks }),
    ).toThrow(/request ID/);
  });

  it("rejects links when no testnet token is configured", () => {
    const code = encodePaymentLink(sample());
    expect(() => validatePaymentLink(code, { nowSeconds: NOW, networks: testNetworks({ token: null }) })).toThrow(/No payment token/);
  });
});
