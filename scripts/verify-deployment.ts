/**
 * Verifies a network's configuration onchain exactly as the app does:
 * chain ID, token bytecode + symbol + decimals, and announcer runtime code hash.
 *
 * Usage:
 *   npm run contracts:verify                      # testnet, using .env / env vars
 *   NETWORK=mainnet NEXT_PUBLIC_ENABLE_MAINNET=true npm run contracts:verify
 *
 * Exits non-zero if anything fails. Run it before enabling a network.
 */
import "./load-env";
import { NETWORKS, type NetworkKey } from "../src/config/networks";
import { verifyPool } from "../src/lib/pool/actions";
import { verifyPoolRouterAt, verifyPoolRouterInfo } from "../src/lib/pool/receive";
import { keccak256, toBytes } from "viem";
import { assertChainId, createNetworkClient, verifyAnnouncer, verifyRouter, verifyToken } from "../src/lib/chain";

async function main() {
  const key = (process.env.NETWORK || "testnet") as NetworkKey;
  const network = NETWORKS[key];
  if (!network) throw new Error(`Unknown NETWORK ${key}`);
  const client = createNetworkClient(network);
  let ok = true;
  const line = (good: boolean, label: string, detail = "") => {
    ok &&= good;
    console.log(`${good ? "✓" : "✕"} ${label}${detail ? `: ${detail}` : ""}`);
  };

  console.log(`Verifying ${network.label} via ${network.rpcUrl}\n`);
  try {
    await assertChainId(client, network.chain.id);
    line(true, "Chain ID", String(network.chain.id));
  } catch (e) {
    line(false, "Chain ID", (e as Error).message);
  }
  try {
    const t = await verifyToken(client, network);
    line(true, "Token", `${t.address} ${t.symbol} (${t.name}), ${t.decimals} decimals, code ${t.codeHash}${t.isMock ? " [MOCK]" : ""}`);
  } catch (e) {
    line(false, "Token", (e as Error).message);
  }
  try {
    const a = await verifyAnnouncer(client, network);
    line(true, "ERC-5564 announcer", `${a.address}, code ${a.codeHash}`);
  } catch (e) {
    line(false, "ERC-5564 announcer", (e as Error).message);
  }
  try {
    const r = await verifyRouter(client, network);
    line(
      true,
      "QuietPay router",
      r
        ? `${r.address}, v${r.version} (bound to this network's token and announcer; one-time links enforced onchain${r.version === 3 ? "; destinations checked onchain" : ""}), code ${r.codeHash}`
        : "not configured (two-transaction payments)",
    );
  } catch (e) {
    line(false, "QuietPay router", (e as Error).message);
  }
  try {
    const p = await verifyPool(client, network);
    line(
      true,
      "Shielded pool",
      p ? `entrypoint ${p.entrypoint}, pool ${p.pool}, min deposit ${p.minimumDeposit}, relay fee max ${p.maxRelayFeeBPS} bps, approvals ${p.aspRoot ? "published" : "none yet"}` : "not configured",
    );
  } catch (e) {
    line(false, "Shielded pool", (e as Error).message);
  }
  try {
    const pr = await verifyPoolRouterInfo(client, network);
    line(true, "Pool router", pr ? `${pr.address}, v${pr.version}${pr.version === 2 ? " (signed one-time requests, refund checks)" : " (v1: deploy v2 for signed requests)"}` : "not configured");
    for (const l of network.pool?.legacyRouters ?? []) {
      const v = await verifyPoolRouterAt(client, network, l);
      line(true, "Earlier pool router (refunds only)", `${v.address}, v${v.version}`);
    }
  } catch (e) {
    line(false, "Pool router", (e as Error).message);
  }
  if (network.pool?.guardian) {
    try {
      const OWNER = keccak256(toBytes("OWNER_ROLE"));
      const owns = await client.readContract({
        address: network.pool.entrypoint,
        abi: [{ type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] }] as const,
        functionName: "hasRole",
        args: [OWNER, network.pool.guardian],
      });
      line(true, "Pool guardian", `${network.pool.guardian}${owns ? " holds the Entrypoint's owner role" : " deployed, not the owner yet (run DEPLOY=handover)"}`);
    } catch (e) {
      line(false, "Pool guardian", (e as Error).message);
    }
  }
  console.log(`\nMainnet enabled in this build: ${NETWORKS.mainnet.enabled}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
