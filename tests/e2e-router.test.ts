/**
 * End-to-end on a local EVM (anvil, chain ID 46630) for the router flow and reusable links:
 *  - one-transaction payment with a gas stipend, so the recipient claims with NO top-up
 *  - partial sends out of a payment, then the rest
 *  - reusable "any amount" links paid twice, unlinkable metadata, no one-time blocking
 *  - router safety checks
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
import { fetchAnnouncementsForRequests, recordSend, scanRequest, sendFromStealthPayment, stealthBalances } from "@/lib/receive";
import { verifyRouter, VerificationError } from "@/lib/chain";
import { requestStatus } from "@/lib/vault";

const ROOT = join(__dirname, "..");
const ANVIL = join(ROOT, "node_modules", "@foundry-rs", "anvil", "bin.mjs");
const PORT = 9545 + Math.floor(Math.random() * 1000);
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
  // The router leaves no lingering allowance (exact approval was fully used).
  const left = await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "allowance", args: [from, network.router!] });
  expect(left).toBe(0n);
  return { rec, amount, stipend: pf.stipend, request };
}

describe.skipIf(!existsSync(ANVIL))("router payments and reusable links on a local EVM", () => {
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

  it("verifies the router bytecode and rejects impostors", async () => {
    await expect(verifyRouter(client, network)).resolves.toMatchObject({ address: network.router });
    await expect(verifyRouter(client, { ...network, router: network.token })).rejects.toBeInstanceOf(VerificationError);
    await expect(verifyRouter(client, { ...network, router: null })).resolves.toBeNull();
  });

  it("pays a fixed link in one transaction; the recipient moves funds with no gas top-up", async () => {
    const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
    const req = createPaymentRequest({ chainId: 46630, token: network.token!, amount: 40_000_000n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock });
    const { rec, stipend } = await routedPay(req.link);

    // The one-time address received both the tokens and the gas stipend, nothing from the recipient.
    const bal = await stealthBalances(client, network.token!, rec.stealthAddress);
    expect(bal.token).toBe(40_000_000n);
    expect(bal.eth).toBe(stipend);

    // Fixed links include the request ID, so a second payer is blocked.
    const again = validatePaymentLink(req.link, { networks }).request;
    const pf2 = await preflight(client, { network, request: again, payer: payer.account!.address, derivation: deriveStealthPayment(again.stealthMetaAddress), scanFromBlock: fromBlock });
    expect(pf2.checks.find((c) => c.id === "unpaid")?.status).toBe("fail");

    // Recipient scans and finds it.
    const { anns, toBlock } = await fetchAnnouncementsForRequests(client, network, [req]);
    const scanned = await scanRequest(client, network, req, anns, toBlock);
    const payment = scanned.request.payments[0];
    expect(payment.transferVerified).toBe(true);
    expect(requestStatus(scanned.request)).toBe("claimable");

    // Partial send to a fresh address, using only the stipend for gas.
    const fresh1 = privateKeyToAccount(generatePrivateKey()).address;
    const fresh2 = privateKeyToAccount(generatePrivateKey()).address;
    const s1 = await sendFromStealthPayment(client, network, { request: scanned.request, payment, to: fresh1, amount: 15_000_000n });
    expect(s1.remaining).toBe(25_000_000n);
    let updated = recordSend(scanned.request, payment.stealthAddress, { tx: s1.hash, to: fresh1, amount: s1.amount }, s1.remaining);
    expect(requestStatus(updated)).toBe("claimable");
    expect(updated.payments[0].claimTx).toBeUndefined();

    // Send the rest; still no top-up.
    const s2 = await sendFromStealthPayment(client, network, { request: updated, payment: updated.payments[0], to: fresh2 });
    expect(s2.amount).toBe(25_000_000n);
    expect(s2.remaining).toBe(0n);
    updated = recordSend(updated, payment.stealthAddress, { tx: s2.hash, to: fresh2, amount: s2.amount }, s2.remaining);
    expect(requestStatus(updated)).toBe("claimed");
    expect(updated.payments[0].sends).toHaveLength(2);

    const b1 = await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [fresh1] });
    const b2 = await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [fresh2] });
    expect([b1, b2]).toEqual([15_000_000n, 25_000_000n]);
  });

  it("lets a reusable link be paid any amount, many times, without grouping payments onchain", async () => {
    const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
    const req = createPaymentRequest({ kind: "open", chainId: 46630, token: network.token!, amount: 0n, decimals: 6, symbol: "tUSDG", expirySeconds: 0, fromBlock });
    expect(validatePaymentLink(req.link, { networks }).request).toMatchObject({ kind: "open", amount: 0n, expiresAt: 0 });

    const p1 = await routedPay(req.link, 10_000_000n);
    const p2 = await routedPay(req.link, 2_500_000n); // a second payment is allowed
    expect(p1.rec.stealthAddress).not.toBe(p2.rec.stealthAddress);

    const { anns, toBlock } = await fetchAnnouncementsForRequests(client, network, [req]);
    const mine = anns.filter((a) => [p1.rec.stealthAddress, p2.rec.stealthAddress].includes(a.stealthAddress));
    expect(mine).toHaveLength(2);
    // No request ID in the public metadata: observers cannot tell these went to the same link.
    for (const a of mine) expect(parsePaymentMetadata(a.metadata).requestId).toBeNull();

    const scanned = await scanRequest(client, network, req, anns, toBlock);
    expect(scanned.newPayments).toBe(2);
    const amounts = scanned.request.payments.map((p) => p.receivedAmount).sort();
    expect(amounts).toEqual(["10000000", "2500000"].sort());
    expect(requestStatus(scanned.request)).toBe("claimable");
  });

  it("rejects an oversized stipend and refuses payments without approval", async () => {
    const derivation = deriveStealthPayment(createPaymentRequest({ chainId: 46630, token: network.token!, amount: 1n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock: 0n }).keys.stealthMetaAddress);
    const call = (value: bigint, amount: bigint) =>
      client.simulateContract({
        address: network.router!,
        abi: routerAbi,
        functionName: "pay",
        args: [network.token!, network.announcer!, derivation.stealthAddress, amount, derivation.ephemeralPublicKey, "0x00"],
        value,
        account: payer.account!.address,
      });
    await expect(call(MAX_GAS_STIPEND + 1n, 1n)).rejects.toThrow(/StipendTooLarge|revert/);
    await expect(call(0n, 999_999_999_999n)).rejects.toThrow(/TokenTransferFailed|revert/);
    await expect(call(0n, 0n)).rejects.toThrow(/ZeroAmount|revert/);
    const bal = await client.getBalance({ address: network.router! });
    expect(bal).toBe(0n); // the router never holds funds
    void parseEther;
  });
});
