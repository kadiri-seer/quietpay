/**
 * Maps wallet/RPC errors to clear, actionable messages. Never includes keys or full payloads.
 */
import { BaseError } from "viem";

export type TxErrorKind =
  | "user_rejected"
  | "insufficient_funds"
  | "timeout"
  | "replaced"
  | "cancelled"
  | "reverted"
  | "chain_mismatch"
  | "rpc"
  | "unknown";

export interface ClassifiedError {
  kind: TxErrorKind;
  message: string;
}

export class TxReplacedError extends Error {
  constructor(
    public reason: "cancelled" | "replaced",
    public replacementHash: string,
  ) {
    super(`Transaction was ${reason} by ${replacementHash}`);
    this.name = "TxReplacedError";
  }
}

export class TransferNotVerifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferNotVerifiedError";
  }
}

function names(err: unknown): string[] {
  const out: string[] = [];
  if (err instanceof BaseError) {
    err.walk((e) => {
      if (e && typeof e === "object" && "name" in e) out.push(String((e as Error).name));
      return false;
    });
  }
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur; i++) {
    if (cur && typeof cur === "object") {
      if ("name" in cur) out.push(String((cur as Error).name));
      cur = (cur as { cause?: unknown }).cause;
    } else break;
  }
  return out;
}

function codes(err: unknown): number[] {
  const out: number[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "number") out.push(c);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

export function classifyTxError(err: unknown): ClassifiedError {
  const n = names(err);
  const c = codes(err);
  const text = err instanceof Error ? `${err.message} ${(err as BaseError).details ?? ""}`.toLowerCase() : String(err).toLowerCase();

  if (err instanceof TxReplacedError) {
    return err.reason === "cancelled"
      ? { kind: "cancelled", message: "The transaction was cancelled from your wallet." }
      : { kind: "replaced", message: "The transaction was replaced by a different transaction." };
  }
  if (err instanceof TransferNotVerifiedError) return { kind: "reverted", message: err.message };
  if (n.includes("UserRejectedRequestError") || c.includes(4001) || text.includes("user rejected") || text.includes("user denied")) {
    return { kind: "user_rejected", message: "You rejected the request in your wallet. Nothing was sent." };
  }
  if (n.includes("InsufficientFundsError") || text.includes("insufficient funds")) {
    return { kind: "insufficient_funds", message: "Not enough ETH to pay network fees. Add ETH on this network and try again." };
  }
  if (n.includes("ChainMismatchError") || text.includes("does not match the target chain")) {
    return { kind: "chain_mismatch", message: "Your wallet is on a different network. Switch networks and try again." };
  }
  if (n.includes("WaitForTransactionReceiptTimeoutError") || n.includes("TimeoutError") || text.includes("timed out") || text.includes("timeout")) {
    return {
      kind: "timeout",
      message: "The network did not confirm in time. The transaction may still land; check the explorer before trying again.",
    };
  }
  // Router v2's onchain one-time check: someone else paid this link first.
  if (text.includes("alreadypaid")) {
    return { kind: "reverted", message: "This one-time link was already paid. Nothing was sent from your wallet." };
  }
  if (n.includes("ContractFunctionRevertedError") || text.includes("reverted") || text.includes("execution reverted")) {
    return { kind: "reverted", message: "The transaction reverted onchain. No tokens moved." };
  }
  if (n.includes("HttpRequestError") || n.includes("RpcRequestError") || n.includes("InternalRpcError") || text.includes("fetch")) {
    return { kind: "rpc", message: "Could not reach the Robinhood Chain RPC. Check your connection and try again." };
  }
  if (n.includes("ConnectorAlreadyConnectedError")) {
    return { kind: "unknown", message: "Your wallet is already connected. Reload the page." };
  }
  if (n.includes("ProviderNotFoundError") || n.includes("ConnectorNotFoundError")) {
    return { kind: "unknown", message: "No browser wallet found. Install or unlock MetaMask, then reload the page." };
  }
  if (c.includes(-32002) || text.includes("already pending")) {
    return { kind: "unknown", message: "Your wallet already has a request open. Open MetaMask, approve or reject it, then try again." };
  }
  if (c.includes(4902) || text.includes("unrecognized chain")) {
    return { kind: "chain_mismatch", message: "Your wallet doesn't know Robinhood Chain Testnet yet. Approve adding it when your wallet asks, or add it manually (chain ID 46630)." };
  }
  // Fall back to the library's own short message (viem and wagmi both provide one) so the real cause is visible.
  const short = (err as { shortMessage?: unknown })?.shortMessage;
  if (typeof short === "string" && short) return { kind: "unknown", message: short };
  if (err instanceof Error && err.message) return { kind: "unknown", message: err.message.split("\n")[0].slice(0, 200) };
  return { kind: "unknown", message: "Something went wrong. Check the explorer before retrying." };
}
