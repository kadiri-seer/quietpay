/**
 * Recovery from the wallet alone, on a local EVM: links made with wallet-derived keys are found
 * again on a "new device" (empty vault) by scanning the chain, including a link several numbers
 * past the last paid one, and their funds can be moved. No backup file is involved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { NETWORKS, type NetworkConfig, type NetworkKey } from "@/config/networks";
import { erc20Abi, mockTokenFaucetAbi, routerAbi } from "@/config/contracts";
import { createPaymentRequest } from "@/lib/request";
import { validatePaymentLink } from "@/lib/link";
import { deriveStealthPayment } from "@/lib/stealth";
import { parsePaymentMetadata } from "@/lib/metadata";
import {
  approveRouterIfNeeded,
  confirmRoutedPayment,
  newPayerRecord,
  preflight,
  submitRoutedPayment,
  MAX_GAS_STIPEND,
} from "@/lib/payer";
import { discoverLinks, fetchAnnouncementsForRequests, scanRequest, sendFromStealthPayment } from "@/lib/receive";
import { deriveLinkKeys, deriveLinkSeed } from "@/lib/link-keys";
import { verifyRouter, VerificationError } from "@/lib/chain";
import { requestStatus } from "@/lib/vault";

const ROOT = join(__dirname, "..");
const ANVIL = join(ROOT, "node_modules", "@foundry-rs", "anvil", "bin.mjs");
const PORT = 11545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const PAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const art = (n: string) => JSON.parse(readFileSync(join(ROOT, "contracts", "artifacts", `${n}.json`), "utf8"));

let anvil: ChildProcess | undefined;
let client: PublicClient;
let payer: WalletClient;
let network: NetworkConfig;
let networks: Record<NetworkKey, NetworkConfig>;

async function deploy(name: string): Promise<Address> {
  const a = art(name);
  const hash = await payer.deployContract({ abi: a.abi, bytecode: a.bytecode as Hex, account: payer.account!, chain: network.chain });
  return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
}

async function routedPay(link: string, chosen?: bigint) {
  const { request } = validatePaymentLink(link, { networks });
  const derivation = deriveStealthPayment(request.stealthMetaAddress);
  const from = payer.account!.address;
  const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
  const pf = await preflight(client, { network, request, amount: chosen, payer: from, derivation, scanFromBlock: fromBlock > 50n ? fromBlock - 50n : 0n });
  expect(pf.checks.filter((c) => c.status === "fail")).toEqual([]);
  expect(pf.mode).toBe("router");
  expect(pf.stipend).toBeGreaterThan(0n);
  expect(pf.stipend).toBeLessThanOrEqual(MAX_GAS_STIPEND);
  const rec = newPayerRecord(request, from, derivation, network.token!, { amount: chosen, mode: pf.mode, stipend: pf.stipend });
  const amount = BigInt(rec.amount!);
  await approveRouterIfNeeded(payer, client, { network, token: network.token!, owner: from, amount });
  const hash = await submitRoutedPayment(payer, {
    network,
    token: network.token!,
    stealthAddress: rec.stealthAddress,
    amount,
    ephemeralPublicKey: rec.ephemeralPublicKey,
    metadata: rec.metadata,
    stipend: pf.stipend,
  });
  await confirmRoutedPayment(client, hash, { network, token: network.token!, stealthAddress: rec.stealthAddress, amount, payer: from });
  // The first payment allows the router once, for any amount, so later payments are one
  // confirmation. The router only moves tokens of whoever calls it.
  const left = await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "allowance", args: [from, network.router!] });
  expect(left).toBeGreaterThan(10n ** 60n);
  return { rec, amount, stipend: pf.stipend, request };
}

describe.skipIf(!existsSync(ANVIL))("recovering links from the wallet on a new device", () => {
  beforeAll(async () => {
    anvil = spawn(process.execPath, [ANVIL, "--port", String(PORT), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
    network = { ...NETWORKS.testnet, rpcUrl: RPC, chain: { ...NETWORKS.testnet.chain, rpcUrls: { default: { http: [RPC] } } }, confirmations: 1, logChunkSize: 1000n };
    client = createPublicClient({ chain: network.chain, transport: http(RPC) }) as PublicClient;
    for (let i = 0; i < 50; i++) {
      try {
        await client.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    payer = createWalletClient({ account: privateKeyToAccount(PAYER_KEY), chain: network.chain, transport: http(RPC) });
    const announcer = await deploy("ERC5564Announcer");
    const token = await deploy("QuietPayTestUSDG");
    const router = await deploy("QuietPayRouter");
    network = { ...network, announcer, token, router };
    networks = { testnet: network, mainnet: NETWORKS.mainnet };
    const h = await payer.writeContract({ address: token, abi: mockTokenFaucetAbi, functionName: "faucet", args: [5_000_000_000n], account: payer.account!, chain: network.chain });
    await client.waitForTransactionReceipt({ hash: h });
  });
  afterAll(() => anvil?.kill());

  it("finds every paid link and its money from the wallet signature alone", async () => {
    const sig = `0x${"5a".repeat(65)}` as Hex;
    const seed = await deriveLinkSeed(sig, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const tokenInfo = { address: network.token!, decimals: 6, symbol: "tUSDG" };
    const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
    // Device A makes links 0..5. Links 0 (fixed) and 5 (reusable, paid twice) get paid; 1-4 never are.
    const links = [];
    for (let i = 0; i < 6; i++) {
      links.push(
        createPaymentRequest({
          kind: i === 5 ? "open" : "fixed",
          chainId: 46630,
          token: network.token!,
          amount: i === 5 ? 0n : 12_000_000n,
          decimals: 6,
          symbol: "tUSDG",
          expirySeconds: i === 5 ? 0 : 3600,
          fromBlock,
          keys: await deriveLinkKeys(seed, 46630, i),
          index: i,
        }),
      );
    }
    await routedPay(links[0].link);
    await routedPay(links[5].link, 3_000_000n);
    await routedPay(links[5].link, 4_000_000n);

    // Device B: empty vault, same wallet signature.
    const d = await discoverLinks(client, network, { seed, nextLinkIndex: 0, known: [], token: tokenInfo, fullHistory: true });
    expect(d.found.map((r) => r.index).sort()).toEqual([0, 5]);
    expect(d.nextLinkIndex).toBe(6);
    const fixed = d.found.find((r) => r.index === 0)!;
    const open = d.found.find((r) => r.index === 5)!;
    expect(fixed).toMatchObject({ kind: "fixed", id: links[0].id.toLowerCase(), recovered: true });
    expect(open).toMatchObject({ kind: "open", recovered: true });

    const s0 = await scanRequest(client, network, fixed, d.anns, d.toBlock);
    const s5 = await scanRequest(client, network, open, d.anns, d.toBlock);
    expect(s0.request.payments.map((p) => p.receivedAmount)).toEqual(["12000000"]);
    expect(s5.request.payments.map((p) => p.receivedAmount).sort()).toEqual(["3000000", "4000000"]);

    // The recovered keys really control the money.
    const fresh = privateKeyToAccount(generatePrivateKey()).address;
    const sent = await sendFromStealthPayment(client, network, { request: s0.request, payment: s0.request.payments[0], to: fresh });
    expect(sent.amount).toBe(12_000_000n);
    expect(await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [fresh] })).toBe(12_000_000n);

    // A device that already knows its links finds nothing new, and keeps its numbering.
    const again = await discoverLinks(client, network, { seed, nextLinkIndex: 6, known: [s0.request, s5.request], token: tokenInfo, fullHistory: true });
    expect(again.found).toHaveLength(0);
    expect(again.nextLinkIndex).toBe(6);

    // A different wallet finds nothing.
    const stranger = await deriveLinkSeed(sig, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    expect((await discoverLinks(client, network, { seed: stranger, nextLinkIndex: 0, known: [], token: tokenInfo, fullHistory: true })).found).toHaveLength(0);
  });

  it("keeps a fixed link's payments to itself when two links share keys", async () => {
    const seed = await deriveLinkSeed(`0x${"6b".repeat(65)}` as Hex, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const keys = await deriveLinkKeys(seed, 46630, 0);
    const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
    // Two devices made link 0 with different settings before either saw the other.
    const a = createPaymentRequest({ chainId: 46630, token: network.token!, amount: 5_000_000n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock, keys, index: 0 });
    const b = createPaymentRequest({ chainId: 46630, token: network.token!, amount: 6_000_000n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock, keys, index: 0 });
    await routedPay(a.link);
    const { anns, toBlock } = await fetchAnnouncementsForRequests(client, network, [a, b]);
    expect((await scanRequest(client, network, a, anns, toBlock)).request.payments).toHaveLength(1);
    expect((await scanRequest(client, network, b, anns, toBlock)).request.payments).toHaveLength(0);
  });
});
