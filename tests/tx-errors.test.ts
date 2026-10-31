import { describe, expect, it } from "vitest";
import {
  ContractFunctionRevertedError,
  InsufficientFundsError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
  HttpRequestError,
} from "viem";
import { TransferNotVerifiedError, TxReplacedError, classifyTxError } from "@/lib/tx-errors";

describe("transaction failure classification", () => {
  it("detects user rejection (viem error and raw EIP-1193 4001)", () => {
    expect(classifyTxError(new UserRejectedRequestError(new Error("no"))).kind).toBe("user_rejected");
    expect(classifyTxError({ code: 4001, message: "User denied transaction signature" }).kind).toBe("user_rejected");
  });
  it("detects insufficient funds", () => {
    expect(classifyTxError(new InsufficientFundsError()).kind).toBe("insufficient_funds");
  });
  it("detects receipt timeouts", () => {
    expect(classifyTxError(new WaitForTransactionReceiptTimeoutError({ hash: "0x01" })).kind).toBe("timeout");
  });
  it("detects replacement and cancellation", () => {
    expect(classifyTxError(new TxReplacedError("cancelled", "0xabc")).kind).toBe("cancelled");
    expect(classifyTxError(new TxReplacedError("replaced", "0xabc")).kind).toBe("replaced");
  });
  it("detects reverts and unverified transfers", () => {
    expect(classifyTxError(new ContractFunctionRevertedError({ abi: [], functionName: "transfer" })).kind).toBe("reverted");
    expect(classifyTxError(new TransferNotVerifiedError("no transfer")).kind).toBe("reverted");
  });
  it("detects RPC failures", () => {
    expect(classifyTxError(new HttpRequestError({ url: "https://rpc.example" })).kind).toBe("rpc");
  });
  it("falls back to a generic message", () => {
    const c = classifyTxError(new Error("weird"));
    expect(c.kind).toBe("unknown");
    expect(c.message).toMatch(/explorer/);
  });
});
