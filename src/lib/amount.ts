/**
 * Strict decimal <-> base-unit conversion using bigint only. No floating point anywhere.
 */

const DECIMAL_RE = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
const MAX_INPUT_LENGTH = 40;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

/**
 * Parses a human decimal string (e.g. "12.50") into base units.
 * Rejects signs, exponents, separators, whitespace inside the number, empty input,
 * and more fractional digits than the token supports (no silent rounding).
 */
export function parseAmount(input: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new AmountError("Unsupported token decimals.");
  }
  const value = input.trim();
  if (value.length === 0) throw new AmountError("Enter an amount.");
  if (value.length > MAX_INPUT_LENGTH) throw new AmountError("Amount is too long.");
  const match = DECIMAL_RE.exec(value);
  if (!match) throw new AmountError("Use digits and an optional decimal point, like 25 or 25.50.");
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) {
    throw new AmountError(`Use at most ${decimals} decimal places.`);
  }
  const scale = 10n ** BigInt(decimals);
  const frac = fraction.padEnd(decimals, "0");
  return BigInt(whole) * scale + (decimals > 0 ? BigInt(frac || "0") : 0n);
}

/** Formats base units as a decimal string, trimming trailing zeros. Optional digit grouping. */
export function formatAmount(value: bigint, decimals: number, opts: { group?: boolean; minFraction?: number } = {}): string {
  if (value < 0n) throw new AmountError("Negative amounts are not supported.");
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  let fraction = decimals > 0 ? (value % scale).toString().padStart(decimals, "0") : "";
  fraction = fraction.replace(/0+$/, "");
  const minFraction = Math.min(opts.minFraction ?? 0, decimals);
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, "0");
  const wholeStr = opts.group ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole.toString();
  return fraction ? `${wholeStr}.${fraction}` : wholeStr;
}

export interface AmountLimits {
  min: bigint;
  max: bigint;
}

/** Converts human-unit limits to base units for a token with the given decimals. */
export function limitsFor(decimals: number, limits: { min: string; max: string }): AmountLimits {
  const min = parseAmount(limits.min, decimals);
  const max = parseAmount(limits.max, decimals);
  if (min <= 0n || max < min) throw new AmountError("Invalid payment limits configuration.");
  return { min, max };
}

export function checkLimits(amount: bigint, limits: AmountLimits, decimals: number, symbol: string): string | null {
  if (amount <= 0n) return "Amount must be greater than zero.";
  if (amount < limits.min) return `Minimum is ${formatAmount(limits.min, decimals)} ${symbol}.`;
  if (amount > limits.max) return `Maximum is ${formatAmount(limits.max, decimals, { group: true })} ${symbol}.`;
  return null;
}
