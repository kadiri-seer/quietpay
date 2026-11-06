/**
 * Limits on the relayer's ETH top-ups ("gas drops").
 *
 * After a relayed withdrawal, the relayer may send a little ETH to an empty receiving address so
 * it can move the tokens. On testnet the withdrawal fee is paid in free test tokens, so the fee
 * covering the top-up (src/lib/pool/relayer.ts, relayEconomics) protects nothing on its own:
 * anyone could mint tokens, withdraw again and again to fresh addresses, and drain the relayer.
 * Every top-up therefore also has to pass all of these, in this order:
 *
 *   1. the relayer keeps at least `minBalanceWei` after the top-up (otherwise top-ups stop and the
 *      monitor records "relayer.low-balance"); withdrawals themselves keep working;
 *   2. one top-up per receiving address per `cooldownSec`;
 *   3. at most `perCallerDaily` top-ups per caller (salted IP hash) per day;
 *   4. at most `dailyMax` top-ups across all recipients per day (caps the total spent, however
 *      many addresses and callers someone uses).
 *
 * The daily total only counts requests that passed the per-address and per-caller limits, so one
 * caller's refused attempts can't use up everyone else's top-ups. Counters are taken only after
 * the withdrawal succeeded, so a failed withdrawal costs no quota.
 * Each refusal is recorded by the repeated-action monitor ("gasdrop.denied").
 */
import "server-only";
import { parseEther } from "viem";
import type { Kv } from "./guard";

export interface GasDropLimits {
  cooldownSec: number;
  perCallerDaily: number;
  dailyMax: number;
  minBalanceWei: bigint;
}

function int(v: string | undefined, fallback: number, min: number, max: number) {
  const n = Number((v ?? "").trim());
  return Number.isFinite(n) && (v ?? "").trim() !== "" ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/** From the environment (see src/lib/pool/server.ts for the full list). */
export function gasDropLimitsFromEnv(env: Record<string, string | undefined> = process.env): GasDropLimits {
  let minBalanceWei = parseEther("0.02");
  try {
    if (env.RELAYER_MIN_BALANCE_ETH?.trim()) minBalanceWei = parseEther(env.RELAYER_MIN_BALANCE_ETH.trim());
  } catch {}
  return {
    cooldownSec: int(env.RELAYER_DROP_COOLDOWN_SECONDS, 86_400, 60, 30 * 86_400),
    perCallerDaily: int(env.RELAYER_DROPS_PER_CALLER_PER_DAY, 3, 0, 100),
    dailyMax: int(env.RELAYER_DROPS_PER_DAY, 50, 0, 10_000),
    minBalanceWei,
  };
}

export type DropDecision = { amount: bigint; denied?: "low-balance" | "daily" | "caller" | "recipient" };

/**
 * Decides one top-up of `want` wei to `recipient` for `caller`, consuming quota when it passes
 * (and in the counters it reaches before refusing, which only ever makes the limits stricter).
 */
export async function decideGasDrop(
  d: { kv: Pick<Kv, "count" | "acquire">; limits: GasDropLimits; relayerBalance: bigint; watch?: (event: "gasdrop.recipient" | "gasdrop.caller" | "gasdrop.denied" | "relayer.low-balance", subject: string) => Promise<unknown> },
  p: { recipient: string; caller: string; want: bigint; nowMs?: number },
): Promise<DropDecision> {
  if (p.want <= 0n) return { amount: 0n };
  const deny = async (denied: NonNullable<DropDecision["denied"]>) => {
    await d.watch?.(denied === "low-balance" ? "relayer.low-balance" : "gasdrop.denied", denied === "low-balance" ? "relayer" : denied);
    return { amount: 0n, denied };
  };
  if (d.relayerBalance < d.limits.minBalanceWei + p.want) return deny("low-balance");
  const day = Math.floor((p.nowMs ?? Date.now()) / 86_400_000);
  if (!(await d.kv.acquire(`gasdrop:to:${p.recipient.toLowerCase()}`, d.limits.cooldownSec))) return deny("recipient");
  if ((await d.kv.count(`gasdrop:caller:${p.caller}:${day}`, 86_400)) > d.limits.perCallerDaily) return deny("caller");
  if ((await d.kv.count(`gasdrop:day:${day}`, 86_400)) > d.limits.dailyMax) return deny("daily");
  await d.watch?.("gasdrop.recipient", p.recipient.toLowerCase());
  await d.watch?.("gasdrop.caller", p.caller);
  return { amount: p.want };
}
