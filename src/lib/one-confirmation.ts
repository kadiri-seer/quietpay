/**
 * Fewer wallet prompts for payers.
 *
 * Paying through a QuietPay router needs the router to be allowed to move the payer's tokens.
 * Instead of approving the exact amount every time (two prompts per payment), the payer approves
 * QuietPay's router once, for any amount; after that every payment is a single confirmation.
 *
 * That allowance can only ever be used by the payer: the routers only move tokens from whoever
 * calls them (msg.sender), to the payment the caller describes. Nobody else, QuietPay included,
 * can use it. It can be revoked from the wallet at any time.
 *
 * Wallets that already run as smart accounts (EIP-5792 atomic batches, status "supported") get
 * the approval and the first payment in one confirmation too. Wallets that would first need to
 * upgrade (status "ready") are not asked to: that upgrade is its own prompt.
 */
import { encodeFunctionData, maxUint256, type Address, type Chain, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { erc20Abi } from "@/config/contracts";

export const ONCE_ALLOWANCE = maxUint256;

export interface Call {
  to: Address;
  data: Hex;
  value?: bigint;
}

/** True if the wallet can send several calls as one atomic confirmation without upgrading first. */
export async function canBatch(wallet: WalletClient, chainId: number): Promise<boolean> {
  try {
    const caps = (await wallet.getCapabilities({ account: wallet.account!, chainId })) as { atomic?: { status?: string } };
    return caps?.atomic?.status === "supported";
  } catch {
    return false;
  }
}

export type SpendPlan =
  /** Enough allowance already: send the payment as usual. */
  | { kind: "ready" }
  /** Approved just now (the one-time approval); now send the payment as usual. */
  | { kind: "approved"; approveTx: Hash }
  /** Approval and payment went out together and are confirmed; `hash` is the payment's transaction. */
  | { kind: "batched"; hash: Hash };

/**
 * Makes sure `spender` may move `amount` of `token` for the payer, in the fewest prompts:
 * nothing if already allowed; one batched confirmation (approval + `payment`) where the wallet
 * supports it; otherwise a one-time approval for any amount, after which the caller sends the
 * payment.
 */
export async function prepareSpend(
  wallet: WalletClient,
  client: PublicClient,
  p: { chain: Chain; token: Address; spender: Address; amount: bigint; payment: Call; confirmations?: number },
): Promise<SpendPlan> {
  const owner = wallet.account!.address;
  const allowance = await client.readContract({ address: p.token, abi: erc20Abi, functionName: "allowance", args: [owner, p.spender] });
  if (allowance >= p.amount) return { kind: "ready" };
  const approve: Call = { to: p.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [p.spender, ONCE_ALLOWANCE] }) };

  if (await canBatch(wallet, p.chain.id)) {
    const { id } = await wallet.sendCalls({ account: wallet.account!, chain: p.chain, calls: [approve, p.payment], forceAtomic: true });
    const res = await wallet.waitForCallsStatus({ id, timeout: 180_000 });
    const last = res.receipts?.at(-1);
    if (res.status !== "success" || !last) throw new Error("The payment didn't go through. Nothing was sent.");
    return { kind: "batched", hash: last.transactionHash };
  }

  const approveTx = await wallet.writeContract({ account: wallet.account!, chain: p.chain, address: p.token, abi: erc20Abi, functionName: "approve", args: [p.spender, ONCE_ALLOWANCE] });
  const r = await client.waitForTransactionReceipt({ hash: approveTx, confirmations: p.confirmations ?? 1 });
  if (r.status !== "success") throw new Error("The approval transaction failed.");
  return { kind: "approved", approveTx };
}
