/**
 * Relayer and approver logic. Runs on the server (src/app/api/...) with a testnet hot key, and
 * in tests against a local node.
 *
 * The relayer can only submit what the user proved: the proof commits to the recipient, the fee
 * address and the fee, so a relayer cannot change where funds go. Its job is to pay gas so the
 * receiving address can start empty and unconnected to anything.
 *
 * The approver (ASP postman) publishes approval roots by a fixed public rule (every deposit at
 * least `delaySeconds` old), so anyone can recompute and check them. Calling it is idempotent:
 * it only sends a transaction when the approved set would grow.
 */
import { decodeAbiParameters, getAddress, parseEventLogs, type Address, type Hash, type PublicClient, type WalletClient } from "viem";
import { z } from "zod";
import { Entrypoint } from "@/config/pool-contracts.generated";
import { findBlockAtOrBefore, waitForConfirmedReceipt } from "@/lib/chain";
import type { NetworkConfig } from "@/config/networks";
import { treeRoot } from "./crypto";
import { relayArgs, type PoolInfo, type SerializedWithdrawal } from "./actions";
import { aspLabels, encodeAspDescriptor, parseAspDescriptor, type PoolDeposit, type PoolEvents } from "./state";
import type { Verdict } from "@/lib/screening/screen";
import { decodeTransferData, poolRouterAbi, transferArgs } from "./receive";

const uint = z.string().regex(/^\d{1,78}$/);
export const relayBodySchema = z.object({
  withdrawal: z.object({ processooor: z.string().regex(/^0x[0-9a-fA-F]{40}$/), data: z.string().regex(/^0x[0-9a-fA-F]*$/).max(1000) }),
  proof: z.object({
    pA: z.array(uint).length(2),
    pB: z.array(z.array(uint).length(2)).length(2),
    pC: z.array(uint).length(2),
    pubSignals: z.array(uint).length(8),
  }),
  scope: uint,
});

export interface RelayerPolicy {
  feeRecipient: Address;
  feeBPS: bigint;
  /** Most ETH sent to the recipient after a withdrawal so it can move the tokens. 0 disables. */
  gasDrop: bigint;
  /**
   * Token base units worth 1 ETH, used to check that a withdrawal's fee pays for the relay gas
   * and the gas top-up. Without this check, someone could make many tiny withdrawals to addresses
   * they control and collect the relayer's ETH. 0 turns the check off (tests only).
   */
  tokenUnitsPerEth: bigint;
}

/** Gas a relayed withdrawal uses, with headroom. Only for quoting the minimum in advance. */
export const RELAY_GAS_QUOTE = 750_000n;
const TRANSFER_GAS = 21_000n;
const WEI = 10n ** 18n;

/**
 * What a withdrawal of `amount` pays the relayer, in ETH terms, and what that allows:
 * - ok: the fee covers the relay transaction's gas;
 * - drop: the most ETH the relayer may top up the recipient with, so the fee covers the top-up
 *   and its transfer too (never above `wantDrop`);
 * - minWithdrawal: the smallest amount whose fee covers the relay gas.
 */
export function relayEconomics(p: { amount: bigint; feeBPS: bigint; tokenUnitsPerEth: bigint; relayCost: bigint; gasPrice: bigint; wantDrop: bigint }) {
  if (p.tokenUnitsPerEth === 0n) return { ok: true, drop: p.wantDrop, minWithdrawal: 0n };
  const feeWei = (((p.amount * p.feeBPS) / 10_000n) * WEI) / p.tokenUnitsPerEth;
  const surplus = feeWei - p.relayCost;
  let minWithdrawal = 0n;
  if (p.feeBPS > 0n) {
    const needFee = (p.relayCost * p.tokenUnitsPerEth + WEI - 1n) / WEI; // token units, rounded up
    minWithdrawal = (needFee * 10_000n + p.feeBPS - 1n) / p.feeBPS;
    while (((minWithdrawal * p.feeBPS) / 10_000n) * WEI / p.tokenUnitsPerEth < p.relayCost) minWithdrawal++;
  }
  if (p.feeBPS === 0n || surplus < 0n) return { ok: false, drop: 0n, minWithdrawal };
  const room = surplus - TRANSFER_GAS * p.gasPrice;
  const drop = room <= 0n ? 0n : room < p.wantDrop ? room : p.wantDrop;
  return { ok: true, drop, minWithdrawal };
}

/** The smallest withdrawal this relayer takes at today's gas price (an estimate; the relay call decides). */
export async function quoteMinWithdrawal(client: PublicClient, policy: RelayerPolicy): Promise<bigint> {
  const gasPrice = await client.getGasPrice();
  return relayEconomics({ amount: 0n, feeBPS: policy.feeBPS, tokenUnitsPerEth: policy.tokenUnitsPerEth, relayCost: RELAY_GAS_QUOTE * gasPrice, gasPrice, wantDrop: 0n }).minWithdrawal;
}

export class RelayRejected extends Error {
  constructor(
    message: string,
    /** Set when the amount is below what the relayer can take (token base units). */
    public minWithdrawal?: bigint,
  ) {
    super(message);
    this.name = "RelayRejected";
  }
}

/**
 * Server-side guards for the relayer (src/lib/server/guard.ts). Tests run without them.
 * - claim: reserves a withdrawal (by its nullifier) while it is being submitted, so the same proof
 *   sent many times at once is submitted once instead of costing gas for every failed copy;
 * - send: runs one transaction send at a time across server instances, so they don't collide on
 *   the relayer's nonce.
 */
export interface RelayGuard {
  claim(nullifierHash: bigint): Promise<(() => Promise<void>) | null>;
  send<T>(fn: () => Promise<T>): Promise<T>;
}

const noGuard: RelayGuard = { claim: async () => async () => undefined, send: (fn) => fn() };

export function decodeRelayData(data: `0x${string}`) {
  const [d] = decodeAbiParameters(
    [{ type: "tuple", components: [{ name: "recipient", type: "address" }, { name: "feeRecipient", type: "address" }, { name: "relayFeeBPS", type: "uint256" }] }],
    data,
  );
  return d;
}

export async function relayWithdrawal(
  client: PublicClient,
  wallet: WalletClient,
  network: NetworkConfig,
  info: PoolInfo,
  policy: RelayerPolicy,
  raw: unknown,
  guard: RelayGuard = noGuard,
): Promise<{ hash: Hash; recipient: Address; amount: bigint; fee: bigint; gasDropHash: Hash | null }> {
  const parsed = relayBodySchema.safeParse(raw);
  if (!parsed.success) throw new RelayRejected("Malformed withdrawal request.");
  const body = parsed.data as SerializedWithdrawal;
  if (getAddress(body.withdrawal.processooor) !== getAddress(info.entrypoint)) throw new RelayRejected("Wrong processor.");
  if (BigInt(body.scope) !== info.scope) throw new RelayRejected("Wrong pool.");
  let data: ReturnType<typeof decodeRelayData>;
  try {
    data = decodeRelayData(body.withdrawal.data as `0x${string}`);
  } catch {
    throw new RelayRejected("Malformed relay data.");
  }
  if (getAddress(data.feeRecipient) !== getAddress(policy.feeRecipient)) throw new RelayRejected("Fee must go to this relayer.");
  if (data.relayFeeBPS !== policy.feeBPS) throw new RelayRejected("Fee does not match this relayer's fee.");
  const args = relayArgs(body);
  const amount = args[1].pubSignals[2];
  if (amount === 0n) throw new RelayRejected("Nothing to withdraw.");

  // One submission per withdrawal at a time. The claim is released if this attempt fails, and
  // kept (until it expires) once the withdrawal is onchain, when the nullifier is spent anyway.
  const release = await guard.claim(args[1].pubSignals[1]);
  if (!release) throw new RelayRejected("This withdrawal is already being submitted. Wait a moment and check again.");
  let submitted = false;
  try {
    const out = await submitRelay();
    submitted = true;
    return out;
  } finally {
    if (!submitted) await release().catch(() => undefined);
  }

  async function submitRelay() {

  // Simulation runs the full onchain checks (proof, roots, nullifier) at no cost.
  try {
    await client.simulateContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "relay", args, account: wallet.account! });
  } catch (e) {
    const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
    throw new RelayRejected(/IncorrectASPRoot/.test(msg) ? "The approval list changed. Generate the proof again." : /NullifierAlreadySpent/.test(msg) ? "This note was already spent." : `The pool rejected this withdrawal: ${msg.split("\n")[0]}`);
  }
  // The fee must pay for this transaction (and any gas top-up), or the relayer is being drained.
  const [gas, gasPrice] = await Promise.all([
    client.estimateContractGas({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "relay", args, account: wallet.account! }),
    client.getGasPrice(),
  ]);
  const bal = policy.gasDrop > 0n ? await client.getBalance({ address: data.recipient }) : 0n;
  const econ = relayEconomics({
    amount,
    feeBPS: policy.feeBPS,
    tokenUnitsPerEth: policy.tokenUnitsPerEth,
    relayCost: ((gas * 6n) / 5n) * gasPrice,
    gasPrice,
    wantDrop: bal < policy.gasDrop ? policy.gasDrop - bal : 0n,
  });
  if (!econ.ok) {
    throw new RelayRejected("This amount is too small to send through the relayer right now: its fee wouldn't cover the network fee.", econ.minWithdrawal);
  }

  const hash = await guard.send(() =>
    wallet.writeContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "relay", args, account: wallet.account!, chain: network.chain, gas: (gas * 6n) / 5n }),
  );
  const receipt = await waitForConfirmedReceipt(client, hash, { confirmations: network.confirmations });
  if (receipt.status !== "success") throw new Error("The withdrawal transaction reverted.");
  const relayed = parseEventLogs({ abi: Entrypoint.abi, logs: receipt.logs, eventName: "WithdrawalRelayed" })[0];
  const fee = relayed ? (relayed.args as { _feeAmount: bigint })._feeAmount : 0n;

  let gasDropHash: Hash | null = null;
  if (econ.drop > 0n) {
    gasDropHash = await guard.send(() => wallet.sendTransaction({ to: data.recipient, value: econ.drop, account: wallet.account!, chain: network.chain }));
    await waitForConfirmedReceipt(client, gasDropHash, { confirmations: network.confirmations });
  }
  return { hash: receipt.transactionHash, recipient: getAddress(data.recipient), amount, fee, gasDropHash };
  }
}

/**
 * Screening hooks for the approver (see src/lib/screening and the approvals route). Without them
 * every deposit old enough is approved (testnet).
 */
export interface ApprovalScreening {
  /** Every deposit label excluded so far. */
  excluded(): Promise<bigint[]>;
  /** The deposit's verdict (cached after the first check). Throws if it can't be checked now. */
  verdict(deposit: PoolDeposit): Promise<Verdict>;
  /** Saves this version of the exclusion list where clients can fetch it; returns its id. */
  publish(labels: bigint[]): Promise<string>;
}

/**
 * Publishes a new approval root if deposits older than `delaySeconds` are not yet approved.
 * Returns the transaction hash, or null when the approved set is already current.
 *
 * With screening, each deposit newer than the last approval is checked first. A failed check
 * excludes it (it can still exit to its depositor); a check that can't run stops the approval just
 * before that deposit, so nothing is approved unchecked and it is retried on the next call.
 * Deposits already approved are never re-screened or un-approved.
 */
export async function refreshApprovals(
  client: PublicClient,
  wallet: WalletClient,
  network: NetworkConfig,
  info: PoolInfo,
  events: PoolEvents,
  p: { delaySeconds: number; nowSeconds?: number; fromBlock?: bigint; screening?: ApprovalScreening; send?: <T>(fn: () => Promise<T>) => Promise<T> },
): Promise<{ hash: Hash | null; uptoBlock: bigint; approved: number; excluded: number }> {
  const now = BigInt(p.nowSeconds ?? Math.floor(Date.now() / 1000));
  const cutoff = now - BigInt(p.delaySeconds);
  // Search from the pool's deployment block, not genesis (Robinhood Chain has 100 ms blocks).
  let upto = await findBlockAtOrBefore(client, cutoff, p.fromBlock ?? network.pool?.fromBlock ?? 0n);
  if (upto > events.toBlock) upto = events.toBlock;

  const last = events.rootUpdates.at(-1);
  const floor = (last && parseAspDescriptor(last.cid)?.uptoBlock) ?? -1n;
  if (upto < floor) upto = floor;

  const excluded = new Set<string>();
  if (p.screening) {
    for (const l of await p.screening.excluded()) excluded.add(l.toString());
    for (const d of events.deposits) {
      if (d.blockNumber <= floor || d.blockNumber > upto || excluded.has(d.label.toString())) continue;
      let v: Verdict;
      try {
        v = await p.screening.verdict(d);
      } catch {
        upto = d.blockNumber - 1n;
        break;
      }
      if (!v.ok) excluded.add(d.label.toString());
    }
  }

  const xs = [...excluded].map((l) => BigInt(l));
  const labels = aspLabels(events.deposits, upto, xs);
  const excludedHere = events.deposits.filter((d) => d.blockNumber <= upto && excluded.has(d.label.toString())).map((d) => d.label);
  if (labels.length === 0) return { hash: null, uptoBlock: upto, approved: 0, excluded: excludedHere.length };
  const root = treeRoot(labels);
  if (root === info.aspRoot) return { hash: null, uptoBlock: upto, approved: labels.length, excluded: excludedHere.length };
  const exclusionId = excludedHere.length ? await p.screening!.publish(excludedHere) : null;
  const send = p.send ?? ((fn) => fn());
  const hash = await send(() =>
    wallet.writeContract({
      address: info.entrypoint,
      abi: Entrypoint.abi,
      functionName: "updateRoot",
      args: [root, encodeAspDescriptor(upto, exclusionId)],
      account: wallet.account!,
      chain: network.chain,
    }),
  );
  const r = await waitForConfirmedReceipt(client, hash, { confirmations: network.confirmations });
  if (r.status !== "success") throw new Error("Approval update reverted.");
  return { hash: r.transactionHash, uptoBlock: upto, approved: labels.length, excluded: excludedHere.length };
}

/**
 * Relays a pool-to-pool transfer (QuietPayPoolRouter.transfer): money moves from the sender's note
 * into the recipient's lock in one transaction. The proof fixes the lock, the refund address, the
 * fee and its recipient, so the relayer can only submit it as is. The fee must be this relayer's
 * fee on the amount and must pay for the transaction.
 */
export async function relayTransfer(
  client: PublicClient,
  wallet: WalletClient,
  network: NetworkConfig,
  info: PoolInfo,
  policy: RelayerPolicy,
  raw: unknown,
  guard: RelayGuard = noGuard,
): Promise<{ hash: Hash; amount: bigint; fee: bigint }> {
  const router = network.pool?.router;
  if (!router) throw new RelayRejected("Transfers aren't available here.");
  const parsed = relayBodySchema.safeParse(raw);
  if (!parsed.success) throw new RelayRejected("Malformed transfer request.");
  const body = parsed.data as SerializedWithdrawal;
  if (getAddress(body.withdrawal.processooor) !== getAddress(router)) throw new RelayRejected("Wrong processor.");
  if (BigInt(body.scope) !== info.scope) throw new RelayRejected("Wrong pool.");
  let data: ReturnType<typeof decodeTransferData>;
  try {
    data = decodeTransferData(body.withdrawal.data as `0x${string}`);
  } catch {
    throw new RelayRejected("Malformed transfer data.");
  }
  const args = transferArgs({
    withdrawal: { processooor: getAddress(body.withdrawal.processooor), data: body.withdrawal.data as `0x${string}` },
    proof: {
      pA: body.proof.pA.map(BigInt) as [bigint, bigint],
      pB: body.proof.pB.map((r) => r.map(BigInt)) as [[bigint, bigint], [bigint, bigint]],
      pC: body.proof.pC.map(BigInt) as [bigint, bigint],
      pubSignals: body.proof.pubSignals.map(BigInt),
    },
  });
  const amount = args[1].pubSignals[2];
  if (amount === 0n) throw new RelayRejected("Nothing to send.");
  if (getAddress(data.feeRecipient) !== getAddress(policy.feeRecipient)) throw new RelayRejected("Fee must go to this relayer.");
  if (data.fee !== (amount * policy.feeBPS) / 10_000n) throw new RelayRejected("Fee does not match this relayer's fee.");

  const release = await guard.claim(args[1].pubSignals[1]);
  if (!release) throw new RelayRejected("This payment is already being submitted. Wait a moment and check again.");
  let submitted = false;
  try {
    try {
      await client.simulateContract({ address: router, abi: poolRouterAbi, functionName: "transfer", args, account: wallet.account! });
    } catch (e) {
      const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
      throw new RelayRejected(
        /IncorrectASPRoot/.test(msg)
          ? "The approval list changed. Generate the proof again."
          : /NullifierAlreadySpent/.test(msg)
            ? "This note was already spent."
            : /PrecommitmentAlreadyUsed/.test(msg)
              ? "The recipient's payment details were already used. Try again."
              : "The pool rejected this payment.",
      );
    }
    const [gas, gasPrice] = await Promise.all([
      client.estimateContractGas({ address: router, abi: poolRouterAbi, functionName: "transfer", args, account: wallet.account! }),
      client.getGasPrice(),
    ]);
    const econ = relayEconomics({ amount, feeBPS: policy.feeBPS, tokenUnitsPerEth: policy.tokenUnitsPerEth, relayCost: ((gas * 6n) / 5n) * gasPrice, gasPrice, wantDrop: 0n });
    if (!econ.ok) throw new RelayRejected("This amount is too small to send right now: its fee wouldn't cover the network fee.", econ.minWithdrawal);
    const hash = await guard.send(() =>
      wallet.writeContract({ address: router, abi: poolRouterAbi, functionName: "transfer", args, account: wallet.account!, chain: network.chain, gas: (gas * 6n) / 5n }),
    );
    const receipt = await waitForConfirmedReceipt(client, hash, { confirmations: network.confirmations });
    if (receipt.status !== "success") throw new Error("The transfer transaction reverted.");
    submitted = true;
    return { hash: receipt.transactionHash, amount, fee: data.fee };
  } finally {
    if (!submitted) await release().catch(() => undefined);
  }
}
