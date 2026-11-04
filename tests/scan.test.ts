import { describe, expect, it } from "vitest";
import { interpretScan } from "@/lib/scan";
import { encodePaymentLink } from "@/lib/link";
import { createRequestKeys } from "@/lib/stealth";
import { TEST_TOKEN } from "./helpers";

const HOST = "www.quietpay.sbs";

describe("reading QR codes", () => {
  it("sends to usernames, personal links and wallet addresses", () => {
    expect(interpretScan("https://www.quietpay.sbs/pay#@Kadiri", HOST)).toEqual({ kind: "send", to: "@kadiri" });
    expect(interpretScan("https://quietpay.sbs/pay#to=0x70997970c51812dc3a010c7d01b50e0d17dc79c8", HOST)).toEqual({ kind: "send", to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
    expect(interpretScan("@alice", HOST)).toEqual({ kind: "send", to: "@alice" });
    expect(interpretScan("0x70997970c51812dc3a010c7d01b50e0d17dc79c8", HOST)).toMatchObject({ kind: "send" });
    expect(interpretScan("ethereum:0x70997970c51812dc3a010c7d01b50e0d17dc79c8@46630", HOST)).toMatchObject({ kind: "send" });
  });

  it("opens payment requests on the Pay page", () => {
    const code = encodePaymentLink({ kind: "fixed", chainId: 46630, token: TEST_TOKEN, amount: 5_000_000n, expiresAt: 2_000_000_000, requestId: "0x0123456789abcdef0123456789abcdef", stealthMetaAddress: createRequestKeys().stealthMetaAddress });
    expect(interpretScan(`https://www.quietpay.sbs/pay#${code}`, HOST)).toEqual({ kind: "pay", code });
    expect(interpretScan(`http://localhost:3000/pay#${code}`, "localhost:3000")).toEqual({ kind: "pay", code });
  });

  it("refuses other websites and anything that isn't a QuietPay code", () => {
    expect(interpretScan("https://quietpay-sbs.example/pay#@kadiri", HOST)).toMatchObject({ kind: "error", message: /not QuietPay/ });
    expect(interpretScan("http://www.quietpay.sbs/pay#@kadiri", HOST)).toMatchObject({ kind: "error" });
    expect(interpretScan("https://www.quietpay.sbs/security", HOST)).toMatchObject({ kind: "error" });
    expect(interpretScan("hello", HOST)).toMatchObject({ kind: "error" });
    expect(interpretScan("https://www.quietpay.sbs/pay#garbage", HOST)).toMatchObject({ kind: "error" });
  });
});
