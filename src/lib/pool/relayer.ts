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
import { aspLabels, encodeAspDescriptor, type PoolEvents } from "./state";

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
  /** ETH sent to the recipient after a withdrawal so it can move the tokens. 0 disables. */
  gasDrop: bigint;
}

export class RelayRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayRejected";
  }
}

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
): Promise<{ hash: Hash; recipient: Address; amount: bigint; fee: bigint; gasDropHash: Hash | null }> {
  const parsed = relayBodySchema.safeParse(raw);
  if (!parsed.success) throw new RelayRejected("Malformed withdrawal request.");
  const body = parsed.data as SerializedWithdrawal;
  if (getAddress(body.withdrawal.processooor) !== getAddress(info.entrypoint)) throw new RelayRejected("Wrong processor.");
  if (BigInt(body.scope) !== info.scope) throw new RelayRejected("Wrong pool.");
  let data;
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

  // Simulation runs the full onchain checks (proof, roots, nullifier) at no cost.
  try {
    await client.simulateContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "relay", args, account: wallet.account! });
  } catch (e) {
    const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
    throw new RelayRejected(/IncorrectASPRoot/.test(msg) ? "The approval list changed. Generate the proof again." : /NullifierAlreadySpent/.test(msg) ? "This note was already spent." : `The pool rejected this withdrawal: ${msg.split("\n")[0]}`);
  }
  const hash = await wallet.writeContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "relay", args, account: wallet.account!, chain: network.chain });
  const receipt = await waitForConfirmedReceipt(client, hash, { confirmations: network.confirmations });
  if (receipt.status !== "success") throw new Error("The withdrawal transaction reverted.");
  const relayed = parseEventLogs({ abi: Entrypoint.abi, logs: receipt.logs, eventName: "WithdrawalRelayed" })[0];
  const fee = relayed ? (relayed.args as { _feeAmount: bigint })._feeAmount : 0n;

  let gasDropHash: Hash | null = null;
  if (policy.gasDrop > 0n) {
    const bal = await client.getBalance({ address: data.recipient });
    if (bal < policy.gasDrop) {
      gasDropHash = await wallet.sendTransaction({ to: data.recipient, value: policy.gasDrop - bal, account: wallet.account!, chain: network.chain });
      await waitForConfirmedReceipt(client, gasDropHash, { confirmations: network.confirmations });
    }
  }
  return { hash: receipt.transactionHash, recipient: getAddress(data.recipient), amount, fee, gasDropHash };
}

/**
 * Publishes a new approval root if deposits older than `delaySeconds` are not yet approved.
 * Returns the transaction hash, or null when the approved set is already current.
 */
export async function refreshApprovals(
  client: PublicClient,
  wallet: WalletClient,
  network: NetworkConfig,
  info: PoolInfo,
  events: PoolEvents,
  p: { delaySeconds: number; nowSeconds?: number; fromBlock?: bigint },
): Promise<{ hash: Hash | null; uptoBlock: bigint; approved: number }> {
  const now = BigInt(p.nowSeconds ?? Math.floor(Date.now() / 1000));
  const cutoff = now - BigInt(p.delaySeconds);
  // Search from the pool's deployment block, not genesis (Robinhood Chain has 100 ms blocks).
  let upto = await findBlockAtOrBefore(client, cutoff, p.fromBlock ?? network.pool?.fromBlock ?? 0n);
  if (upto > events.toBlock) upto = events.toBlock;
  const labels = aspLabels(events.deposits, upto);
  if (labels.length === 0) return { hash: null, uptoBlock: upto, approved: 0 };
  const root = treeRoot(labels);
  if (root === info.aspRoot) return { hash: null, uptoBlock: upto, approved: labels.length };
  const hash = await wallet.writeContract({
    address: info.entrypoint,
    abi: Entrypoint.abi,
    functionName: "updateRoot",
    args: [root, encodeAspDescriptor(upto)],
    account: wallet.account!,
    chain: network.chain,
  });
  const r = await waitForConfirmedReceipt(client, hash, { confirmations: network.confirmations });
  if (r.status !== "success") throw new Error("Approval update reverted.");
  return { hash: r.transactionHash, uptoBlock: upto, approved: labels.length };
}
