import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, maxUint256, type Address, type Hex } from "viem";
import { erc20Abi } from "@/config/contracts";
import { NETWORKS } from "@/config/networks";
import { canBatch, prepareSpend } from "@/lib/one-confirmation";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const ROUTER = "0x2222222222222222222222222222222222222222" as Address;
const PAYER = "0x3333333333333333333333333333333333333333" as Address;
const payment = { to: ROUTER, data: "0xabcdef" as Hex, value: 0n };
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function setup(p: { allowance: bigint; atomic?: string | null; batch?: "success" | "failure" }) {
  const client = {
    readContract: vi.fn(async () => p.allowance),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
  };
  const wallet = {
    account: { address: PAYER },
    getCapabilities: vi.fn(async () => {
      if (p.atomic === null) throw new Error("wallet_getCapabilities not supported");
      return p.atomic ? { atomic: { status: p.atomic } } : {};
    }),
    sendCalls: vi.fn(async () => ({ id: "bundle" })),
    waitForCallsStatus: vi.fn(async () => ({ status: p.batch ?? "success", receipts: [{ transactionHash: H(7) }] })),
    writeContract: vi.fn(async () => H(1)),
  };
  return { client, wallet };
}

const run = (s: ReturnType<typeof setup>, amount = 5n) =>
  prepareSpend(s.wallet as never, s.client as never, { chain: NETWORKS.testnet.chain, token: TOKEN, spender: ROUTER, amount, payment });

describe("one confirmation for payers", () => {
  it("asks for nothing when QuietPay is already allowed", async () => {
    const s = setup({ allowance: maxUint256 });
    expect(await run(s)).toEqual({ kind: "ready" });
    expect(s.wallet.writeContract).not.toHaveBeenCalled();
    expect(s.wallet.sendCalls).not.toHaveBeenCalled();
  });

  it("approves once for any amount when the wallet can't batch, so later payments are one prompt", async () => {
    for (const atomic of [null, undefined, "unsupported", "ready"]) {
      const s = setup({ allowance: 0n, atomic });
      expect(await run(s)).toEqual({ kind: "approved", approveTx: H(1) });
      const call = s.wallet.writeContract.mock.calls[0] as unknown as [{ functionName: string; args: [Address, bigint]; address: Address }];
      expect(call[0]).toMatchObject({ address: TOKEN, functionName: "approve", args: [ROUTER, maxUint256] });
      // "ready" would need the wallet to upgrade first, which is its own prompt: not used.
      expect(s.wallet.sendCalls).not.toHaveBeenCalled();
    }
  });

  it("sends the approval and the payment together where the wallet supports it", async () => {
    const s = setup({ allowance: 0n, atomic: "supported" });
    expect(await run(s)).toEqual({ kind: "batched", hash: H(7) });
    const sent = (s.wallet.sendCalls.mock.calls[0] as unknown as [{ calls: { to: Address; data: Hex }[]; forceAtomic: boolean }])[0];
    expect(sent.forceAtomic).toBe(true);
    expect(sent.calls).toHaveLength(2);
    expect(sent.calls[0].to).toBe(TOKEN);
    expect(decodeFunctionData({ abi: erc20Abi, data: sent.calls[0].data })).toMatchObject({ functionName: "approve", args: [ROUTER, maxUint256] });
    expect(sent.calls[1]).toEqual(payment);
    expect(s.wallet.writeContract).not.toHaveBeenCalled();
  });

  it("reports a failed batch instead of pretending it went through", async () => {
    const s = setup({ allowance: 0n, atomic: "supported", batch: "failure" });
    await expect(run(s)).rejects.toThrow(/didn't go through/);
  });

  it("reads capabilities defensively", async () => {
    expect(await canBatch(setup({ allowance: 0n, atomic: null }).wallet as never, 46630)).toBe(false);
    expect(await canBatch(setup({ allowance: 0n, atomic: "supported" }).wallet as never, 46630)).toBe(true);
  });
});
