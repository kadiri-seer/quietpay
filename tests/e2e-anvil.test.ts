/**
 * End-to-end test against a real EVM (anvil, run with Robinhood Chain Testnet's chain ID 46630).
 * Exercises the exact library code the UI uses: deploy -> create link -> validate -> preflight ->
 * pay -> announce -> duplicate-payment block -> scan -> match -> gas top-up -> sweep.
 *
 * Skips automatically if the anvil binary (devDependency @foundry-rs/anvil) is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS, type NetworkConfig, type NetworkKey } from "@/config/networks";
import { mockTokenFaucetAbi, erc20Abi } from "@/config/contracts";
import { createPaymentRequest } from "@/lib/request";
import { validatePaymentLink } from "@/lib/link";
import { deriveStealthPayment } from "@/lib/stealth";
import { confirmAnnouncement, confirmPayment, newPayerRecord, preflight, submitAnnouncement, submitPayment } from "@/lib/payer";
import { fetchAnnouncementsForRequests, markClaimed, scanRequest, stealthBalances, sweepStealthPayment, estimateSweepCost } from "@/lib/receive";
import { verifyAnnouncer, verifyToken, VerificationError } from "@/lib/chain";
import { requestStatus } from "@/lib/vault";

const ROOT = join(__dirname, "..");
const ANVIL = join(ROOT, "node_modules", "@foundry-rs", "anvil", "bin.mjs");
const PORT = 8545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;

// Anvil dev key #0 (pre-funded) and a throwaway recipient key funded in beforeAll. Test-only.
const PAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RECIPIENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a3412f4603b6b78690d";

const art = (n: string) => JSON.parse(readFileSync(join(ROOT, "contracts", "artifacts", `${n}.json`), "utf8"));

let anvil: ChildProcess | undefined;
let client: PublicClient;
let payerWallet: WalletClient;
let recipientWallet: WalletClient;
let network: NetworkConfig;
let networks: Record<NetworkKey, NetworkConfig>;

const hasAnvil = existsSync(ANVIL);

async function deploy(wallet: WalletClient, name: string): Promise<Address> {
  const a = art(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode as Hex, account: wallet.account!, chain: network.chain });
  const r = await client.waitForTransactionReceipt({ hash });
  return r.contractAddress!;
}

describe.skipIf(!hasAnvil)("end-to-end on a local EVM", () => {
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
    payerWallet = createWalletClient({ account: privateKeyToAccount(PAYER_KEY), chain: network.chain, transport: http(RPC) });
    recipientWallet = createWalletClient({ account: privateKeyToAccount(RECIPIENT_KEY), chain: network.chain, transport: http(RPC) });

    const announcer = await deploy(payerWallet, "ERC5564Announcer");
    const token = await deploy(payerWallet, "QuietPayTestUSDG");
    network = { ...network, announcer, token };
    networks = { testnet: network, mainnet: NETWORKS.mainnet };

    const h = await payerWallet.writeContract({
      address: token,
      abi: mockTokenFaucetAbi,
      functionName: "faucet",
      args: [1_000_000_000n],
      account: payerWallet.account!,
      chain: network.chain,
    });
    await client.waitForTransactionReceipt({ hash: h });
    const fund = await payerWallet.sendTransaction({
      to: recipientWallet.account!.address,
      value: parseEther("1"),
      account: payerWallet.account!,
      chain: network.chain,
    });
    await client.waitForTransactionReceipt({ hash: fund });
  });

  afterAll(() => {
    anvil?.kill();
  });

  it("verifies deployed token and announcer bytecode, and rejects impostors", async () => {
    const t = await verifyToken(client, network);
    expect(t).toMatchObject({ symbol: "tUSDG", decimals: 6, isMock: true });
    await expect(verifyAnnouncer(client, network)).resolves.toMatchObject({ address: network.announcer });
    // Pointing the announcer at the token contract must fail bytecode verification.
    await expect(verifyAnnouncer(client, { ...network, announcer: network.token })).rejects.toBeInstanceOf(VerificationError);
    // An address without code must fail.
    await expect(verifyToken(client, { ...network, token: "0x000000000000000000000000000000000000dEaD" })).rejects.toThrow(/No contract/);
  });

  it("runs create -> pay -> announce -> scan -> claim", async () => {
    const payer = payerWallet.account!.address;
    const recipient = recipientWallet.account!.address;
    const amount = 12_340_000n; // 12.34 tUSDG

    // Recipient creates a request with fresh keys.
    const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
    const req = createPaymentRequest({
      chainId: network.chain.id,
      token: network.token!,
      amount,
      decimals: 6,
      symbol: "tUSDG",
      expirySeconds: 3600,
      fromBlock,
    });

    // Payer validates the link before connecting a wallet.
    const { request } = validatePaymentLink(req.link, { networks });
    expect(request.amount).toBe(amount);

    const derivation = deriveStealthPayment(request.stealthMetaAddress);
    const pf = await preflight(client, { network, request, payer, derivation, scanFromBlock: fromBlock });
    expect(pf.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(pf.ok).toBe(true);

    // Payment (transaction 1) with onchain Transfer verification.
    const rec = newPayerRecord(request, payer, derivation, network.token!);
    const payHash = await submitPayment(payerWallet, { network, token: network.token!, stealthAddress: derivation.stealthAddress, amount });
    await confirmPayment(client, payHash, { network, token: network.token!, stealthAddress: derivation.stealthAddress, amount, payer });

    // Before the announcement, the recipient cannot discover the payment.
    {
      const { anns, toBlock } = await fetchAnnouncementsForRequests(client, network, [req]);
      const r = await scanRequest(client, network, req, anns, toBlock);
      expect(r.request.payments).toHaveLength(0);
    }

    // Announcement (transaction 2), separately retryable.
    const annHash = await submitAnnouncement(payerWallet, {
      network,
      stealthAddress: rec.stealthAddress,
      ephemeralPublicKey: rec.ephemeralPublicKey,
      metadata: rec.metadata,
    });
    await confirmAnnouncement(client, annHash, { network, stealthAddress: rec.stealthAddress });

    // A second payer for the same link is blocked by one-time enforcement.
    const pf2 = await preflight(client, { network, request, payer, derivation: deriveStealthPayment(request.stealthMetaAddress), scanFromBlock: fromBlock });
    expect(pf2.ok).toBe(false);
    expect(pf2.checks.find((c) => c.id === "unpaid")?.status).toBe("fail");

    // An unrelated announcement (someone else's request) must not match.
    const other = createPaymentRequest({ chainId: network.chain.id, token: network.token!, amount, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock });

    // Recipient scans locally and matches with the viewing key.
    const { anns, toBlock } = await fetchAnnouncementsForRequests(client, network, [req, other]);
    expect(anns.length).toBe(1);
    const scanned = await scanRequest(client, network, req, anns, toBlock);
    expect((await scanRequest(client, network, other, anns, toBlock)).request.payments).toHaveLength(0);
    expect(scanned.newPayments).toBe(1);
    const payment = scanned.request.payments[0];
    expect(payment.stealthAddress).toBe(derivation.stealthAddress);
    expect(payment.transferVerified).toBe(true);
    expect(payment.receivedAmount).toBe(amount.toString());
    expect(requestStatus(scanned.request)).toBe("claimable");

    // Claim fails without gas; never auto-funded.
    await expect(sweepStealthPayment(client, network, { request: scanned.request, payment, to: recipient })).rejects.toThrow(/needs a little ETH/);

    // Manual gas top-up from the recipient wallet, then sweep.
    const est = await estimateSweepCost(client, network.token!, payment.stealthAddress, recipient, amount);
    const topUp = await recipientWallet.sendTransaction({
      to: payment.stealthAddress,
      value: est.cost + parseEther("0.0001"),
      account: recipientWallet.account!,
      chain: network.chain,
    });
    await client.waitForTransactionReceipt({ hash: topUp });

    const before = await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
    const swept = await sweepStealthPayment(client, network, { request: scanned.request, payment, to: recipient });
    expect(swept.amount).toBe(amount);
    const after = await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
    expect(after - before).toBe(amount);
    expect((await stealthBalances(client, network.token!, payment.stealthAddress)).token).toBe(0n);

    const claimed = markClaimed(scanned.request, payment.stealthAddress, swept.hash, recipient);
    expect(requestStatus(claimed)).toBe("claimed");
  });

  it("reports insufficient balance and gas in preflight without sending anything", async () => {
    const poor = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
    const req = createPaymentRequest({ chainId: network.chain.id, token: network.token!, amount: 5_000_000n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock });
    const { request } = validatePaymentLink(req.link, { networks });
    const pf = await preflight(client, { network, request, payer: poor.address, derivation: deriveStealthPayment(request.stealthMetaAddress), scanFromBlock: fromBlock });
    expect(pf.ok).toBe(false);
    expect(pf.checks.find((c) => c.id === "balance")?.status).toBe("fail");
  });
});
