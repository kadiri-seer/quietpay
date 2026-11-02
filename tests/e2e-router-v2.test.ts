/**
 * Router v2 on a local EVM, including hostile tokens and recipients:
 * fixed token and announcer, onchain one-time links (also under concurrent payers), announcement
 * metadata that must match the transfer, exact-amount delivery, reentrancy and atomicity.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { NETWORKS, type NetworkConfig, type NetworkKey } from "@/config/networks";
import { announcerAbi, erc20Abi, mockTokenFaucetAbi, routerV2Abi } from "@/config/contracts";
import { createPaymentRequest } from "@/lib/request";
import { validatePaymentLink } from "@/lib/link";
import { deriveStealthPayment } from "@/lib/stealth";
import { buildPaymentMetadata } from "@/lib/metadata";
import { approveRouterIfNeeded, confirmRoutedPayment, newPayerRecord, preflight, submitRoutedPayment } from "@/lib/payer";
import { verifyRouter, VerificationError } from "@/lib/chain";

const ROOT = join(__dirname, "..");
const ANVIL = join(ROOT, "node_modules", "@foundry-rs", "anvil", "bin.mjs");
const PORT = 9545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const PAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PAYER2_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const art = (n: string) => JSON.parse(readFileSync(join(ROOT, "contracts", "artifacts", `${n}.json`), "utf8"));
const V2 = art("QuietPayRouterV2");

let anvil: ChildProcess | undefined;
let client: PublicClient;
let payer: WalletClient;
let payer2: WalletClient;
let network: NetworkConfig;
let networks: Record<NetworkKey, NetworkConfig>;

async function deploy(name: string, args: unknown[] = [], from: WalletClient = payer): Promise<Address> {
  const a = name.startsWith("test/") ? art(name) : art(name);
  const hash = await from.deployContract({ abi: a.abi, bytecode: a.bytecode as Hex, args, account: from.account!, chain: network.chain });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`deploy ${name} failed`);
  return r.contractAddress!;
}
const send = async (w: WalletClient, p: Parameters<WalletClient["writeContract"]>[0]) => client.waitForTransactionReceipt({ hash: await w.writeContract(p) });

/** A valid stealth payment for `meta` (keys), with metadata for `token`/`amount` and optional request ID. */
function payment(token: Address, amount: bigint, requestId: Hex | null = null) {
  const req = createPaymentRequest({ chainId: 46630, token, amount: 1_000_000n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock: 0n });
  const d = deriveStealthPayment(req.keys.stealthMetaAddress);
  return { d, metadata: buildPaymentMetadata({ viewTag: d.viewTag, token, amount, requestId }) };
}
const rid = (): Hex => `0x${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

describe.skipIf(!existsSync(ANVIL))("router v2 on a local EVM", () => {
  let router: Address;
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
    payer2 = createWalletClient({ account: privateKeyToAccount(PAYER2_KEY), chain: network.chain, transport: http(RPC) });
    const announcer = await deploy("ERC5564Announcer");
    const token = await deploy("QuietPayTestUSDG");
    router = await deploy("QuietPayRouterV2", [token, announcer]);
    network = { ...network, announcer, token, router };
    networks = { testnet: network, mainnet: NETWORKS.mainnet };
    for (const w of [payer, payer2]) await send(w, { address: token, abi: mockTokenFaucetAbi, functionName: "faucet", args: [5_000_000_000n], account: w.account!, chain: network.chain });
  });
  afterAll(() => anvil?.kill());

  it("can only be deployed for real token and announcer contracts", async () => {
    const eoa = privateKeyToAccount(generatePrivateKey()).address;
    await expect(deploy("QuietPayRouterV2", [eoa, network.announcer])).rejects.toThrow();
    await expect(deploy("QuietPayRouterV2", [network.token, "0x0000000000000000000000000000000000000000"])).rejects.toThrow();
  });

  it("is recognised as v2 and only for this network's token and announcer", async () => {
    await expect(verifyRouter(client, network)).resolves.toMatchObject({ address: router, version: 2 });
    const otherToken = await deploy("QuietPayTestUSDG");
    await expect(verifyRouter(client, { ...network, token: otherToken })).rejects.toBeInstanceOf(VerificationError);
    const otherAnnouncer = await deploy("ERC5564Announcer");
    await expect(verifyRouter(client, { ...network, announcer: otherAnnouncer })).rejects.toBeInstanceOf(VerificationError);
    expect(getAddress(await client.readContract({ address: router, abi: routerV2Abi, functionName: "token" }))).toBe(getAddress(network.token!));
  });

  it("pays a one-time link once, and refuses a second payment onchain", async () => {
    const fromBlock = await client.getBlockNumber();
    const req = createPaymentRequest({ chainId: 46630, token: network.token!, amount: 7_000_000n, decimals: 6, symbol: "tUSDG", expirySeconds: 3600, fromBlock });
    const { request } = validatePaymentLink(req.link, { networks });
    const from = payer.account!.address;
    const d = deriveStealthPayment(request.stealthMetaAddress);
    const pf = await preflight(client, { network, request, payer: from, derivation: d, scanFromBlock: fromBlock });
    expect(pf.routerVersion).toBe(2);
    expect(pf.checks.filter((c) => c.status === "fail")).toEqual([]);
    const rec = newPayerRecord(request, from, d, network.token!, { mode: "router", stipend: pf.stipend });
    await approveRouterIfNeeded(payer, client, { network, token: network.token!, owner: from, amount: request.amount });
    const hash = await submitRoutedPayment(payer, {
      network, token: network.token!, stealthAddress: rec.stealthAddress, amount: request.amount, ephemeralPublicKey: rec.ephemeralPublicKey,
      metadata: rec.metadata, stipend: pf.stipend, routerVersion: 2, requestId: request.requestId,
    });
    await confirmRoutedPayment(client, hash, { network, token: network.token!, stealthAddress: rec.stealthAddress, amount: request.amount, payer: from });
    expect(await client.readContract({ address: router, abi: routerV2Abi, functionName: "paidOnce", args: [request.requestId] })).toBe(true);

    // The app now says it's paid...
    const pf2 = await preflight(client, { network, request, payer: payer2.account!.address, derivation: deriveStealthPayment(request.stealthMetaAddress), scanFromBlock: fromBlock });
    expect(pf2.checks.find((c) => c.id === "unpaid")?.status).toBe("fail");
    // ...and the contract refuses even a payer who ignores the app.
    const again = deriveStealthPayment(request.stealthMetaAddress);
    const meta2 = buildPaymentMetadata({ viewTag: again.viewTag, token: network.token!, amount: request.amount, requestId: request.requestId });
    await approveRouterIfNeeded(payer2, client, { network, token: network.token!, owner: payer2.account!.address, amount: request.amount });
    await expect(
      client.simulateContract({ address: router, abi: V2.abi, functionName: "payOnce", args: [request.requestId, again.stealthAddress, request.amount, again.ephemeralPublicKey, meta2], account: payer2.account! }),
    ).rejects.toThrow(/AlreadyPaid/);
  });

  it("lets only one of two payers racing in the same block pay a one-time link", async () => {
    const id = rid();
    const amount = 3_000_000n;
    const a = payment(network.token!, amount, id);
    const b = payment(network.token!, amount, id);
    for (const w of [payer, payer2]) await approveRouterIfNeeded(w, client, { network, token: network.token!, owner: w.account!.address, amount });
    await client.request({ method: "evm_setAutomine" as never, params: [false] as never });
    try {
      const h1 = await payer.writeContract({ address: router, abi: V2.abi, functionName: "payOnce", args: [id, a.d.stealthAddress, amount, a.d.ephemeralPublicKey, a.metadata], account: payer.account!, chain: network.chain, gas: 400_000n });
      const h2 = await payer2.writeContract({ address: router, abi: V2.abi, functionName: "payOnce", args: [id, b.d.stealthAddress, amount, b.d.ephemeralPublicKey, b.metadata], account: payer2.account!, chain: network.chain, gas: 400_000n });
      await client.request({ method: "evm_mine" as never, params: [] as never });
      const [r1, r2] = await Promise.all([client.waitForTransactionReceipt({ hash: h1 }), client.waitForTransactionReceipt({ hash: h2 })]);
      expect([r1.status, r2.status].sort()).toEqual(["reverted", "success"]);
      expect(r1.blockNumber).toBe(r2.blockNumber);
      const got = await Promise.all([a, b].map((x) => client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [x.d.stealthAddress] })));
      expect(got.sort()).toEqual([0n, amount]); // only one payment moved money
    } finally {
      await client.request({ method: "evm_setAutomine" as never, params: [true] as never });
    }
  });

  it("refuses announcements that don't describe the transfer", async () => {
    const amount = 2_000_000n;
    await approveRouterIfNeeded(payer, client, { network, token: network.token!, owner: payer.account!.address, amount: amount * 10n });
    const sim = (fn: "pay" | "payOnce", args: unknown[]) => client.simulateContract({ address: router, abi: V2.abi, functionName: fn, args, account: payer.account! });
    const { d } = payment(network.token!, amount);
    const ok = buildPaymentMetadata({ viewTag: d.viewTag, token: network.token!, amount });
    await expect(sim("pay", [d.stealthAddress, amount, d.ephemeralPublicKey, ok])).resolves.toBeTruthy();
    // Wrong amount, wrong token, a request ID on a reusable payment, truncated metadata.
    await expect(sim("pay", [d.stealthAddress, amount, d.ephemeralPublicKey, buildPaymentMetadata({ viewTag: d.viewTag, token: network.token!, amount: amount + 1n })])).rejects.toThrow(/BadMetadata/);
    await expect(sim("pay", [d.stealthAddress, amount, d.ephemeralPublicKey, buildPaymentMetadata({ viewTag: d.viewTag, token: network.announcer!, amount })])).rejects.toThrow(/BadMetadata/);
    await expect(sim("pay", [d.stealthAddress, amount, d.ephemeralPublicKey, buildPaymentMetadata({ viewTag: d.viewTag, token: network.token!, amount, requestId: rid() })])).rejects.toThrow(/BadMetadata/);
    await expect(sim("pay", [d.stealthAddress, amount, d.ephemeralPublicKey, ok.slice(0, 40) as Hex])).rejects.toThrow(/BadMetadata/);
    // A one-time payment whose metadata names another request.
    const id = rid();
    await expect(sim("payOnce", [id, d.stealthAddress, amount, d.ephemeralPublicKey, buildPaymentMetadata({ viewTag: d.viewTag, token: network.token!, amount, requestId: rid() })])).rejects.toThrow(/BadMetadata/);
    await expect(sim("payOnce", ["0x00000000000000000000000000000000", d.stealthAddress, amount, d.ephemeralPublicKey, ok])).rejects.toThrow(/ZeroRequestId/);
    // Bad inputs.
    await expect(sim("pay", [d.stealthAddress, amount, `0x04${"11".repeat(32)}`, ok])).rejects.toThrow(/BadEphemeralKey/);
    await expect(sim("pay", ["0x0000000000000000000000000000000000000000", amount, d.ephemeralPublicKey, ok])).rejects.toThrow(/ZeroAddress/);
    const zero = buildPaymentMetadata({ viewTag: d.viewTag, token: network.token!, amount: 0n });
    await expect(sim("pay", [d.stealthAddress, 0n, d.ephemeralPublicKey, zero])).rejects.toThrow(/ZeroAmount/);
    await expect(
      client.simulateContract({ address: router, abi: V2.abi, functionName: "pay", args: [d.stealthAddress, amount, d.ephemeralPublicKey, ok], account: payer.account!, value: parseEther("0.0011") }),
    ).rejects.toThrow(/StipendTooLarge/);
  });

  describe("with hostile tokens", () => {
    let mock: Address;
    let mockRouter: Address;
    const MOCK = art("test/MockToken");
    beforeAll(async () => {
      mock = await deploy("test/MockToken");
      mockRouter = await deploy("QuietPayRouterV2", [mock, network.announcer]);
      await send(payer, { address: mock, abi: MOCK.abi, functionName: "mint", args: [payer.account!.address, 1_000_000_000n], account: payer.account!, chain: network.chain });
      await send(payer, { address: mock, abi: MOCK.abi, functionName: "approve", args: [mockRouter, 1_000_000_000n], account: payer.account!, chain: network.chain });
    });
    const tryPay = async (mode: number) => {
      await send(payer, { address: mock, abi: MOCK.abi, functionName: "setMode", args: [mode], account: payer.account!, chain: network.chain });
      const amount = 5_000_000n;
      const { d, metadata } = payment(mock, amount);
      const sim = client.simulateContract({ address: mockRouter, abi: V2.abi, functionName: "pay", args: [d.stealthAddress, amount, d.ephemeralPublicKey, metadata], account: payer.account! });
      return { sim, d, amount, metadata };
    };

    it("rejects a token that returns false", async () => {
      await expect((await tryPay(1)).sim).rejects.toThrow(/TokenTransferFailed/);
    });
    it("accepts a token that returns nothing but does transfer", async () => {
      await expect((await tryPay(2)).sim).resolves.toBeTruthy();
    });
    it("rejects fee-on-transfer and tokens that don't credit the recipient", async () => {
      await expect((await tryPay(3)).sim).rejects.toThrow(/AmountMismatch/);
      await expect((await tryPay(4)).sim).rejects.toThrow(/AmountMismatch/);
    });
    it("stops a token that tries to re-enter the router, and nothing moves", async () => {
      const inner = payment(mock, 1_000_000n);
      const reenter = encodeFunctionData({ abi: V2.abi, functionName: "pay", args: [inner.d.stealthAddress, 1_000_000n, inner.d.ephemeralPublicKey, inner.metadata] });
      await send(payer, { address: mock, abi: MOCK.abi, functionName: "setReenter", args: [mockRouter, reenter], account: payer.account!, chain: network.chain });
      const t = await tryPay(5);
      // The guard makes the inner call revert, so the token's transfer fails and so does the payment.
      await expect(t.sim).rejects.toThrow(/TokenTransferFailed|Reentrancy/);
      const bal = (await client.readContract({ address: mock, abi: MOCK.abi, functionName: "balanceOf", args: [t.d.stealthAddress] })) as bigint;
      expect(bal).toBe(0n);
    });
  });

  describe("with hostile recipients", () => {
    it("fails as a whole when the one-time address refuses the gas money: no tokens, no announcement", async () => {
      const rejecting = await deploy("test/RejectingReceiver");
      const amount = 1_000_000n;
      const { d } = payment(network.token!, amount);
      const meta = buildPaymentMetadata({ viewTag: d.viewTag, token: network.token!, amount });
      await approveRouterIfNeeded(payer, client, { network, token: network.token!, owner: payer.account!.address, amount });
      await expect(
        client.simulateContract({ address: router, abi: V2.abi, functionName: "pay", args: [rejecting, amount, d.ephemeralPublicKey, meta], account: payer.account!, value: 1000n }),
      ).rejects.toThrow(/StipendTransferFailed/);
      // Without gas money the same address can be paid.
      const h = await payer.writeContract({ address: router, abi: V2.abi, functionName: "pay", args: [rejecting, amount, d.ephemeralPublicKey, meta], account: payer.account!, chain: network.chain });
      const r = await client.waitForTransactionReceipt({ hash: h });
      expect(r.status).toBe("success");
      expect(r.logs.some((l) => l.address.toLowerCase() === network.announcer!.toLowerCase())).toBe(true);
    });

    it("stops a one-time address that re-enters while receiving gas money", async () => {
      const reentering = await deploy("test/ReenteringReceiver");
      const amount = 1_000_000n;
      const inner = payment(network.token!, amount);
      const call = encodeFunctionData({ abi: V2.abi, functionName: "pay", args: [inner.d.stealthAddress, amount, inner.d.ephemeralPublicKey, inner.metadata] });
      await send(payer, { address: reentering, abi: art("test/ReenteringReceiver").abi, functionName: "set", args: [router, call], account: payer.account!, chain: network.chain });
      const { d } = payment(network.token!, amount);
      const meta = buildPaymentMetadata({ viewTag: d.viewTag, token: network.token!, amount });
      await approveRouterIfNeeded(payer, client, { network, token: network.token!, owner: payer.account!.address, amount: amount * 2n });
      await expect(
        client.simulateContract({ address: router, abi: V2.abi, functionName: "pay", args: [reentering, amount, d.ephemeralPublicKey, meta], account: payer.account!, value: 1000n }),
      ).rejects.toThrow(/StipendTransferFailed|Reentrancy/);
    });
  });

  it("never holds funds and has no owner functions", async () => {
    expect(await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [router] })).toBe(0n);
    expect(await client.getBalance({ address: router })).toBe(0n);
    const names = (V2.abi as { type: string; name?: string; stateMutability?: string }[]).filter((x) => x.type === "function" && x.stateMutability !== "view" && x.stateMutability !== "pure").map((x) => x.name);
    expect(names.sort()).toEqual(["pay", "payOnce"]);
    void announcerAbi;
  });
});
