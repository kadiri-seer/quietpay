/**
 * Deploys QuietPay's contracts to Robinhood Chain Testnet (chain ID 46630):
 *   - ERC5564Announcer (ScopeLift, CC0) — required for stealth announcements
 *   - QuietPayTestUSDG (MOCK, worthless) — only because no verified testnet USDG exists
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npm run contracts:deploy
 *   DEPLOYER_PRIVATE_KEY=0x... DEPLOY=announcer npm run contracts:deploy   # announcer only
 *   DEPLOYER_PRIVATE_KEY=0x... DEPLOY=router npm run contracts:deploy      # router only
 *   DEPLOYER_PRIVATE_KEY=0x... DEPLOY=pool POSTMAN_ADDRESS=0x... npm run contracts:deploy
 *   DEPLOYER_PRIVATE_KEY=0x... DEPLOY=poolrouter npm run contracts:deploy  # pays straight into the pool
 *     Shielded pool (Privacy Pools contracts, unchanged) for the configured testnet token.
 *     POSTMAN_ADDRESS is the relayer's address: it publishes approval roots. The deployer
 *     stays the pool owner, so keep its key out of the web host.
 *
 * Optional: RPC_URL (defaults to the public testnet RPC).
 *
 * Mainnet: this script only deploys the announcer to mainnet, and only with
 *   ALLOW_MAINNET_ANNOUNCER=true RPC_URL=https://rpc.mainnet.chain.robinhood.com DEPLOY=announcer
 * It never deploys the mock token to mainnet.
 *
 * Deploys the exact bytecode in contracts/artifacts (run `npm run contracts:compile` after
 * changing Solidity) and verifies the deployed runtime code hash before printing config.
 */
import "./load-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, type Hex } from "viem";
import { getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployPool } from "./pool-deploy-lib";

/** Official USDG on Robinhood Chain mainnet (same value as src/config/networks.ts). */
const MAINNET_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

const TESTNET_ID = 46630;
const MAINNET_ID = 4663;

const ROOT = join(import.meta.dirname, "..");
const artifact = (name: string) => JSON.parse(readFileSync(join(ROOT, "contracts", "artifacts", `${name}.json`), "utf8"));

function fail(msg: string): never {
  console.error(`\n✕ ${msg}\n`);
  process.exit(1);
}

async function main() {
  // Accept keys copied from wallets: strip whitespace/quotes and add a missing 0x prefix.
  const raw = (process.env.DEPLOYER_PRIVATE_KEY ?? "").replace(/[\s"']/g, "");
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    const hexLen = key.slice(2).length;
    fail(
      raw.length === 0
        ? "DEPLOYER_PRIVATE_KEY is empty."
        : `DEPLOYER_PRIVATE_KEY must be a 64-character hex private key; got ${hexLen} characters${
            hexLen === 40 ? " (that looks like an address, not a private key)" : raw.includes(" ") || /[g-z]/i.test(raw) ? " (that looks like a seed phrase; use the private key instead)" : ""
          }.`,
    );
  }
  const rpc = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
  const what = (process.env.DEPLOY || "announcer,token").split(",").map((s) => s.trim());

  const probe = createPublicClient({ transport: http(rpc) });
  const chainId = await probe.getChainId();
  if (chainId === MAINNET_ID) {
    if (process.env.ALLOW_MAINNET_ANNOUNCER !== "true") fail("Refusing to deploy to mainnet. See the header of this script.");
    // Only the announcer and router may go to mainnet; never the mock token.
    if (what.includes("token")) fail("The mock token must never be deployed to mainnet.");
  } else if (chainId !== TESTNET_ID) {
    fail(`RPC reports chain ${chainId}; expected Robinhood Chain Testnet (${TESTNET_ID}).`);
  }

  const chain = defineChain({
    id: chainId,
    name: chainId === MAINNET_ID ? "Robinhood Chain" : "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const account = privateKeyToAccount(key);
  const client = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  const bal = await client.getBalance({ address: account.address });
  console.log(`Deployer ${account.address} on chain ${chainId}, balance ${formatEther(bal)} ETH`);
  if (bal === 0n) fail("Deployer has no ETH. Fund it from https://faucet.testnet.chain.robinhood.com");

  const env: string[] = [];
  const prefix = chainId === MAINNET_ID ? "NEXT_PUBLIC_MAINNET" : "NEXT_PUBLIC_TESTNET";

  async function deploy(name: string, args: unknown[] = []) {
    const a = artifact(name);
    console.log(`\nDeploying ${name} (${a.compiler})…`);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    console.log(`  tx ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success" || !receipt.contractAddress) fail(`${name} deployment failed.`);
    const code = await client.getCode({ address: receipt.contractAddress });
    if (!code || keccak256(code) !== a.runtimeCodeHash) fail(`${name} runtime code hash mismatch at ${receipt.contractAddress}.`);
    console.log(`  ✓ ${name} at ${receipt.contractAddress} (block ${receipt.blockNumber}), runtime code hash verified`);
    return receipt.contractAddress;
  }

  if (what.includes("announcer")) {
    const at = await client.getBlockNumber();
    env.push(`${prefix}_ANNOUNCER_ADDRESS=${await deploy("ERC5564Announcer")}`, `${prefix}_ANNOUNCER_FROM_BLOCK=${at}`);
  }
  if (what.includes("token")) env.push(`${prefix}_TOKEN_ADDRESS=${await deploy("QuietPayTestUSDG")}`);
  if (what.includes("router")) {
    // Router v2 is bound for good to this network's token and announcer, so both must be the
    // right, verified contracts before it is deployed.
    const token = process.env[`${prefix}_TOKEN_ADDRESS`] ?? (chainId === MAINNET_ID ? MAINNET_USDG : undefined);
    const announcer = process.env[`${prefix}_ANNOUNCER_ADDRESS`];
    if (!token || !isAddress(token)) fail(`Set ${prefix}_TOKEN_ADDRESS before deploying the router.`);
    if (!announcer || !isAddress(announcer)) fail(`Set ${prefix}_ANNOUNCER_ADDRESS before deploying the router.`);
    const announcerCode = await client.getCode({ address: getAddress(announcer) });
    if (!announcerCode || keccak256(announcerCode) !== artifact("ERC5564Announcer").runtimeCodeHash) fail(`${announcer} is not QuietPay's ERC-5564 announcer build.`);
    const symbol = await client.readContract({ address: getAddress(token), abi: [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const, functionName: "symbol" }).catch(() => null);
    const expected = chainId === MAINNET_ID ? "USDG" : "tUSDG";
    if (symbol !== expected) fail(`${token} reports symbol ${JSON.stringify(symbol)}; expected ${expected}.`);
    const router = await deploy("QuietPayRouterV2", [getAddress(token), getAddress(announcer)]);
    const read = (fn: "token" | "announcer") =>
      client.readContract({ address: router, abi: [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: fn });
    if (getAddress(await read("token")) !== getAddress(token) || getAddress(await read("announcer")) !== getAddress(announcer)) {
      fail(`Router ${router} is not bound to the expected token and announcer.`);
    }
    console.log(`  ✓ bound to token ${getAddress(token)} and announcer ${getAddress(announcer)}`);
    env.push(`${prefix}_ROUTER_ADDRESS=${router}`);
  }
  if (what.includes("pool")) {
    if (chainId !== TESTNET_ID) fail("The shielded pool is testnet only.");
    const token = process.env.NEXT_PUBLIC_TESTNET_TOKEN_ADDRESS;
    if (!token || !isAddress(token)) fail("Set NEXT_PUBLIC_TESTNET_TOKEN_ADDRESS (the tUSDG mock) before deploying the pool.");
    const postman = (process.env.POSTMAN_ADDRESS || "").trim();
    if (!isAddress(postman)) fail("Set POSTMAN_ADDRESS to the relayer's address (not its key).");
    if (getAddress(postman) === account.address) fail("Use a separate relayer account: the deployer owns the pool and its key must not live on the web host.");
    console.log("\nDeploying the shielded pool (Privacy Pools by 0xbow, unchanged)…");
    const d = await deployPool(wallet, client, {
      token: getAddress(token),
      owner: account.address,
      postman: getAddress(postman),
      minimumDeposit: 1_000_000n, // 1 tUSDG
      vettingFeeBPS: 0n,
      maxRelayFeeBPS: 100n, // 1%
      log: (m) => console.log(`  ${m}`),
    });
    console.log(`  ✓ pool scope ${d.scope}`);
    env.push(`${prefix}_POOL_ENTRYPOINT=${d.entrypoint}`, `${prefix}_POOL_ADDRESS=${d.pool}`, `${prefix}_POOL_FROM_BLOCK=${d.fromBlock}`);
  }
  if (what.includes("poolrouter")) {
    // Pays straight into the pool for someone else (contracts/src/QuietPayPoolRouter.sol).
    if (chainId !== TESTNET_ID) fail("The pool router is testnet only, like the pool.");
    const pool = process.env.NEXT_PUBLIC_TESTNET_POOL_ADDRESS;
    const entrypoint = process.env.NEXT_PUBLIC_TESTNET_POOL_ENTRYPOINT;
    const token = process.env.NEXT_PUBLIC_TESTNET_TOKEN_ADDRESS;
    if (!pool || !isAddress(pool) || !entrypoint || !isAddress(entrypoint) || !token || !isAddress(token))
      fail("Set NEXT_PUBLIC_TESTNET_POOL_ADDRESS, NEXT_PUBLIC_TESTNET_POOL_ENTRYPOINT and NEXT_PUBLIC_TESTNET_TOKEN_ADDRESS before deploying the pool router.");
    const r = await deploy("QuietPayPoolRouter", [getAddress(pool)]);
    const read = (fn: "pool" | "entrypoint" | "token") =>
      client.readContract({ address: r, abi: [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: fn });
    if ((await read("pool")) !== getAddress(pool) || (await read("entrypoint")) !== getAddress(entrypoint) || (await read("token")) !== getAddress(token))
      fail(`Pool router ${r} is not bound to the expected pool, entrypoint and token.`);
    console.log(`  ✓ bound to pool ${getAddress(pool)}, entrypoint ${getAddress(entrypoint)}, token ${getAddress(token)}`);
    env.push(`${prefix}_POOL_ROUTER_ADDRESS=${r}`);
  }
  if (env.length === 0) fail(`Nothing to deploy. Set DEPLOY to a comma list of: announcer, token, router, pool, poolrouter.`);

  console.log("\nAdd to .env.local (and your hosting provider's env settings):\n");
  for (const l of env) console.log(`  ${l}`);
  console.log(
    "\nVerify source on Blockscout: contract page → Verify & Publish → Solidity (Standard JSON input),\n" +
      "compiler v0.8.23, using `standardJsonInput` from contracts/artifacts/<Contract>.json\n" +
      "(pool contracts: v0.8.28, contracts/artifacts/pool/<Contract>.json).\n" +
      "Then run: npm run contracts:verify",
  );
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
