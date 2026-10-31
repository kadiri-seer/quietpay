/**
 * Deploys QuietPay's contracts to Robinhood Chain Testnet (chain ID 46630):
 *   - ERC5564Announcer (ScopeLift, CC0) — required for stealth announcements
 *   - QuietPayTestUSDG (MOCK, worthless) — only because no verified testnet USDG exists
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npm run contracts:deploy
 *   DEPLOYER_PRIVATE_KEY=0x... DEPLOY=announcer npm run contracts:deploy   # announcer only
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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

  async function deploy(name: string) {
    const a = artifact(name);
    console.log(`\nDeploying ${name} (${a.compiler})…`);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode });
    console.log(`  tx ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success" || !receipt.contractAddress) fail(`${name} deployment failed.`);
    const code = await client.getCode({ address: receipt.contractAddress });
    if (!code || keccak256(code) !== a.runtimeCodeHash) fail(`${name} runtime code hash mismatch at ${receipt.contractAddress}.`);
    console.log(`  ✓ ${name} at ${receipt.contractAddress} (block ${receipt.blockNumber}), runtime code hash verified`);
    return receipt.contractAddress;
  }

  if (what.includes("announcer")) env.push(`${prefix}_ANNOUNCER_ADDRESS=${await deploy("ERC5564Announcer")}`);
  if (what.includes("token")) env.push(`${prefix}_TOKEN_ADDRESS=${await deploy("QuietPayTestUSDG")}`);

  console.log("\nAdd to .env.local (and your hosting provider's env settings):\n");
  for (const l of env) console.log(`  ${l}`);
  console.log(
    "\nVerify source on Blockscout: contract page → Verify & Publish → Solidity (Standard JSON input),\n" +
      "compiler v0.8.23, using `standardJsonInput` from contracts/artifacts/<Contract>.json.\n" +
      "Then run: npm run contracts:verify",
  );
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
