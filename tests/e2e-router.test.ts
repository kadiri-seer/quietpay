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
import { announcerAbi, erc20Abi, mockTokenFaucetAbi, routerV2Abi } from "@/config/contracts";
import { createPaymentRequest } from "@/lib/request";
import { validatePaymentLink } from "@/lib/link";
import { deriveStealthPayment } from "@/lib/stealth";
import { buildPaymentMetadata, parsePaymentMetadata } from "@/lib/metadata";
import {
  approveRouterIfNeeded,
  confirmRoutedPayment,
  findUnrecordedPayment,
  newPayerRecord,
  preflight,
  submitRoutedPayment,
  checkStealthDestination,
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

async function deploy(name: string, args: unknown[] = []): Promise<Address> {
  const a = art(name);
  const hash = await payer.deployContract({ abi: a.abi, bytecode: a.bytecode as Hex, args, account: payer.account!, chain: network.chain });
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
    routerVersion: pf.routerVersion,
    requestId: request.kind === "fixed" ? request.requestId : null,
  });
  await confirmRoutedPayment(client, hash, { network, token: network.token!, stealthAddress: rec.stealthAddress, amount, payer: from });
  // The first payment allows the router once, for any amount, so later payments are one
  // confirmation. The router only moves tokens of whoever calls it.
  const left = await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "allowance", args: [from, network.router!] });
  expect(left).toBeGreaterThan(10n ** 60n);
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
    // The app pays only through router v2/v3 (v1 is retired).
    const router = await deploy("QuietPayRouterV3", [token, announcer]);
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
    await expect(verifyRouter(client, network)).resolves.toMatchObject({ version: 3 });
    // The retired v1 router is refused, never used as a fallback.
    const v1 = await deploy("QuietPayRouter");
    await expect(verifyRouter(client, { ...network, router: v1 })).rejects.toThrow(/retired v1/);
    await expect(
      submitRoutedPayment(payer, { network, token: network.token!, stealthAddress: payer.account!.address, amount: 1n, ephemeralPublicKey: "0x02", metadata: "0x00", stipend: 0n, routerVersion: 1 as unknown as 2 }),
    ).rejects.toThrow(/v2 or v3/);
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

  it("a fake announcement can't block a one-time link", async () => {
    const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
    const req = createPaymentRequest({ chainId: 46630, token: network.token!, amount: 25_000_000n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock });
    const request = validatePaymentLink(req.link, { networks }).request;
    // Someone holding the link announces a "payment" with its ID but sends nothing.
    const d = deriveStealthPayment(request.stealthMetaAddress);
    const meta = buildPaymentMetadata({ viewTag: d.viewTag, token: network.token!, amount: request.amount, requestId: request.requestId });
    const h = await payer.writeContract({ address: network.announcer!, abi: announcerAbi, functionName: "announce", args: [1n, d.stealthAddress, d.ephemeralPublicKey, meta], account: payer.account!, chain: network.chain });
    await client.waitForTransactionReceipt({ hash: h });
    // Payers still see it as unpaid...
    const pf = await preflight(client, { network, request, payer: payer.account!.address, derivation: deriveStealthPayment(request.stealthMetaAddress), scanFromBlock: fromBlock });
    expect(pf.checks.find((c) => c.id === "unpaid")?.status).toBe("ok");
    // ...until it is really paid.
    await routedPay(req.link);
    const pf2 = await preflight(client, { network, request, payer: payer.account!.address, derivation: deriveStealthPayment(request.stealthMetaAddress), scanFromBlock: fromBlock });
    expect(pf2.checks.find((c) => c.id === "unpaid")?.status).toBe("fail");
  });

  it("finds a payment whose transaction the browser never saw, so it isn't paid twice", async () => {
    const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
    const req = createPaymentRequest({ chainId: 46630, token: network.token!, amount: 12_000_000n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock });
    const { rec, request } = await routedPay(req.link);
    // The record still says "created": the tab closed before the wallet returned the hash.
    expect(rec.machine.paymentSubmitted).toBe(false);
    const found = await findUnrecordedPayment(client, network, rec);
    expect(found?.announced).toBe(true);
    expect(found?.hash).toMatch(/^0x[0-9a-f]{64}$/);
    // An attempt that never reached the chain finds nothing.
    const other = newPayerRecord(request, payer.account!.address, deriveStealthPayment(request.stealthMetaAddress), network.token!, {});
    expect(await findUnrecordedPayment(client, network, other)).toBeNull();
  });

  it("rejects an oversized stipend and refuses payments without approval", async () => {
    const derivation = deriveStealthPayment(createPaymentRequest({ chainId: 46630, token: network.token!, amount: 1n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock: 0n }).keys.stealthMetaAddress);
    const meta = (amount: bigint) => buildPaymentMetadata({ viewTag: derivation.viewTag, token: network.token!, amount });
    const call = (value: bigint, amount: bigint) =>
      client.simulateContract({
        address: network.router!,
        abi: routerV2Abi,
        functionName: "pay",
        args: [derivation.stealthAddress, amount, derivation.ephemeralPublicKey, meta(amount)],
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

  it("v3 refuses destinations tokens could never leave, atomically; real one-time addresses still work", async () => {
    const d = deriveStealthPayment(createPaymentRequest({ chainId: 46630, token: network.token!, amount: 1n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock: 0n }).keys.stealthMetaAddress);
    const amount = 1_000_000n;
    await approveRouterIfNeeded(payer, client, { network, token: network.token!, owner: payer.account!.address, amount });
    const meta = buildPaymentMetadata({ viewTag: d.viewTag, token: network.token!, amount });
    const tokenBefore = await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [payer.account!.address] });
    for (const bad of [network.router!, network.token!, network.announcer!, "0x0000000000000000000000000000000000000000" as Address]) {
      await expect(
        client.simulateContract({ address: network.router!, abi: routerV2Abi, functionName: "pay", args: [bad, amount, d.ephemeralPublicKey, meta], account: payer.account!.address }),
      ).rejects.toThrow(/BadDestination|ZeroAddress|revert/);
      // The app refuses them before asking the wallet, too.
      expect(() => checkStealthDestination(network, network.token!, bad)).toThrow(/invalid/);
    }
    // Nothing moved, nothing is held by the router.
    expect(await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [payer.account!.address] })).toBe(tokenBefore);
    expect(await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [network.router!] })).toBe(0n);
    // A real one-time address is accepted.
    const ok = await client.simulateContract({ address: network.router!, abi: routerV2Abi, functionName: "pay", args: [d.stealthAddress, amount, d.ephemeralPublicKey, meta], account: payer.account!.address });
    expect(ok.request.functionName).toBe("pay");
  });
});
