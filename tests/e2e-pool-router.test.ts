/**
 * Paying straight into the shielded pool through QuietPayPoolRouter, on a local EVM with the real
 * audited pool contracts, circuits and proving keys:
 *
 *   payer -> router -> pool under the recipient's lock -> recipient finds it by its own keys ->
 *   approval -> private withdrawal; pool-to-pool transfer into another person's lock;
 *   refund of an unapproved payment to the recipient's refund address only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, getAddress, http, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORKS, type NetworkConfig } from "@/config/networks";
import { erc20Abi, mockTokenFaucetAbi } from "@/config/contracts";
import { PrivacyPoolComplex } from "@/config/pool-contracts.generated";
import { deployPool } from "../scripts/pool-deploy-lib";
import { masterKeysFromSeeds } from "@/lib/pool/crypto";
import { fetchPoolEvents, reconstructNotes, reconstructReceived } from "@/lib/pool/state";
import { type ArtifactLoader } from "@/lib/pool/prover";
import { prepareWithdrawal, serializeWithdrawal, verifyPool, type PoolInfo } from "@/lib/pool/actions";
import { refreshApprovals, relayWithdrawal } from "@/lib/pool/relayer";
import { screenDeposit } from "@/lib/screening/screen";
import { createPaymentRequest } from "@/lib/request";
import { validatePaymentLink } from "@/lib/link";
import { EXPIRY_OPTIONS } from "@/config/networks";
import { creditedAmount, poolPayPreflight, verifyPoolRouter, payIntoPool, poolRouterAbi, prepareTransfer, receiveLock, refundAccount, refundUnapproved, transferArgs, encodeTransferData } from "@/lib/pool/receive";

const ROOT = join(__dirname, "..");
const ANVIL = join(ROOT, "node_modules", "@foundry-rs", "anvil", "bin.mjs");
const PORT = 11545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RELAYER_KEY = generatePrivateKey();
const art = (n: string) => JSON.parse(readFileSync(join(ROOT, "contracts", "artifacts", `${n}.json`), "utf8"));
const load: ArtifactLoader = async (name) => new Uint8Array(readFileSync(join(ROOT, "public", "pool-artifacts", "artifacts", name)));

let anvil: ChildProcess | undefined;
let client: PublicClient;
let deployer: WalletClient;
let relayer: WalletClient;
let network: NetworkConfig;
let info: PoolInfo;
let router: Address;
const FEE_BPS = 50n;
const GAS_DROP = parseEther("0.0005");
const alice = masterKeysFromSeeds(7n, 8n); // recipient
const bob = masterKeysFromSeeds(9n, 10n); // receives a pool-to-pool transfer

const events = () => fetchPoolEvents(client, { entrypoint: network.pool!.entrypoint, pool: network.pool!.pool, fromBlock: network.pool!.fromBlock, chunkSize: 1000n });
const bal = (a: Address) => client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const approveAll = async () => {
  const ev = await events();
  const r = await refreshApprovals(client, relayer, network, info, ev, { delaySeconds: 0, nowSeconds: Number((await client.getBlock()).timestamp) });
  if (r.hash) await client.waitForTransactionReceipt({ hash: r.hash });
  info = (await verifyPool(client, network))!;
};

describe.skipIf(!existsSync(ANVIL))("paying straight into the pool", () => {
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
    deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain: network.chain, transport: http(RPC) });
    relayer = createWalletClient({ account: privateKeyToAccount(RELAYER_KEY), chain: network.chain, transport: http(RPC) });
    const fund = await deployer.sendTransaction({ to: relayer.account!.address, value: parseEther("10"), account: deployer.account!, chain: network.chain });
    await client.waitForTransactionReceipt({ hash: fund });
    const tokenArt = art("QuietPayTestUSDG");
    const th = await deployer.deployContract({ abi: tokenArt.abi, bytecode: tokenArt.bytecode as Hex, account: deployer.account!, chain: network.chain });
    const token = (await client.waitForTransactionReceipt({ hash: th })).contractAddress!;
    for (let i = 0; i < 3; i++) {
      const h = await deployer.writeContract({ address: token, abi: mockTokenFaucetAbi, functionName: "faucet", args: [10_000_000_000n], account: deployer.account!, chain: network.chain });
      await client.waitForTransactionReceipt({ hash: h });
    }
    network = { ...network, token };
    const d = await deployPool(deployer, client, {
      token,
      owner: deployer.account!.address,
      postman: relayer.account!.address,
      minimumDeposit: 1_000_000n,
      vettingFeeBPS: 0n,
      maxRelayFeeBPS: 100n,
    });
    network = { ...network, pool: { entrypoint: d.entrypoint, pool: d.pool, fromBlock: d.fromBlock, relayerUrl: "/api/relay", exclusionsUrl: "/api/pool/exclusions", router: null } };
  }, 120_000);
  afterAll(() => anvil?.kill());

  it("deploys the router bound to the pool, its entrypoint and asset", async () => {
    info = (await verifyPool(client, network))!;
    const a = art("QuietPayPoolRouter");
    await expect(
      deployer.deployContract({ abi: a.abi, bytecode: a.bytecode as Hex, args: [network.token!], account: deployer.account!, chain: network.chain }).then((h) => client.waitForTransactionReceipt({ hash: h })).then((r) => {
        if (r.status !== "success") throw new Error("reverted");
      }),
    ).rejects.toThrow();
    const h = await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode as Hex, args: [network.pool!.pool], account: deployer.account!, chain: network.chain });
    router = getAddress((await client.waitForTransactionReceipt({ hash: h })).contractAddress!);
    expect(await client.readContract({ address: router, abi: poolRouterAbi, functionName: "pool" })).toBe(getAddress(network.pool!.pool));
    expect(await client.readContract({ address: router, abi: poolRouterAbi, functionName: "entrypoint" })).toBe(getAddress(network.pool!.entrypoint));
    expect(await client.readContract({ address: router, abi: poolRouterAbi, functionName: "token" })).toBe(getAddress(network.token!));
    expect(await client.readContract({ address: router, abi: poolRouterAbi, functionName: "scope" })).toBe(info.scope);
    // The app checks the deployed code and its bindings before paying through it.
    expect(await verifyPoolRouter(client, { ...network, pool: { ...network.pool!, router } })).toBe(router);
    expect(await verifyPoolRouter(client, network)).toBeNull();
    await expect(verifyPoolRouter(client, { ...network, pool: { ...network.pool!, router: network.pool!.pool } })).rejects.toThrow(/published code/);
    await expect(verifyPoolRouter(client, { ...network, token: network.pool!.pool, pool: { ...network.pool!, router } })).rejects.toThrow(/different pool/);
  });

  it("pays into the pool under the recipient's lock; only the recipient finds it; a lock pays once", async () => {
    const lock = receiveLock(alice, info.scope, 0n);
    const payerBefore = await bal(deployer.account!.address);
    const { hash } = await payIntoPool(deployer, client, { network, router, token: network.token!, lock, amount: 25_000_000n });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect(payerBefore - (await bal(deployer.account!.address))).toBe(25_000_000n);

    const ev = await events();
    const mine = reconstructReceived(alice, info.scope, ev, 1n);
    expect(mine.notes).toHaveLength(1);
    expect(mine.notes[0]).toMatchObject({ value: 25_000_000n, status: "spendable" });
    expect(getAddress(mine.notes[0].deposit.depositor)).toBe(router);
    expect(mine.nextReceiveIndex).toBe(1n);
    expect(await client.readContract({ address: router, abi: poolRouterAbi, functionName: "refundTo", args: [mine.notes[0].label] })).toBe(lock.refund);
    // Nobody else's keys match it, and it doesn't mix with the recipient's own deposits.
    expect(reconstructReceived(bob, info.scope, ev, 5n).notes).toHaveLength(0);
    expect(reconstructNotes(alice, info.scope, ev).notes).toHaveLength(0);
    // Found on another device that doesn't know how many locks were handed out.
    expect(reconstructReceived(alice, info.scope, ev, 0n).notes).toHaveLength(1);

    // A lock is single use: the pool rejects a second deposit under it, before any money moves.
    const before = await bal(deployer.account!.address);
    await expect(payIntoPool(deployer, client, { network, router, token: network.token!, lock, amount: 5_000_000n })).rejects.toThrow();
    expect(await bal(deployer.account!.address)).toBe(before);

    // A lock handed out much later (index 7, others unused) is still found.
    const late = receiveLock(alice, info.scope, 7n);
    const r2 = await payIntoPool(deployer, client, { network, router, token: network.token!, lock: late, amount: 3_000_000n });
    await client.waitForTransactionReceipt({ hash: r2.hash });
    const again = reconstructReceived(alice, info.scope, await events(), 1n);
    expect(again.notes.map((n) => n.value)).toEqual([25_000_000n, 3_000_000n]);
    expect(again.nextReceiveIndex).toBe(8n);

    // The router holds nothing and has no allowance left at the entrypoint.
    expect(await bal(router)).toBe(0n);
    expect(await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "allowance", args: [router, network.pool!.entrypoint] })).toBe(0n);
  });

  it("rejects bad payments", async () => {
    const lock = receiveLock(alice, info.scope, 1n);
    const sim = (pre: bigint, amount: bigint, refund: Address) =>
      client.simulateContract({ address: router, abi: poolRouterAbi, functionName: "pay", args: [pre, amount, refund], account: deployer.account! });
    await expect(sim(lock.precommitment, 0n, lock.refund)).rejects.toThrow(/ZeroAmount/);
    await expect(sim(0n, 1_000_000n, lock.refund)).rejects.toThrow();
    await expect(sim(lock.precommitment, 1_000_000n, "0x0000000000000000000000000000000000000000")).rejects.toThrow();
    // Below the pool's minimum deposit.
    await expect(sim(lock.precommitment, 999_999n, lock.refund)).rejects.toThrow();
  });

  it("the recipient withdraws a received payment privately once it is approved", async () => {
    await approveAll();
    const ev = await events();
    const note = reconstructReceived(alice, info.scope, ev, 1n).notes[0];
    const to = privateKeyToAccount(generatePrivateKey()).address;
    const w = await prepareWithdrawal(load, { info, events: ev, keys: alice, note, amount: 5_000_000n, recipient: to, feeRecipient: relayer.account!.address, feeBPS: FEE_BPS });
    const policy = { feeRecipient: relayer.account!.address, feeBPS: FEE_BPS, gasDrop: GAS_DROP, tokenUnitsPerEth: 1n };
    const res = await relayWithdrawal(client, relayer, network, info, policy, JSON.parse(JSON.stringify(serializeWithdrawal(w))));
    expect(res.amount).toBe(5_000_000n);
    expect(await bal(to)).toBe(5_000_000n - res.fee);
    const after = reconstructReceived(alice, info.scope, await events(), 1n).notes[0];
    expect(after.value).toBe(20_000_000n);
  }, 120_000);

  it("moves part of a note into another person's lock in one transaction, with every parameter bound by the proof", async () => {
    let ev = await events();
    const note = reconstructReceived(alice, info.scope, ev, 1n).notes[0];
    const bobLock = receiveLock(bob, info.scope, 0n);
    const fee = 100_000n;
    const t = await prepareTransfer(load, { info, events: ev, keys: alice, note, router, amount: 10_000_000n, to: bobLock, feeRecipient: relayer.account!.address, fee });
    const sim = (data: Hex) =>
      client.simulateContract({ address: router, abi: poolRouterAbi, functionName: "transfer", args: transferArgs({ ...t, withdrawal: { ...t.withdrawal, data } }), account: relayer.account! });
    // Whoever submits it can't change the destination, the refund address, the fee or its recipient.
    const mallory = privateKeyToAccount(generatePrivateKey()).address;
    const malloryLock = receiveLock(masterKeysFromSeeds(1n, 2n), info.scope, 0n);
    for (const d of [
      { precommitment: malloryLock.precommitment, refund: bobLock.refund, feeRecipient: relayer.account!.address, fee },
      { precommitment: bobLock.precommitment, refund: mallory, feeRecipient: relayer.account!.address, fee },
      { precommitment: bobLock.precommitment, refund: bobLock.refund, feeRecipient: mallory, fee },
      { precommitment: bobLock.precommitment, refund: bobLock.refund, feeRecipient: relayer.account!.address, fee: fee * 10n },
    ])
      await expect(sim(encodeTransferData(d))).rejects.toThrow();
    // It can't be sent to the pool directly either: only the router may process it.
    await expect(
      client.simulateContract({ address: network.pool!.pool, abi: PrivacyPoolComplex.abi, functionName: "withdraw", args: transferArgs(t) as never, account: relayer.account! }),
    ).rejects.toThrow();

    const relayerBefore = await bal(relayer.account!.address);
    const h = await relayer.writeContract({ address: router, abi: poolRouterAbi, functionName: "transfer", args: transferArgs(t), account: relayer.account!, chain: network.chain });
    expect((await client.waitForTransactionReceipt({ hash: h })).status).toBe("success");
    expect((await bal(relayer.account!.address)) - relayerBefore).toBe(fee);
    ev = await events();
    const bobs = reconstructReceived(bob, info.scope, ev, 1n).notes;
    expect(bobs).toHaveLength(1);
    expect(bobs[0]).toMatchObject({ value: 10_000_000n - fee, status: "spendable" });
    expect(getAddress(bobs[0].deposit.depositor)).toBe(router);
    expect(reconstructReceived(alice, info.scope, ev, 1n).notes[0].value).toBe(10_000_000n);
    // The same proof can't be used twice.
    await expect(
      client.simulateContract({ address: router, abi: poolRouterAbi, functionName: "transfer", args: transferArgs(t), account: relayer.account! }),
    ).rejects.toThrow();
    expect(await bal(router)).toBe(0n);

    // Bob can spend it once approved.
    await approveAll();
    ev = await events();
    const to = privateKeyToAccount(generatePrivateKey()).address;
    const w = await prepareWithdrawal(load, { info, events: ev, keys: bob, note: bobs[0], amount: 9_900_000n, recipient: to, feeRecipient: relayer.account!.address, feeBPS: FEE_BPS });
    const policy = { feeRecipient: relayer.account!.address, feeBPS: FEE_BPS, gasDrop: GAS_DROP, tokenUnitsPerEth: 1n };
    await relayWithdrawal(client, relayer, network, info, policy, JSON.parse(JSON.stringify(serializeWithdrawal(w))));
    expect(await bal(to)).toBeGreaterThan(0n);
  }, 180_000);

  it("returns an unapproved payment to the recipient's refund address, and nowhere else", async () => {
    const lock = receiveLock(alice, info.scope, 2n);
    const r = await payIntoPool(deployer, client, { network, router, token: network.token!, lock, amount: 4_000_000n });
    await client.waitForTransactionReceipt({ hash: r.hash });
    const ev = await events();
    const note = reconstructReceived(alice, info.scope, ev, 3n).notes.find((n) => n.depositIndex === (1n << 64n) + 2n)!;
    expect(note.value).toBe(4_000_000n);

    // The recipient can't ragequit at the pool directly: the router is the depositor.
    const { proveRagequit } = await import("@/lib/pool/prover");
    const proof = await proveRagequit(load, { value: note.value, label: note.label, secrets: note.secrets });
    const refundKey = refundAccount(alice, info.scope, 2n);
    expect(refundKey.address).toBe(lock.refund);
    await expect(
      client.simulateContract({
        address: network.pool!.pool,
        abi: PrivacyPoolComplex.abi,
        functionName: "ragequit",
        args: [{ pA: proof.pA, pB: proof.pB, pC: proof.pC, pubSignals: proof.pubSignals }] as never,
        account: refundKey,
      }),
    ).rejects.toThrow();
    // A label that wasn't paid through the router is refused.
    await expect(
      client.simulateContract({
        address: router,
        abi: poolRouterAbi,
        functionName: "ragequit",
        args: [{ pA: proof.pA, pB: proof.pB, pC: proof.pC, pubSignals: [proof.pubSignals[0], proof.pubSignals[1], proof.pubSignals[2], 12345n] }],
        account: relayer.account!,
      }),
    ).rejects.toThrow(/UnknownDeposit/);

    // Anyone can submit the refund; the money only goes to the refund address.
    const h = await refundUnapproved(relayer, load, { network, router, note });
    expect((await client.waitForTransactionReceipt({ hash: h })).status).toBe("success");
    expect(await bal(lock.refund)).toBe(4_000_000n);
    const after = reconstructReceived(alice, info.scope, await events(), 3n).notes.find((n) => n.depositIndex === (1n << 64n) + 2n)!;
    expect(after.status).toBe("ragequit");
    await expect(refundUnapproved(relayer, load, { network, router, note })).rejects.toThrow();
    expect(await bal(router)).toBe(0n);
  }, 120_000);

  it("screens the real payer of a router payment, not the router's mixed history", async () => {
    // A sanctioned wallet pays someone through the router, then a clean wallet pays someone else.
    const sanctioned = privateKeyToAccount(generatePrivateKey());
    const cleanPayer = privateKeyToAccount(generatePrivateKey());
    for (const a of [sanctioned, cleanPayer]) {
      for (const h of [
        await deployer.writeContract({ address: network.token!, abi: erc20Abi, functionName: "transfer", args: [a.address, 5_000_000n], account: deployer.account!, chain: network.chain }),
        await deployer.sendTransaction({ to: a.address, value: parseEther("0.01"), account: deployer.account!, chain: network.chain }),
      ])
        await client.waitForTransactionReceipt({ hash: h });
    }
    const wallet = (a: typeof sanctioned) => createWalletClient({ account: a, chain: network.chain, transport: http(RPC) });
    const dirtyLock = receiveLock(alice, info.scope, 3n);
    const cleanLock = receiveLock(alice, info.scope, 4n);
    await client.waitForTransactionReceipt({ hash: (await payIntoPool(wallet(sanctioned), client, { network, router, token: network.token!, lock: dirtyLock, amount: 2_000_000n })).hash });
    await client.waitForTransactionReceipt({ hash: (await payIntoPool(wallet(cleanPayer), client, { network, router, token: network.token!, lock: cleanLock, amount: 2_000_000n })).hash });

    const ev = await events();
    const byPre = (pre: bigint) => ev.deposits.find((d) => d.precommitment === pre)!;
    const list = { has: (a: string) => a.toLowerCase() === sanctioned.address.toLowerCase(), size: 1, source: "bundled" as const, asOf: "" };
    const screen = (deposit: (typeof ev.deposits)[number], poolRouters: Address[]) =>
      screenDeposit(client, { deposit, token: network.token!, list, fromBlock: 0n, ignore: [info.pool, info.entrypoint], poolRouters });
    expect(await screen(byPre(dirtyLock.precommitment), [router])).toMatchObject({ ok: false, flagged: sanctioned.address });
    expect(await screen(byPre(cleanLock.precommitment), [router])).toMatchObject({ ok: true, checked: 1 });
    // A pool-to-pool transfer carries money that already left the pool through an approved withdrawal.
    const bobLock = receiveLock(bob, info.scope, 0n);
    expect(await screen(byPre(bobLock.precommitment), [router])).toEqual({ ok: true, checked: 0 });
    // Without knowing about the router, the clean payment would be blamed for the sanctioned
    // payer's earlier transfer to the router (this is why poolRouters exists). The router holds
    // nothing between calls, but its token history includes every payer.
    expect((await screen(byPre(cleanLock.precommitment), [])).ok).toBe(false);
  }, 120_000);

  it("a one-time link carries the lock end to end: create, validate, preflight, pay, find; then it reads as paid", async () => {
    const index = 30;
    const lock = receiveLock(alice, info.scope, BigInt(index));
    const rec = createPaymentRequest({
      kind: "fixed",
      chainId: 46630,
      token: network.token!,
      amount: 6_000_000n,
      decimals: 6,
      symbol: "tUSDG",
      expirySeconds: EXPIRY_OPTIONS[1].seconds,
      fromBlock: 0n,
      index,
      poolLock: { precommitment: lock.precommitment, refund: lock.refund, receiveIndex: index },
    });
    expect(rec.pool).toEqual({ precommitment: lock.precommitment.toString(), refund: lock.refund, receiveIndex: index });
    const { request } = validatePaymentLink(rec.link, { networks: { testnet: network, mainnet: { ...NETWORKS.mainnet, enabled: false } } as never });
    expect(request.poolLock).toEqual({ precommitment: lock.precommitment, refund: lock.refund });

    const payer = deployer.account!.address;
    const base = { info, token: network.token!, symbol: "tUSDG", decimals: 6, payer, lock: request.poolLock! };
    const pf = await poolPayPreflight(client, { ...base, amount: request.amount });
    expect(pf).toMatchObject({ ok: true, alreadyPaid: false });
    expect((await poolPayPreflight(client, { ...base, amount: 999_999n })).checks.find((c) => c.id === "minimum")?.status).toBe("fail");
    expect((await poolPayPreflight(client, { ...base, payer: privateKeyToAccount(generatePrivateKey()).address, amount: request.amount })).ok).toBe(false);

    const { hash } = await payIntoPool(deployer, client, { network, router, token: network.token!, lock: request.poolLock!, amount: request.amount });
    await client.waitForTransactionReceipt({ hash });
    const after = await poolPayPreflight(client, { ...base, amount: request.amount });
    expect(after).toMatchObject({ ok: false, alreadyPaid: true });
    const found = reconstructReceived(alice, info.scope, await events(), BigInt(index + 1)).notes.find((n) => n.depositIndex === (1n << 64n) + BigInt(index));
    expect(found?.value).toBe(6_000_000n);
    expect(creditedAmount(6_000_000n, 0n)).toBe(6_000_000n);
    expect(creditedAmount(6_000_000n, 50n)).toBe(5_970_000n);
  });

  it("has no owner or admin functions", () => {
    const fns = art("QuietPayPoolRouter").abi.filter((x: { type: string }) => x.type === "function").map((x: { name: string }) => x.name).sort();
    expect(fns).toEqual(["entrypoint", "pay", "pool", "ragequit", "refundTo", "scope", "token", "transfer"]);
  });
});
