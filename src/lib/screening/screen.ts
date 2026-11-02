/**
 * Deposit screening for the pool's approver.
 *
 * A QuietPay deposit comes from a one-time address that no list will ever contain, so checking
 * the depositor alone would pass everything. What matters is where its money came from: every
 * address that sent the pool's token to the depositor before the deposit (for a QuietPay payment,
 * the payer). The depositor and all of those senders are checked against the sanctions list.
 *
 * This is list screening only: it catches money sent directly from a sanctioned address, not
 * money that passed through other wallets first. A risk-scoring provider (TRM, Elliptic,
 * Chainalysis) can be added as another check in `screenDeposit` for that.
 */
import { erc20Abi } from "@/config/contracts";
import type { Address, PublicClient } from "viem";
import type { PoolDeposit } from "@/lib/pool/state";
import type { SanctionsList } from "./sanctions";

export type Verdict = { ok: true; checked: number } | { ok: false; flagged: Address; checked: number };

/**
 * Every address that sent `token` to `holder` in [fromBlock, toBlock]. Asks for the whole range
 * first (most RPCs allow that for one address and topic) and splits it only if the RPC refuses.
 */
export async function tokenSendersTo(
  client: PublicClient,
  p: { token: Address; holder: Address; fromBlock: bigint; toBlock: bigint; minChunk?: bigint },
): Promise<Address[]> {
  const out = new Set<Address>();
  const minChunk = p.minChunk ?? 1_000n;
  const ranges: [bigint, bigint][] = [[p.fromBlock, p.toBlock]];
  while (ranges.length) {
    const [from, to] = ranges.shift()!;
    if (from > to) continue;
    try {
      const logs = await client.getContractEvents({ address: p.token, abi: erc20Abi, eventName: "Transfer", args: { to: p.holder }, fromBlock: from, toBlock: to, strict: true });
      for (const l of logs) out.add(l.args.from);
    } catch (e) {
      if (to - from < minChunk) throw e;
      const mid = from + (to - from) / 2n;
      ranges.unshift([from, mid], [mid + 1n, to]);
    }
  }
  return [...out];
}

/** Checks one deposit: its depositor and everyone who sent it the token before the deposit. */
export async function screenDeposit(
  client: PublicClient,
  p: { deposit: PoolDeposit; token: Address; list: SanctionsList; fromBlock: bigint; ignore: Address[] },
): Promise<Verdict> {
  const ignore = new Set(p.ignore.map((a) => a.toLowerCase()));
  ignore.add("0x0000000000000000000000000000000000000000"); // mints
  const senders = await tokenSendersTo(client, { token: p.token, holder: p.deposit.depositor, fromBlock: p.fromBlock, toBlock: p.deposit.blockNumber });
  const check = [p.deposit.depositor, ...senders].filter((a) => !ignore.has(a.toLowerCase()));
  const hit = check.find((a) => p.list.has(a));
  return hit ? { ok: false, flagged: hit, checked: check.length } : { ok: true, checked: check.length };
}
