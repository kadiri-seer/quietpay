import { describe, expect, it } from "vitest";
import { getAddress, keccak256 } from "viem";
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
    kind: "fixed",
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
    expect(code).toHaveLength(178);
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
    bytes[31] ^= 0x01; // flip a bit in the amount
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
    bytes[0] = 9;
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

/** Builds a legacy v1 link by hand (fixed amount, no flags byte). */
function encodeV1(r: PaymentRequestLink): string {
  const buf = new Uint8Array(132);
  const put = (off: number, size: number, v: bigint) => {
    for (let i = size - 1; i >= 0; i--) {
      buf[off + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  };
  buf[0] = 1;
  put(1, 4, BigInt(r.chainId));
  buf.set(Buffer.from(r.token.slice(2), "hex"), 5);
  put(25, 16, r.amount);
  put(41, 5, BigInt(r.expiresAt));
  buf.set(Buffer.from(r.requestId.slice(2), "hex"), 46);
  buf.set(Buffer.from(r.stealthMetaAddress.slice(2), "hex"), 62);
  buf.set(Buffer.from(keccak256(buf.subarray(0, 128)).slice(2, 10), "hex"), 128);
  return toBase64Url(buf);
}

describe("link kinds and backward compatibility", () => {
  const networks = testNetworks();

  it("still accepts v1 links created before open links existed", () => {
    const r = sample();
    const code = encodeV1(r);
    expect(code).toHaveLength(176);
    const { request } = validatePaymentLink(code, { nowSeconds: NOW, networks });
    expect(request).toMatchObject({ version: 1, kind: "fixed", amount: r.amount, expiresAt: r.expiresAt });
  });

  it("round-trips an open (any amount) link that never expires", () => {
    const code = encodePaymentLink(sample({ kind: "open", amount: 0n, expiresAt: 0 }));
    const back = decodePaymentLink(code);
    expect(back).toMatchObject({ version: 2, kind: "open", amount: 0n, expiresAt: 0 });
    expect(validatePaymentLink(code, { nowSeconds: NOW, networks }).request.kind).toBe("open");
  });

  it("allows open links to expire up to 30 days out, fixed links only 7", () => {
    const open30 = encodePaymentLink(sample({ kind: "open", amount: 0n, expiresAt: NOW + 30 * 86400 }));
    expect(() => validatePaymentLink(open30, { nowSeconds: NOW, networks })).not.toThrow();
    const fixed30 = encodePaymentLink(sample({ expiresAt: NOW + 30 * 86400 }));
    expect(() => validatePaymentLink(fixed30, { nowSeconds: NOW, networks })).toThrow(/further out/);
    const openExpired = encodePaymentLink(sample({ kind: "open", amount: 0n, expiresAt: NOW - 1 }));
    expect(() => validatePaymentLink(openExpired, { nowSeconds: NOW, networks })).toThrow(/expired/);
  });

  it("rejects inconsistent kinds", () => {
    expect(() => encodePaymentLink(sample({ kind: "open", amount: 5n }))).toThrow(LinkError);
    expect(() => encodePaymentLink(sample({ kind: "fixed", expiresAt: 0 }))).toThrow(LinkError);
  });

  it("rejects unknown flag bits", () => {
    const bytes = fromBase64Url(encodePaymentLink(sample()));
    bytes[1] = 0x80;
    bytes.set(Buffer.from(keccak256(bytes.subarray(0, 129)).slice(2, 10), "hex"), 129);
    expect(() => decodePaymentLink(toBase64Url(bytes))).toThrow(/doesn't support/);
  });
});

describe("links that pay into the shielded pool", () => {
  const lock = { precommitment: 123456789012345678901234567890n, refund: getAddress("0x1111111111111111111111111111111111111111") };

  it("round-trips the recipient's pool lock in a one-time link", () => {
    const req = sample({ poolLock: lock });
    const code = encodePaymentLink(req);
    expect(code.length).toBeLessThan(260);
    const back = decodePaymentLink(code);
    expect(back.poolLock).toEqual(lock);
    expect(back.amount).toBe(req.amount);
    // Links without a lock are unchanged.
    expect(decodePaymentLink(encodePaymentLink(sample())).poolLock).toBeUndefined();
  });

  it("refuses a lock on a reusable link, and out-of-range locks", () => {
    expect(() => encodePaymentLink(sample({ kind: "open", amount: 0n, expiresAt: 0, poolLock: lock }))).toThrow(LinkError);
    expect(() => encodePaymentLink(sample({ poolLock: { ...lock, precommitment: 0n } }))).toThrow(LinkError);
    expect(() =>
      encodePaymentLink(sample({ poolLock: { ...lock, precommitment: 21888242871839275222246405745257275088548364400416034343698204186575808495617n } })),
    ).toThrow(LinkError);
  });

  it("detects a swapped lock, a dropped lock and a forged flag", () => {
    const bytes = fromBase64Url(encodePaymentLink(sample({ poolLock: lock })));
    const swapped = bytes.slice();
    swapped[170] ^= 0x01; // the refund address
    expect(() => decodePaymentLink(toBase64Url(swapped))).toThrow(/checksum/);
    // Cutting the lock off leaves a link whose length doesn't match its flag.
    expect(() => decodePaymentLink(toBase64Url(bytes.slice(0, 133)))).toThrow(/incomplete/);
    // Setting the pool flag on an ordinary link doesn't conjure a lock.
    const plain = fromBase64Url(encodePaymentLink(sample()));
    plain[1] |= 0x02;
    expect(() => decodePaymentLink(toBase64Url(plain))).toThrow(/incomplete/);
    // Unknown flags are refused.
    const unknown = fromBase64Url(encodePaymentLink(sample()));
    unknown[1] |= 0x04;
    expect(() => decodePaymentLink(toBase64Url(unknown))).toThrow(/doesn't support/);
  });
});
