"use client";

/**
 * Who controls the shielded pool, read from the chain: the current fees, whether the guardian
 * holds the Entrypoint's owner role, its admin and delay, and every pending proposal with the time
 * it can take effect. Nothing here comes from QuietPay's server.
 */
import { useQuery } from "@tanstack/react-query";
import { decodeFunctionData, keccak256, parseAbiItem, toBytes, type Address, type Hex } from "viem";
import { NETWORKS } from "@/config/networks";
import { usePublicClient } from "@/components/hooks";
import { findDeployBlock } from "@/lib/chain";
import { usePoolInfo } from "@/components/pool-hooks";
import { LoadingRows, Mono, shorten, formatDateTime } from "@/components/ui";

const guardianAbi = [
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "delay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_VETTING_FEE_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_RELAY_FEE_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "proposals", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }, { type: "uint64" }, { type: "bytes" }] },
] as const;
const roleAbi = [{ type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] }] as const;
const proposalAbi = [
  { type: "function", name: "updatePoolConfiguration", stateMutability: "nonpayable", inputs: [{ name: "asset", type: "address" }, { name: "minimumDeposit", type: "uint256" }, { name: "vettingFeeBPS", type: "uint256" }, { name: "maxRelayFeeBPS", type: "uint256" }], outputs: [] },
  { type: "function", name: "upgradeToAndCall", stateMutability: "payable", inputs: [{ name: "implementation", type: "address" }, { name: "data", type: "bytes" }], outputs: [] },
  { type: "function", name: "grantRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  { type: "function", name: "revokeRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  { type: "function", name: "registerPool", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "removePool", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "setAdmin", stateMutability: "nonpayable", inputs: [{ name: "admin", type: "address" }], outputs: [] },
  { type: "function", name: "setDelay", stateMutability: "nonpayable", inputs: [{ name: "delay", type: "uint256" }], outputs: [] },
] as const;
const OWNER_ROLE = keccak256(toBytes("OWNER_ROLE"));

function describe(data: Hex): string {
  try {
    const d = decodeFunctionData({ abi: proposalAbi, data });
    switch (d.functionName) {
      case "updatePoolConfiguration":
        return `Change fees: deposit fee ${Number(d.args[2]) / 100}%, relay fee ceiling ${Number(d.args[3]) / 100}%, minimum deposit ${d.args[1]}`;
      case "upgradeToAndCall":
        return `Upgrade the Entrypoint to ${shorten(d.args[0], 4)}`;
      case "grantRole":
      case "revokeRole":
        return `${d.functionName === "grantRole" ? "Grant" : "Revoke"} a role for ${shorten(d.args[1], 4)}`;
      case "setAdmin":
        return `Hand the admin to ${shorten(d.args[0], 4)}`;
      case "setDelay":
        return `Change the delay to ${Number(d.args[0]) / 3600} hours`;
      default:
        return d.functionName;
    }
  } catch {
    return "Unrecognised call";
  }
}

export function PoolAdmin() {
  const network = NETWORKS.testnet;
  const client = usePublicClient(network);
  const info = usePoolInfo(network);
  const guardian = network.pool?.guardian ?? null;
  const q = useQuery({
    queryKey: ["pool-admin", guardian, network.pool?.entrypoint],
    enabled: !!guardian && !!network.pool,
    staleTime: 60_000,
    queryFn: async () => {
      const g = guardian as Address;
      const [owns, admin, delay, maxVetting, maxRelay] = await Promise.all([
        client.readContract({ address: network.pool!.entrypoint, abi: roleAbi, functionName: "hasRole", args: [OWNER_ROLE, g] }),
        client.readContract({ address: g, abi: guardianAbi, functionName: "admin" }),
        client.readContract({ address: g, abi: guardianAbi, functionName: "delay" }),
        client.readContract({ address: g, abi: guardianAbi, functionName: "MAX_VETTING_FEE_BPS" }),
        client.readContract({ address: g, abi: guardianAbi, functionName: "MAX_RELAY_FEE_BPS" }),
      ]);
      // Proposals since the guardian was deployed, read in chunks the RPC accepts.
      const event = parseAbiItem("event Proposed(bytes32 indexed id, address indexed target, bytes4 indexed selector, bytes data, uint256 eta)");
      const from = await findDeployBlock(client, g).catch(() => network.pool!.fromBlock);
      const to = await client.getBlockNumber();
      const logs = [];
      for (let b = from; b <= to; b += network.logChunkSize) {
        const end = b + network.logChunkSize - 1n < to ? b + network.logChunkSize - 1n : to;
        logs.push(...(await client.getLogs({ address: g, event, fromBlock: b, toBlock: end })));
      }
      // Still pending: proposals the guardian still stores (carried out and cancelled ones are deleted).
      const pending = [];
      for (const l of logs) {
        const [, eta] = await client.readContract({ address: g, abi: guardianAbi, functionName: "proposals", args: [l.args.id!] });
        if (eta > 0n) pending.push({ id: l.args.id!, data: l.args.data!, eta: Number(eta) });
      }
      return { owns, admin, delay: Number(delay), maxVetting: Number(maxVetting), maxRelay: Number(maxRelay), pending };
    },
  });

  if (!network.pool) return <p className="text-sm text-haze">No shielded pool is configured.</p>;
  return (
    <div className="space-y-3 text-sm leading-relaxed text-mist">
      {info.data && (
        <p>
          Current deposit fee: <span className="text-snow">{Number(info.data.vettingFeeBPS) / 100}%</span> · relay fee ceiling{" "}
          <span className="text-snow">{Number(info.data.maxRelayFeeBPS) / 100}%</span> (read from the chain now).
        </p>
      )}
      {!guardian ? (
        <p>
          The pool&apos;s owner is still the key that deployed it. A guardian contract (fee ceilings, a public delay on every change) is
          ready; until it takes over, changes can happen without notice.
        </p>
      ) : q.isLoading ? (
        <LoadingRows label="Reading the guardian" rows={2} />
      ) : q.error || !q.data ? (
        <p className="text-bad">Couldn&apos;t read the guardian from the chain.</p>
      ) : (
        <>
          <p>
            Guardian <Mono>{shorten(guardian, 4)}</Mono> {q.data.owns ? "owns the pool's Entrypoint." : "does not own the Entrypoint yet."} Admin{" "}
            <Mono>{shorten(q.data.admin, 4)}</Mono>. Every change waits {Math.round(q.data.delay / 3600)} hours and can be cancelled meanwhile.
            Fee ceilings: deposit {q.data.maxVetting / 100}%, relay {q.data.maxRelay / 100}%.
          </p>
          {q.data.pending.length === 0 ? (
            <p>No changes are pending.</p>
          ) : (
            <ul className="space-y-1">
              {q.data.pending.map((p) => (
                <li key={p.id}>
                  Pending: {describe(p.data)} · can take effect {formatDateTime(p.eta * 1000)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
