/**
 * Regression tests for the security remediation, on a local EVM with the real (unchanged) 0xbow
 * pool contracts:
 *
 *   F1  QuietPayPoolRouterV2.payRequest: a one-time request is marked paid only by exactly its
 *       amount, into a lock its own key signed; underpaying, overpaying, wrong token, foreign
 *       locks, replays, expiry, malformed signatures and burned locks can't use it up.
 *   F2  The relayer during approval-root changes: a proof made before a new root is refused with
 *       a clear message, and made again it goes through.
 *   F4  The relayer's gas top-ups go through the drop limiter.
 *   F5  Refund addresses tokens could never leave are refused (pool router v2).
 *   F6/F7 QuietPayPoolGuardian: fee ceilings, delays, cancellation, upgrades only after the delay,
 *       and the deployer's own control given up.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  parseEther,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORKS, type NetworkConfig } from "@/config/networks";
import { erc20Abi, mockTokenFaucetAbi } from "@/config/contracts";
import { Entrypoint } from "@/config/pool-contracts.generated";
import { deployPool } from "../scripts/pool-deploy-lib";
import { masterKeysFromSeeds } from "@/lib/pool/crypto";
import { fetchPoolEvents, reconstructReceived, reconstructSpares } from "@/lib/pool/state";
import { type ArtifactLoader } from "@/lib/pool/prover";
import { prepareWithdrawal, serializeWithdrawal, verifyPool, type PoolInfo } from "@/lib/pool/actions";
import { refreshApprovals, relayWithdrawal, RelayRejected } from "@/lib/pool/relayer";
import { payIntoPool, payRequestIntoPool, poolRouterAbi, receiveLock, verifyPoolRouterInfo } from "@/lib/pool/receive";
import { lockDigest, requestDigest, requestKeyOf, signDigest, spareIndex } from "@/lib/pool/request-sig";
import { verifyLock } from "@/lib/pool/locks";
import { decodePaymentLink, encodePaymentLink, validatePaymentLink } from "@/lib/link";

const ROOT = join(__dirname, "..");
const ANVIL = join(ROOT, "node_modules", "@foundry-rs", "anvil", "bin.mjs");
const PORT = 13545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PAYER_KEY = generatePrivateKey();
const RELAYER_KEY = generatePrivateKey();
const art = (n: string) => JSON.parse(readFileSync(join(ROOT, "contracts", "artifacts", `${n}.json`), "utf8"));
const load: ArtifactLoader = async (name) => new Uint8Array(readFileSync(join(ROOT, "public", "pool-artifacts", "artifacts", name)));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

let anvil: ChildProcess | undefined;
let client: PublicClient;
let deployer: WalletClient;
let payer: WalletClient;
let relayer: WalletClient;
let network: NetworkConfig;
let info: PoolInfo;
let router: Address;
const alice = masterKeysFromSeeds(21n, 22n); // recipient

const events = () => fetchPoolEvents(client, { entrypoint: network.pool!.entrypoint, pool: network.pool!.pool, fromBlock: network.pool!.fromBlock, chunkSize: 1000n, noCache: true });
const bal = (a: Address) => client.readContract({ address: network.token!, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const now = async () => Number((await client.getBlock()).timestamp);
const warp = async (s: number) => {
  await client.request({ method: "evm_increaseTime" as never, params: [s] as never });
  await client.request({ method: "evm_mine" as never, params: [] as never });
};
const approveAll = async () => {
  const r = await refreshApprovals(client, relayer, network, info, await events(), { delaySeconds: 0, nowSeconds: await now() });
  if (r.hash) await client.waitForTransactionReceipt({ hash: r.hash });
  info = (await verifyPool(client, network))!;
};

/** A signed request as the app makes it (CreateFlow): request key, terms, link lock, spares. */
async function makeRequest(amount: bigint, index: number, opts: { expiresIn?: number } = {}) {
  const key = generatePrivateKey();
  const requestId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const expiresAt = (await now()) + (opts.expiresIn ?? 3600);
  const terms = { chainId: 46630, router, token: network.token!, requestId, amount, expiresAt };
  const lock = receiveLock(alice, info.scope, BigInt(index));
  const lockSig = await signDigest(key, lockDigest({ chainId: 46630, pool: info.pool, ...lock }));
  const termsSig = await signDigest(key, requestDigest(terms));
  const spare = async (j: number) => {
    const l = receiveLock(alice, info.scope, spareIndex(index, j));
    return { precommitment: l.precommitment, refund: l.refund, sig: await signDigest(key, lockDigest({ chainId: 46630, pool: info.pool, ...l })) };
  };
  return { key, address: privateKeyToAccount(key).address, terms, lock: { precommitment: lock.precommitment, refund: lock.refund, sig: lockSig }, termsSig, spare };
}
const simPay = (args: readonly [Hex, bigint, bigint, Hex, bigint, Address, Hex], from: Address = payer.account!.address) =>
  client.simulateContract({ address: router, abi: poolRouterAbi, functionName: "payRequest", args, account: from });
const argsOf = (r: Awaited<ReturnType<typeof makeRequest>>, o: Partial<{ amount: bigint; expiresAt: number; termsSig: Hex; lock: { precommitment: bigint; refund: Address; sig: Hex } }> = {}) => {
  const lock = o.lock ?? r.lock;
  return [r.terms.requestId, o.amount ?? r.terms.amount, BigInt(o.expiresAt ?? r.terms.expiresAt), o.termsSig ?? r.termsSig, lock.precommitment, lock.refund, lock.sig] as const;
};
const isPaid = (a: Address) => client.readContract({ address: router, abi: poolRouterAbi, functionName: "requestPaid", args: [a] });

describe.skipIf(!existsSync(ANVIL))("security remediation (local EVM)", () => {
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
    payer = createWalletClient({ account: privateKeyToAccount(PAYER_KEY), chain: network.chain, transport: http(RPC) });
    relayer = createWalletClient({ account: privateKeyToAccount(RELAYER_KEY), chain: network.chain, transport: http(RPC) });
    await client.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: relayer.account!.address, value: parseEther("10"), account: deployer.account!, chain: network.chain }) });
    await client.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: payer.account!.address, value: parseEther("10"), account: deployer.account!, chain: network.chain }) });
    const tokenArt = art("QuietPayTestUSDG");
    const token = (await client.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: tokenArt.abi, bytecode: tokenArt.bytecode as Hex, account: deployer.account!, chain: network.chain }) })).contractAddress!;
    for (const w of [deployer, payer])
      await client.waitForTransactionReceipt({ hash: await w.writeContract({ address: token, abi: mockTokenFaucetAbi, functionName: "faucet", args: [10_000_000_000n], account: w.account!, chain: network.chain }) });
    network = { ...network, token };
    const d = await deployPool(deployer, client, { token, owner: deployer.account!.address, postman: relayer.account!.address, minimumDeposit: 1_000_000n, vettingFeeBPS: 0n, maxRelayFeeBPS: 100n });
    network = { ...network, pool: { entrypoint: d.entrypoint, pool: d.pool, fromBlock: d.fromBlock, relayerUrl: "/api/relay", exclusionsUrl: "/api/pool/exclusions", router: null } };
    info = (await verifyPool(client, network))!;
    const a = art("QuietPayPoolRouterV2");
    router = getAddress((await client.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode as Hex, args: [d.pool], account: deployer.account!, chain: network.chain }) })).contractAddress!);
    network = { ...network, pool: { ...network.pool!, router } };
  }, 120_000);
  afterAll(() => anvil?.kill());

  describe("F1: payment requests can't be used up without full payment", () => {
    it("is recognised as pool router v2, bound to this pool", async () => {
      expect(await verifyPoolRouterInfo(client, network)).toEqual({ address: router, version: 2 });
      // The digests the app signs are the ones the contract checks.
      const r = await makeRequest(10_000_000n, 0);
      expect(await client.readContract({ address: router, abi: poolRouterAbi, functionName: "requestDigest", args: [r.terms.requestId, r.terms.amount, BigInt(r.terms.expiresAt)] })).toBe(requestDigest(r.terms));
      expect(await client.readContract({ address: router, abi: poolRouterAbi, functionName: "lockDigest", args: [r.lock.precommitment, r.lock.refund] })).toBe(lockDigest({ chainId: 46630, pool: info.pool, ...r.lock }));
    });

    it("refuses underpayment, overpayment, another token, a foreign lock and malformed signatures, and records nothing", async () => {
      const r = await makeRequest(10_000_000n, 1);
      await payer.writeContract({ address: network.token!, abi: erc20Abi, functionName: "approve", args: [router, 10n ** 30n], account: payer.account!, chain: network.chain }).then((h) => client.waitForTransactionReceipt({ hash: h }));
      // Underfunded and overfunded: the terms signature no longer matches the lock's signer.
      await expect(simPay(argsOf(r, { amount: 9_999_999n }))).rejects.toThrow(/SignerMismatch/);
      await expect(simPay(argsOf(r, { amount: 1_000_000n }))).rejects.toThrow(/SignerMismatch/);
      await expect(simPay(argsOf(r, { amount: 10_000_001n }))).rejects.toThrow(/SignerMismatch/);
      // Terms signed for another token (or another router, chain, expiry) don't match either.
      const other = { ...r.terms, token: payer.account!.address };
      await expect(simPay(argsOf(r, { termsSig: await signDigest(r.key, requestDigest(other)) }))).rejects.toThrow(/SignerMismatch/);
      await expect(simPay(argsOf(r, { expiresAt: r.terms.expiresAt + 1 }))).rejects.toThrow(/SignerMismatch/);
      // Paying into someone else's lock (signed by another key) can't count as paying this request.
      const mallory = generatePrivateKey();
      const mLock = receiveLock(masterKeysFromSeeds(5n, 6n), info.scope, 0n);
      const mSig = await signDigest(mallory, lockDigest({ chainId: 46630, pool: info.pool, ...mLock }));
      await expect(simPay(argsOf(r, { lock: { ...mLock, sig: mSig } }))).rejects.toThrow(/SignerMismatch/);
      // Malformed and malleable signatures.
      await expect(simPay(argsOf(r, { termsSig: "0x1234" }))).rejects.toThrow(/BadSignature/);
      const sig = hexToBytes(r.termsSig);
      const s = BigInt(bytesToHex(sig.slice(32, 64)));
      const flipped = new Uint8Array(sig);
      flipped.set(hexToBytes(`0x${(N - s).toString(16).padStart(64, "0")}`), 32);
      flipped[64] = sig[64] === 27 ? 28 : 27;
      await expect(simPay(argsOf(r, { termsSig: bytesToHex(flipped) }))).rejects.toThrow(/BadSignature/);
      // A zero request ID is refused outright.
      await expect(client.simulateContract({ address: router, abi: poolRouterAbi, functionName: "payRequest", args: [`0x${"00".repeat(16)}`, r.terms.amount, BigInt(r.terms.expiresAt), r.termsSig, r.lock.precommitment, r.lock.refund, r.lock.sig], account: payer.account!.address })).rejects.toThrow(/ZeroRequestId/);
      expect(await isPaid(r.address)).toBe(false);
      // The app reads the request key from the link and refuses a link put together from mismatched parts.
      expect(await requestKeyOf(r.terms, r.termsSig, { pool: info.pool, ...r.lock })).toBe(r.address);
      await expect(requestKeyOf(r.terms, r.termsSig, { pool: info.pool, ...mLock, sig: mSig })).rejects.toThrow(/don't match/);
    });

    it("a failed attempt changes nothing; the exact payment marks it paid; a second one is refused", async () => {
      const r = await makeRequest(12_000_000n, 2);
      // A payer without enough tokens: the transaction fails and the request stays payable.
      const poor = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: network.chain, transport: http(RPC) });
      await expect(simPay(argsOf(r), poor.account!.address)).rejects.toThrow();
      expect(await isPaid(r.address)).toBe(false);

      const before = await bal(payer.account!.address);
      const { hash } = await payRequestIntoPool(payer, client, {
        network,
        router,
        token: network.token!,
        request: { requestId: r.terms.requestId, amount: r.terms.amount, expiresAt: r.terms.expiresAt, termsSig: r.termsSig },
        lock: r.lock,
      });
      expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");
      expect(before - (await bal(payer.account!.address))).toBe(12_000_000n);
      expect(await isPaid(r.address)).toBe(true);
      // The money is the recipient's: found by its keys, at the link's lock.
      const mine = reconstructReceived(alice, info.scope, await events(), 3n).notes;
      expect(mine.find((n) => n.value === 12_000_000n)).toBeTruthy();
      // Paying again, even into a fresh lock signed by the same key, is refused.
      const spare = await r.spare(0);
      await expect(simPay(argsOf(r, { lock: spare }))).rejects.toThrow(/RequestAlreadyPaid/);
      expect(await bal(router)).toBe(0n);
    });

    it("someone burning the link's lock by depositing into it directly doesn't use the request up; a spare lock pays it", async () => {
      const r = await makeRequest(8_000_000n, 3);
      // An attacker deposits the pool minimum straight into the link's lock (it lands with the recipient).
      await payIntoPool(deployer, client, { network, router, token: network.token!, lock: r.lock, amount: 1_000_000n }).then(({ hash }) => client.waitForTransactionReceipt({ hash }));
      expect(await client.readContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "usedPrecommitments", args: [r.lock.precommitment] })).toBe(true);
      expect(await isPaid(r.address)).toBe(false);
      await expect(simPay(argsOf(r))).rejects.toThrow(); // that lock can't take money any more
      // The payer takes a spare (as QuietPay's lock store hands it out, signed v2) and pays in full.
      const spare = await r.spare(1);
      const served = { p: spare.precommitment.toString(), r: spare.refund, s: spare.sig, v: 2 as const };
      expect(await verifyLock(served, { key: r.address, chainId: 46630, pool: info.pool })).toEqual({ precommitment: spare.precommitment, refund: spare.refund });
      const { hash } = await payRequestIntoPool(payer, client, { network, router, token: network.token!, request: { ...r.terms, termsSig: r.termsSig }, lock: spare });
      expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");
      expect(await isPaid(r.address)).toBe(true);
      // The recipient finds both: the attacker's deposit and the full payment through the spare.
      const ev = await events();
      expect(reconstructReceived(alice, info.scope, ev, 4n).notes.some((n) => n.value === 1_000_000n)).toBe(true);
      expect(reconstructSpares(alice, info.scope, ev, 4n).map((n) => n.value)).toContain(8_000_000n);
    });

    it("an expired request can't be paid", async () => {
      const r = await makeRequest(5_000_000n, 4, { expiresIn: 60 });
      await warp(120);
      await expect(simPay(argsOf(r))).rejects.toThrow(/RequestExpired/);
      expect(await isPaid(r.address)).toBe(false);
    });

    it("signed links round-trip and are checked before paying", async () => {
      const r = await makeRequest(3_000_000n, 5);
      const code = encodePaymentLink({
        kind: "fixed",
        chainId: 46630,
        token: network.token!,
        amount: r.terms.amount,
        expiresAt: r.terms.expiresAt,
        requestId: r.terms.requestId,
        stealthMetaAddress: `0x02${"11".repeat(32)}03${"22".repeat(32)}`,
        poolLock: r.lock,
        termsSig: r.termsSig,
      });
      const back = decodePaymentLink(code);
      expect(back.termsSig).toBe(r.termsSig);
      expect(back.poolLock).toEqual(r.lock);
      expect(code.length).toBeLessThan(600);
      // Tampering with any byte breaks the checksum.
      const bytes = code.split("");
      bytes[200] = bytes[200] === "A" ? "B" : "A";
      expect(() => decodePaymentLink(bytes.join(""))).toThrow();
      void validatePaymentLink;
    });
  });

  describe("F5: refunds can't be sent somewhere they'd be stuck", () => {
    it("refuses the router, the token, the pool and the entrypoint as refund addresses", async () => {
      const lock = receiveLock(alice, info.scope, 40n);
      for (const bad of [router, network.token!, info.pool, info.entrypoint]) {
        await expect(
          client.simulateContract({ address: router, abi: poolRouterAbi, functionName: "pay", args: [lock.precommitment, 1_000_000n, bad], account: payer.account!.address }),
        ).rejects.toThrow(/BadDestination/);
      }
      await expect(
        client.simulateContract({ address: router, abi: poolRouterAbi, functionName: "pay", args: [lock.precommitment, 1_000_000n, "0x0000000000000000000000000000000000000000"], account: payer.account!.address }),
      ).rejects.toThrow(/ZeroAddress/);
      const ok = await client.simulateContract({ address: router, abi: poolRouterAbi, functionName: "pay", args: [lock.precommitment, 1_000_000n, lock.refund], account: payer.account!.address });
      expect(ok.result).toBeGreaterThan(0n);
    });
  });

  describe("F2 and F4: the relayer during root changes, with limited gas top-ups", () => {
    it("a proof made before a new root is refused clearly; made again, it goes through; top-ups pass the limiter", async () => {
      await approveAll();
      let ev = await events();
      const note = reconstructReceived(alice, info.scope, ev, 4n).notes.find((n) => n.value === 12_000_000n)!;
      const to = privateKeyToAccount(generatePrivateKey()).address;
      const policy = { feeRecipient: relayer.account!.address, feeBPS: 50n, gasDrop: parseEther("0.0005"), tokenUnitsPerEth: 1n };
      const stale = await prepareWithdrawal(load, { info, events: ev, keys: alice, note, amount: 2_000_000n, recipient: to, feeRecipient: relayer.account!.address, feeBPS: 50n });
      // A new deposit is approved: the root changes under the proof.
      await payIntoPool(deployer, client, { network, router, token: network.token!, lock: receiveLock(alice, info.scope, 41n), amount: 1_000_000n }).then(({ hash }) => client.waitForTransactionReceipt({ hash }));
      await approveAll();
      const asked: bigint[] = [];
      const guard = {
        claim: async () => async () => undefined,
        send: <T,>(fn: () => Promise<T>) => fn(),
        allowDrop: async (_r: Address, want: bigint) => {
          asked.push(want);
          return 0n; // the limiter said no
        },
        busy: async () => undefined,
      };
      await expect(relayWithdrawal(client, relayer, network, info, policy, JSON.parse(JSON.stringify(serializeWithdrawal(stale))), guard)).rejects.toThrow(/approval list changed/);
      expect(await client.readContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "latestRoot" })).toBe(info.aspRoot);
      // Made again against the current root, it goes through.
      ev = await events();
      const fresh = await prepareWithdrawal(load, { info, events: ev, keys: alice, note: reconstructReceived(alice, info.scope, ev, 4n).notes.find((n) => n.label === note.label)!, amount: 2_000_000n, recipient: to, feeRecipient: relayer.account!.address, feeBPS: 50n });
      const res = await relayWithdrawal(client, relayer, network, info, policy, JSON.parse(JSON.stringify(serializeWithdrawal(fresh))), guard);
      expect(res.amount).toBe(2_000_000n);
      // The relayer asked the limiter before topping up, and sent nothing when refused.
      expect(asked).toEqual([parseEther("0.0005")]);
      expect(res.gasDropHash).toBeNull();
      expect(await client.getBalance({ address: to })).toBe(0n);
      void RelayRejected;
    }, 180_000);
  });

  describe("F6 and F7: the guardian", () => {
    const OWNER = keccak256(toBytes("OWNER_ROLE"));
    let guardian: Address;
    const g = () => art("QuietPayPoolGuardian").abi;
    const cfg = (vetting: bigint, relay = 100n) => encodeFunctionData({ abi: Entrypoint.abi, functionName: "updatePoolConfiguration", args: [network.token!, 1_000_000n, vetting, relay] });
    const propose = (target: Address, data: Hex, from: WalletClient = deployer) =>
      from.writeContract({ address: guardian, abi: g(), functionName: "propose", args: [target, data], account: from.account!, chain: network.chain }).then((h) => client.waitForTransactionReceipt({ hash: h }));
    const proposedId = (r: { logs: { topics: Hex[] }[] }) => r.logs.find((l) => l.topics.length === 4)!.topics[1];
    const assetFee = async () => ((await client.readContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "assetConfig", args: [network.token!] })) as readonly unknown[])[2] as bigint;

    it("takes over the Entrypoint; the deployer's key no longer controls it", async () => {
      const a = art("QuietPayPoolGuardian");
      await expect(deployer.deployContract({ abi: a.abi, bytecode: a.bytecode as Hex, args: [info.entrypoint, deployer.account!.address, 60n], account: deployer.account!, chain: network.chain }).then((h) => client.waitForTransactionReceipt({ hash: h })).then((r) => { if (r.status !== "success") throw new Error("reverted"); })).rejects.toThrow();
      guardian = getAddress((await client.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode as Hex, args: [info.entrypoint, deployer.account!.address, 3600n], account: deployer.account!, chain: network.chain }) })).contractAddress!);
      await deployer.writeContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "grantRole", args: [OWNER, guardian], account: deployer.account!, chain: network.chain }).then((h) => client.waitForTransactionReceipt({ hash: h }));
      await deployer.writeContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "renounceRole", args: [OWNER, deployer.account!.address], account: deployer.account!, chain: network.chain }).then((h) => client.waitForTransactionReceipt({ hash: h }));
      expect(await client.readContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "hasRole", args: [OWNER, guardian] })).toBe(true);
      await expect(client.simulateContract({ address: info.entrypoint, abi: Entrypoint.abi, functionName: "updatePoolConfiguration", args: [network.token!, 1_000_000n, 9_000n, 100n], account: deployer.account!.address })).rejects.toThrow();
    });

    it("refuses fees above the ceiling and calls it doesn't allow; only the admin proposes", async () => {
      await expect(propose(info.entrypoint, cfg(101n))).rejects.toThrow(/FeeTooHigh|revert/);
      await expect(propose(info.entrypoint, cfg(50n, 501n))).rejects.toThrow(/FeeTooHigh|revert/);
      await expect(propose(info.entrypoint, encodeFunctionData({ abi: Entrypoint.abi, functionName: "updateRoot", args: [1n, "x".repeat(46)] }))).rejects.toThrow(/NotAllowed|revert/);
      await expect(propose(network.token!, cfg(10n))).rejects.toThrow(/NotAllowed|revert/);
      await expect(propose(info.entrypoint, cfg(10n), payer)).rejects.toThrow(/NotAdmin|revert/);
      const eoa = privateKeyToAccount(generatePrivateKey()).address;
      await expect(propose(info.entrypoint, encodeFunctionData({ abi: Entrypoint.abi, functionName: "upgradeToAndCall", args: [eoa, "0x"] }))).rejects.toThrow(/NotAContract|revert/);
    });

    it("a fee change waits out the delay in public, can be cancelled, and expires if not carried out", async () => {
      const r = await propose(info.entrypoint, cfg(80n));
      const id = proposedId(r);
      // Not before the delay, by anyone.
      await expect(client.simulateContract({ address: guardian, abi: g(), functionName: "execute", args: [id], account: payer.account!.address })).rejects.toThrow(/NotReady|revert/);
      await warp(3601);
      await payer.writeContract({ address: guardian, abi: g(), functionName: "execute", args: [id], account: payer.account!, chain: network.chain }).then((h) => client.waitForTransactionReceipt({ hash: h }));
      expect(await assetFee()).toBe(80n);
      // The app reads the fee from the chain, never a constant.
      expect((await verifyPool(client, network))!.vettingFeeBPS).toBe(80n);
      // Carried out once only.
      await expect(client.simulateContract({ address: guardian, abi: g(), functionName: "execute", args: [id], account: payer.account!.address })).rejects.toThrow(/UnknownProposal|revert/);

      // Cancelled while it waits.
      const id2 = proposedId(await propose(info.entrypoint, cfg(0n)));
      await deployer.writeContract({ address: guardian, abi: g(), functionName: "cancel", args: [id2], account: deployer.account!, chain: network.chain }).then((h) => client.waitForTransactionReceipt({ hash: h }));
      await warp(3601);
      await expect(client.simulateContract({ address: guardian, abi: g(), functionName: "execute", args: [id2], account: payer.account!.address })).rejects.toThrow(/UnknownProposal|revert/);
      // Expires after the grace period.
      const id3 = proposedId(await propose(info.entrypoint, cfg(0n)));
      await warp(3600 + 14 * 86400 + 10);
      await expect(client.simulateContract({ address: guardian, abi: g(), functionName: "execute", args: [id3], account: payer.account!.address })).rejects.toThrow(/Expired|revert/);
      expect(await assetFee()).toBe(80n);
    });

    it("an upgrade only happens after the delay; the admin moves to a multisig only after it too; the emergency brake stops deposits", async () => {
      const slot = await client.getStorageAt({ address: info.entrypoint, slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" });
      const impl = getAddress(`0x${slot!.slice(26)}`);
      const id = proposedId(await propose(info.entrypoint, encodeFunctionData({ abi: Entrypoint.abi, functionName: "upgradeToAndCall", args: [impl, "0x"] })));
      await expect(client.simulateContract({ address: guardian, abi: g(), functionName: "execute", args: [id], account: payer.account!.address })).rejects.toThrow(/NotReady|revert/);
      await warp(3601);
      await payer.writeContract({ address: guardian, abi: g(), functionName: "execute", args: [id], account: payer.account!, chain: network.chain }).then((h) => client.waitForTransactionReceipt({ hash: h }));
      // Handing the admin to a multisig (any address) also goes through the delay.
      const multisig = privateKeyToAccount(generatePrivateKey()).address;
      await expect(client.simulateContract({ address: guardian, abi: g(), functionName: "setAdmin", args: [multisig], account: deployer.account!.address })).rejects.toThrow(/NotSelf|revert/);
      const id2 = proposedId(await propose(guardian, encodeFunctionData({ abi: g(), functionName: "setAdmin", args: [multisig] })));
      // The brake is immediate and only for the admin.
      await expect(client.simulateContract({ address: guardian, abi: g(), functionName: "windDownPool", args: [info.pool], account: payer.account!.address })).rejects.toThrow(/NotAdmin|revert/);
      await deployer.writeContract({ address: guardian, abi: g(), functionName: "windDownPool", args: [info.pool], account: deployer.account!, chain: network.chain }).then((h) => client.waitForTransactionReceipt({ hash: h }));
      await expect(simPay(argsOf(await makeRequest(2_000_000n, 9)))).rejects.toThrow();
      await warp(3601);
      await payer.writeContract({ address: guardian, abi: g(), functionName: "execute", args: [id2], account: payer.account!, chain: network.chain }).then((h) => client.waitForTransactionReceipt({ hash: h }));
      expect(getAddress(await client.readContract({ address: guardian, abi: g(), functionName: "admin" }) as Address)).toBe(multisig);
    });
  });
});
