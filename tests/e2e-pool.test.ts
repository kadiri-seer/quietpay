/**
 * Shielded pool end to end on a local EVM (anvil, chain ID 46630), with the real audited
 * contracts, the real circuits and the ceremony proving keys:
 *
 *   payment -> one-time address -> deposit -> approval root -> local Groth16 proof ->
 *   relayed withdrawal to an empty fresh address (+ gas drop) -> change note -> second
 *   withdrawal -> ragequit of another deposit
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORKS, type NetworkConfig } from "@/config/networks";
import { erc20Abi, mockTokenFaucetAbi } from "@/config/contracts";
import { deployPool } from "../scripts/pool-deploy-lib";
import { derivePoolMasterKeys, masterKeysFromSeeds } from "@/lib/pool/crypto";
import { fetchPoolEvents, reconstructNotes, currentApprovalSet, exclusionListId } from "@/lib/pool/state";
import { ArtifactIntegrityError, loadVerified, type ArtifactLoader } from "@/lib/pool/prover";
import { SHIELD_GAS_BUDGET, depositFromAccount, NotApprovedYetError, prepareWithdrawal, ragequit, serializeWithdrawal, verifyPool, type PoolInfo } from "@/lib/pool/actions";
import { refreshApprovals, relayWithdrawal, RelayRejected, type ApprovalScreening } from "@/lib/pool/relayer";
import { screenDeposit } from "@/lib/screening/screen";
import { VerificationError } from "@/lib/chain";

const ROOT = join(__dirname, "..");
const ANVIL = join(ROOT, "node_modules", "@foundry-rs", "anvil", "bin.mjs");
const PORT = 10545 + Math.floor(Math.random() * 1000);
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
const FEE_BPS = 50n; // 0.5%
const GAS_DROP = parseEther("0.0005");

async function fundOneTime(amount: bigint) {
  // Stands in for a QuietPay payment: tokens plus an ETH stipend at a fresh one-time address.
  const acct = privateKeyToAccount(generatePrivateKey());
  for (const h of [
    await deployer.writeContract({ address: network.token!, abi: erc20Abi, functionName: "transfer", args: [acct.address, amount], account: deployer.account!, chain: network.chain }),
    await deployer.sendTransaction({ to: acct.address, value: parseEther("0.001"), account: deployer.account!, chain: network.chain }),
  ])
    await client.waitForTransactionReceipt({ hash: h });
  return acct;
}

const events = () => fetchPoolEvents(client, { entrypoint: network.pool!.entrypoint, pool: network.pool!.pool, fromBlock: network.pool!.fromBlock, chunkSize: 1000n });
const mine = async (seconds: number) => {
  await client.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
  await client.request({ method: "evm_mine" as never, params: [] as never });
};

describe.skipIf(!existsSync(ANVIL))("shielded pool on a local EVM", () => {
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

  it("verifies the deployed pool against the audited build and rejects impostors", async () => {
    info = (await verifyPool(client, network))!;
    expect(info.minimumDeposit).toBe(1_000_000n);
    expect(info.maxRelayFeeBPS).toBe(100n);
    expect(info.aspRoot).toBe(0n);
    await expect(verifyPool(client, { ...network, pool: { ...network.pool!, pool: network.token! } })).rejects.toBeInstanceOf(VerificationError);
    await expect(verifyPool(client, { ...network, pool: { ...network.pool!, entrypoint: network.pool!.pool } })).rejects.toBeInstanceOf(VerificationError);
    expect(await verifyPool(client, { ...network, pool: null })).toBeNull();
  });

  it("refuses tampered circuit files", async () => {
    const bad: ArtifactLoader = async () => new Uint8Array([1, 2, 3]);
    await expect(loadVerified(bad, "commitment.vkey")).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("derives pool keys deterministically from the vault signature, separate per address", async () => {
    const sig = `0x${"ab".repeat(65)}` as Hex;
    const a = await derivePoolMasterKeys(sig, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const b = await derivePoolMasterKeys(sig, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const c = await derivePoolMasterKeys(sig, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    expect(a).toEqual(b);
    expect(a.masterNullifier).not.toBe(c.masterNullifier);
  });

  it("deposits from a one-time address, waits for approval, and withdraws privately via the relayer", async () => {
    const keys = masterKeysFromSeeds(111n, 222n);
    const oneTime = await fundOneTime(50_000_000n);

    let ev = await events();
    const before = reconstructNotes(keys, info.scope, ev);
    expect(before.notes).toHaveLength(0);
    const dep = await depositFromAccount(client, network, info, { account: oneTime, keys, depositIndex: before.nextDepositIndex, amount: 50_000_000n });
    expect(dep.value).toBe(50_000_000n);
    // The payer's gas stipend budgets SHIELD_GAS_BUDGET for approve + deposit.
    const used = (await client.getTransactionReceipt({ hash: dep.hash })).gasUsed + (await client.getTransactionReceipt({ hash: dep.approveHash! })).gasUsed;
    expect(used).toBeLessThan(SHIELD_GAS_BUDGET);

    ev = await events();
    let { notes } = reconstructNotes(keys, info.scope, ev);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ value: 50_000_000n, status: "spendable", label: dep.label });

    // Not approved yet: the approver only includes deposits older than the delay.
    const r0 = await refreshApprovals(client, relayer, network, info, ev, { delaySeconds: 3600 });
    expect(r0.hash).toBeNull();
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    await expect(
      prepareWithdrawal(load, { info, events: ev, keys, note: notes[0], amount: 1n, recipient, feeRecipient: relayer.account!.address, feeBPS: FEE_BPS }),
    ).rejects.toThrow();

    await mine(3601);
    ev = await events();
    const r1 = await refreshApprovals(client, relayer, network, info, ev, { delaySeconds: 3600, nowSeconds: Number((await client.getBlock()).timestamp) });
    expect(r1.hash).not.toBeNull();
    expect(r1.approved).toBe(1);
    info = (await verifyPool(client, network))!;
    ev = await events();
    expect(currentApprovalSet(ev, info.aspRoot)?.labels).toEqual([dep.label]);
    // Idempotent: nothing new to approve.
    expect((await refreshApprovals(client, relayer, network, info, ev, { delaySeconds: 3600, nowSeconds: Number((await client.getBlock()).timestamp) })).hash).toBeNull();

    // Withdraw 30 to an empty address. Proof is generated locally.
    const t0 = Date.now();
    const w = await prepareWithdrawal(load, { info, events: ev, keys, note: notes[0], amount: 30_000_000n, recipient, feeRecipient: relayer.account!.address, feeBPS: FEE_BPS });
    console.log(`  withdrawal proof generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const body = JSON.parse(JSON.stringify(serializeWithdrawal(w)));

    // The relayer refuses anything it did not agree to.
    // tokenUnitsPerEth 1: the fee is worth far more than the gas here, so the full top-up is paid.
    const policy = { feeRecipient: relayer.account!.address, feeBPS: FEE_BPS, gasDrop: GAS_DROP, tokenUnitsPerEth: 1n };
    // At a realistic price (3000 tokens per ETH) and this node's gas price, a 30-token
    // withdrawal's 0.15 fee can't pay for the relay, so it is refused with the minimum amount.
    const priced = { ...policy, tokenUnitsPerEth: 3000n * 10n ** 6n };
    const tooSmall = await relayWithdrawal(client, relayer, network, info, priced, body).catch((e) => e);
    expect(tooSmall).toBeInstanceOf(RelayRejected);
    expect((tooSmall as RelayRejected).minWithdrawal).toBeGreaterThan(30_000_000n);
    await expect(relayWithdrawal(client, relayer, network, info, { ...policy, feeBPS: 10n }, body)).rejects.toBeInstanceOf(RelayRejected);
    await expect(relayWithdrawal(client, relayer, network, info, policy, { ...body, scope: "1" })).rejects.toBeInstanceOf(RelayRejected);
    const tampered = structuredClone(body);
    tampered.proof.pubSignals[2] = "40000000"; // claim more than proven
    await expect(relayWithdrawal(client, relayer, network, info, policy, tampered)).rejects.toBeInstanceOf(RelayRejected);

    // The same proof sent twice at once is submitted once: the second copy is turned away
    // instead of costing the relayer gas for a transaction that would fail.
    const claimed = new Set<string>();
    const guard = {
      claim: async (n: bigint) => {
        if (claimed.has(n.toString())) return null;
        claimed.add(n.toString());
        return async () => void claimed.delete(n.toString());
      },
      send: <T,>(fn: () => Promise<T>) => fn(),
    };
    const both = await Promise.allSettled([
      relayWithdrawal(client, relayer, network, info, policy, body, guard),
      relayWithdrawal(client, relayer, network, info, policy, body, guard),
    ]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const turnedAway = both.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(turnedAway.reason).toBeInstanceOf(RelayRejected);
    expect(String(turnedAway.reason.message)).toMatch(/already being submitted/);
    const res = (both.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof relayWithdrawal>>>).value;
    expect(res.fee).toBe(150_000n);
    const got = await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
    expect(got).toBe(30_000_000n - 150_000n);
    expect(await client.getBalance({ address: recipient })).toBe(GAS_DROP);
    // Double spend is refused.
    await expect(relayWithdrawal(client, relayer, network, info, policy, body)).rejects.toBeInstanceOf(RelayRejected);

    // The change note (20) is found from the chain alone and can be withdrawn again.
    ev = await events();
    ({ notes } = reconstructNotes(keys, info.scope, ev));
    expect(notes[0]).toMatchObject({ value: 20_000_000n, withdrawalCount: 1n, status: "spendable" });
    const recipient2 = privateKeyToAccount(generatePrivateKey()).address;
    const w2 = await prepareWithdrawal(load, { info, events: ev, keys, note: notes[0], amount: 20_000_000n, recipient: recipient2, feeRecipient: relayer.account!.address, feeBPS: FEE_BPS });
    await relayWithdrawal(client, relayer, network, info, policy, JSON.parse(JSON.stringify(serializeWithdrawal(w2))));
    ev = await events();
    ({ notes } = reconstructNotes(keys, info.scope, ev));
    expect(notes[0]).toMatchObject({ value: 0n, status: "spent" });

    // Nothing onchain links the one-time address to either recipient except through the pool.
    const relayed = await client.getTransaction({ hash: res.hash });
    expect(relayed.from.toLowerCase()).toBe(relayer.account!.address.toLowerCase());
  }, 240_000);

  it("screens deposits: money from a sanctioned wallet is left out and published; clean money is approved", async () => {
    // A wallet on the sanctions list pays a one-time address, which then deposits.
    const sanctioned = privateKeyToAccount(generatePrivateKey());
    for (const h of [
      await deployer.writeContract({ address: network.token!, abi: erc20Abi, functionName: "transfer", args: [sanctioned.address, 20_000_000n], account: deployer.account!, chain: network.chain }),
      await deployer.sendTransaction({ to: sanctioned.address, value: parseEther("0.01"), account: deployer.account!, chain: network.chain }),
    ])
      await client.waitForTransactionReceipt({ hash: h });
    const dirtyOneTime = privateKeyToAccount(generatePrivateKey());
    const sw = createWalletClient({ account: sanctioned, chain: network.chain, transport: http(RPC) });
    for (const h of [
      await sw.writeContract({ address: network.token!, abi: erc20Abi, functionName: "transfer", args: [dirtyOneTime.address, 10_000_000n], account: sanctioned, chain: network.chain }),
      await sw.sendTransaction({ to: dirtyOneTime.address, value: parseEther("0.001"), account: sanctioned, chain: network.chain }),
    ])
      await client.waitForTransactionReceipt({ hash: h });
    const cleanOneTime = await fundOneTime(12_000_000n);

    const kClean = masterKeysFromSeeds(555n, 666n);
    const kDirty = masterKeysFromSeeds(777n, 888n);
    const clean = await depositFromAccount(client, network, info, { account: cleanOneTime, keys: kClean, depositIndex: 0n, amount: 12_000_000n });
    const dirty = await depositFromAccount(client, network, info, { account: dirtyOneTime, keys: kDirty, depositIndex: 0n, amount: 10_000_000n });

    // Screening with an in-memory store, the real sender lookup, and a list holding the wallet.
    const list = { has: (a: string) => a.toLowerCase() === sanctioned.address.toLowerCase(), size: 1, source: "bundled" as const, asOf: "" };
    const store = { excluded: [] as bigint[], published: new Map<string, bigint[]>(), failNext: false };
    const screening: ApprovalScreening = {
      excluded: async () => store.excluded,
      verdict: async (deposit) => {
        if (store.failNext) throw new Error("RPC down");
        return screenDeposit(client, { deposit, token: network.token!, list, fromBlock: 0n, ignore: [info.pool, info.entrypoint] });
      },
      publish: async (labels) => {
        const id = exclusionListId(labels);
        store.published.set(id, labels);
        store.excluded = labels;
        return id;
      },
    };
    const now = async () => Number((await client.getBlock()).timestamp);
    const r = await refreshApprovals(client, relayer, network, info, await events(), { delaySeconds: 0, nowSeconds: await now(), screening });
    expect(r.hash).not.toBeNull();
    expect(r.excluded).toBe(1);
    info = (await verifyPool(client, network))!;

    // Clients rebuild the set from the chain plus the published list, and check the root.
    const loader = async (id: string) => store.published.get(id) ?? null;
    const ev = await fetchPoolEvents(client, { entrypoint: network.pool!.entrypoint, pool: network.pool!.pool, fromBlock: network.pool!.fromBlock, chunkSize: 1000n, exclusions: loader });
    const set = currentApprovalSet(ev, info.aspRoot)!;
    expect(set.labels).toContain(clean.label);
    expect(set.labels).not.toContain(dirty.label);
    expect(set.excluded).toEqual([dirty.label]);
    // Without the list (or with a different one) the set can't be verified.
    expect(currentApprovalSet(await events(), info.aspRoot)).toBeNull();
    expect(currentApprovalSet({ ...ev, exclusions: { id: ev.exclusions!.id, labels: [] } }, info.aspRoot)).toBeNull();

    // The excluded deposit can't be withdrawn privately, only exited.
    const dirtyNote = reconstructNotes(kDirty, info.scope, ev).notes[0];
    await expect(
      prepareWithdrawal(load, { info, events: ev, keys: kDirty, note: dirtyNote, amount: 1_000_000n, recipient: cleanOneTime.address, feeRecipient: relayer.account!.address, feeBPS: FEE_BPS }),
    ).rejects.toBeInstanceOf(NotApprovedYetError);

    // If screening can't run, nothing new is approved and nothing already approved is taken back.
    const later = await fundOneTime(3_000_000n);
    const kLater = masterKeysFromSeeds(999n, 1000n);
    const third = await depositFromAccount(client, network, info, { account: later, keys: kLater, depositIndex: 0n, amount: 3_000_000n });
    store.failNext = true;
    const r2 = await refreshApprovals(client, relayer, network, info, await events(), { delaySeconds: 0, nowSeconds: await now(), screening });
    expect(r2.hash).toBeNull();
    expect(r2.uptoBlock).toBeLessThan((await client.getTransactionReceipt({ hash: third.hash })).blockNumber);
    store.failNext = false;
    const r3 = await refreshApprovals(client, relayer, network, info, await events(), { delaySeconds: 0, nowSeconds: await now(), screening });
    expect(r3.hash).not.toBeNull();
    info = (await verifyPool(client, network))!;
    const ev3 = await fetchPoolEvents(client, { entrypoint: network.pool!.entrypoint, pool: network.pool!.pool, fromBlock: network.pool!.fromBlock, chunkSize: 1000n, exclusions: loader });
    const set3 = currentApprovalSet(ev3, info.aspRoot)!;
    expect(set3.labels).toEqual(expect.arrayContaining([clean.label, third.label]));
    expect(set3.excluded).toEqual([dirty.label]);
  }, 240_000);

  it("lets the depositor exit without approval (ragequit) back to the one-time address", async () => {
    const keys = masterKeysFromSeeds(333n, 444n);
    const oneTime = await fundOneTime(5_000_000n);
    const dep = await depositFromAccount(client, network, info, { account: oneTime, keys, depositIndex: 0n, amount: 5_000_000n });
    let ev = await events();
    let { notes } = reconstructNotes(keys, info.scope, ev);
    expect(() => {
      if (!currentApprovalSet(ev, info.aspRoot)?.labels.includes(dep.label)) throw new NotApprovedYetError();
    }).toThrow(NotApprovedYetError);
    await ragequit(client, network, load, { info, account: oneTime, note: notes[0] });
    expect(await client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [oneTime.address] })).toBe(5_000_000n);
    ev = await events();
    ({ notes } = reconstructNotes(keys, info.scope, ev));
    expect(notes[0].status).toBe("ragequit");
    void (0 as unknown as Address);
  }, 120_000);
});
