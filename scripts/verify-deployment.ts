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
    line(true, "QuietPay router", r ? `${r.address}, code ${r.codeHash}` : "not configured (two-transaction payments)");
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
  console.log(`\nMainnet enabled in this build: ${NETWORKS.mainnet.enabled}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
