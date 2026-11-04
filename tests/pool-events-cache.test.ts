import { describe, expect, it } from "vitest";
import { clearPoolEventCache, fetchPoolEvents } from "@/lib/pool/state";

const POOL = "0x1111111111111111111111111111111111111111" as const;
const EP = "0x2222222222222222222222222222222222222222" as const;

function fakeClient() {
  const calls: [bigint, bigint][] = [];
  let head = 1_000_000n;
  return {
    calls,
    setHead: (h: bigint) => (head = h),
    client: {
      chain: { id: 46630 },
      getBlockNumber: async () => head,
      getContractEvents: async (q: { fromBlock: bigint; toBlock: bigint; address: string }) => {
        if (q.address === POOL) calls.push([q.fromBlock, q.toBlock]);
        return [];
      },
    },
  };
}

describe("pool history loading", () => {
  it("loads history once, then only new blocks (plus a reorg margin)", async () => {
    clearPoolEventCache();
    const f = fakeClient();
    const p = { entrypoint: EP, pool: POOL, fromBlock: 0n, chunkSize: 100_000n };
    await fetchPoolEvents(f.client as never, p);
    expect(f.calls).toHaveLength(11); // 0..1,000,000 in 100k chunks, fetched in parallel
    f.calls.length = 0;
    f.setHead(1_000_050n);
    await fetchPoolEvents(f.client as never, p);
    expect(f.calls).toEqual([[999_701n, 1_000_050n]]);
  });

  it("starts over when the saved copy is ahead of the chain (a reset or another chain)", async () => {
    clearPoolEventCache();
    const f = fakeClient();
    const p = { entrypoint: EP, pool: POOL, fromBlock: 0n, chunkSize: 500_000n };
    await fetchPoolEvents(f.client as never, p);
    f.calls.length = 0;
    f.setHead(10n);
    await fetchPoolEvents(f.client as never, p);
    expect(f.calls).toEqual([[0n, 10n]]);
  });

  it("splits a range the RPC refuses", async () => {
    clearPoolEventCache();
    const f = fakeClient();
    let refused = 0;
    const client = {
      ...f.client,
      getContractEvents: async (q: { fromBlock: bigint; toBlock: bigint; address: string }) => {
        if (q.toBlock - q.fromBlock > 300_000n) {
          refused++;
          throw new Error("range too large");
        }
        return f.client.getContractEvents(q);
      },
    };
    await fetchPoolEvents(client as never, { entrypoint: EP, pool: POOL, fromBlock: 0n, chunkSize: 1_000_001n });
    expect(refused).toBeGreaterThan(0);
    expect(f.calls.reduce((s, [a, b]) => s + (b - a + 1n), 0n)).toBe(1_000_001n);
  });
});
