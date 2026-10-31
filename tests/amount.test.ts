import { describe, expect, it } from "vitest";
import { AmountError, checkLimits, formatAmount, limitsFor, parseAmount } from "@/lib/amount";

describe("parseAmount", () => {
  it("parses whole and fractional amounts into base units", () => {
    expect(parseAmount("25", 6)).toBe(25_000_000n);
    expect(parseAmount("25.5", 6)).toBe(25_500_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount(" 1.10 ", 6)).toBe(1_100_000n);
    expect(parseAmount("7", 0)).toBe(7n);
  });

  it("handles 18-decimal tokens without precision loss", () => {
    expect(parseAmount("123456789.123456789123456789", 18)).toBe(123456789123456789123456789n);
  });

  it.each(["", "-1", "+1", "1e6", "1,000", "01", "1.", ".5", "1.2.3", "abc", "1 000", "0x10", "Infinity", "NaN"])(
    "rejects malformed input %j",
    (v) => {
      expect(() => parseAmount(v, 6)).toThrow(AmountError);
    },
  );

  it("rejects more decimals than the token supports instead of rounding", () => {
    expect(() => parseAmount("1.0000001", 6)).toThrow(/at most 6/);
  });

  it("rejects unsupported decimals", () => {
    expect(() => parseAmount("1", 37)).toThrow(AmountError);
    expect(() => parseAmount("1", -1)).toThrow(AmountError);
  });
});

describe("formatAmount", () => {
  it("round-trips with parseAmount", () => {
    for (const v of ["0", "1", "0.5", "1234.000001", "99999999.99"]) {
      expect(formatAmount(parseAmount(v, 6), 6)).toBe(v);
    }
  });
  it("groups digits and pads fractions on request", () => {
    expect(formatAmount(1_234_567_500_000n, 6, { group: true, minFraction: 2 })).toBe("1,234,567.50");
  });
});

describe("limits", () => {
  const limits = limitsFor(6, { min: "0.01", max: "10000" });
  it("converts human limits with onchain decimals", () => {
    expect(limits).toEqual({ min: 10_000n, max: 10_000_000_000n });
  });
  it("enforces min and max", () => {
    expect(checkLimits(9_999n, limits, 6, "USDG")).toMatch(/Minimum/);
    expect(checkLimits(10_000_000_001n, limits, 6, "USDG")).toMatch(/Maximum/);
    expect(checkLimits(0n, limits, 6, "USDG")).toMatch(/greater than zero/);
    expect(checkLimits(5_000_000n, limits, 6, "USDG")).toBeNull();
  });
  it("rejects inverted configuration", () => {
    expect(() => limitsFor(6, { min: "10", max: "1" })).toThrow();
  });
});
