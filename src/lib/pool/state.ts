/**
 * Reads the shielded pool's public state from chain events and rebuilds the user's notes.
 *
 * Everything here is public data: the RPC only sees which contract and block ranges are read,
 * never which notes belong to whom. Matching happens locally with keys derived in the browser.
 */
import { keccak256, stringToBytes, type Address, type PublicClient } from "viem";
import { Entrypoint, PrivacyPoolComplex } from "@/config/pool-contracts.generated";
import {
  commitmentHash,
  depositSecrets,
  nullifierHash,
  precommitmentHash,
  treeRoot,
  withdrawalSecrets,
  type NoteSecrets,
  type PoolMasterKeys,
} from "./crypto";

export interface PoolDeposit {
  depositor: Address;
  commitment: bigint;
  label: bigint;
  value: bigint;
  precommitment: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}
export interface PoolWithdrawal {
  value: bigint;
  spentNullifier: bigint;
  newCommitment: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}
export interface PoolRagequit {
  ragequitter: Address;
  commitment: bigint;
  label: bigint;
  value: bigint;
  txHash: `0x${string}`;
}
export interface RootUpdate {
  root: bigint;
  cid: string;
  timestamp: bigint;
  blockNumber: bigint;
}

export interface PoolEvents {
  deposits: PoolDeposit[];
  withdrawals: PoolWithdrawal[];
  ragequits: PoolRagequit[];
  /** State tree leaves in insertion order (deposits and change notes). */
  leaves: bigint[];
  rootUpdates: RootUpdate[];
  toBlock: bigint;
  /** The exclusion list the latest approval rule refers to, when it has one and it was loaded. */
  exclusions?: { id: string; labels: bigint[] };
}

/**
 * Splits [fromBlock, toBlock] into chunks and fetches them `parallel` at a time. A chunk the RPC
 * refuses is split in half and retried, down to 100 blocks.
 */
async function chunked<T>(
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
  parallel = 6,
): Promise<T[]> {
  const size = chunkSize > 0n ? chunkSize : 10_000n;
  const ranges: [bigint, bigint][] = [];
  for (let s = fromBlock; s <= toBlock; s += size) ranges.push([s, s + size - 1n > toBlock ? toBlock : s + size - 1n]);
  const get = async (from: bigint, to: bigint): Promise<T[]> => {
    try {
      return await fetch(from, to);
    } catch (e) {
      if (to - from < 100n) throw e;
      const mid = from + (to - from) / 2n;
      return [...(await get(from, mid)), ...(await get(mid + 1n, to))];
    }
  };
  const out: T[][] = new Array(ranges.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, ranges.length) }, async () => {
      while (next < ranges.length) {
        const i = next++;
        out[i] = await get(ranges[i][0], ranges[i][1]);
      }
    }),
  );
  return out.flat();
}

const order = (a: { blockNumber: bigint; logIndex: number }, b: { blockNumber: bigint; logIndex: number }) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

/* ---------------- Cached, incremental event loading ---------------- */

/**
 * Pool history only grows, so it is loaded once and then only the new blocks are fetched
 * (re-reading the last REORG_MARGIN blocks in case the chain reorganised). It is kept in memory
 * and, in the browser, in localStorage: it is public chain data, so the next visit opens from
 * the saved copy and only catches up. A copy that doesn't add up (the rebuilt tree doesn't match
 * the chain's root, or it is ahead of the chain) is thrown away and history is loaded again.
 */
const REORG_MARGIN = 300n;
const CACHE_VERSION = 1;

interface LogRecords {
  deposits: PoolDeposit[];
  withdrawals: PoolWithdrawal[];
  ragequits: (PoolRagequit & { blockNumber: bigint })[];
  leafs: { index: bigint; leaf: bigint; root: bigint; blockNumber: bigint }[];
  rootUpdates: RootUpdate[];
  toBlock: bigint;
}

const memory = new Map<string, LogRecords>();
const storageKey = (k: string) => `quietpay:pool-log:v${CACHE_VERSION}:${k}`;

function toJson(r: LogRecords): string {
  return JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v));
}
function fromJson(s: string): LogRecords | null {
  try {
    return JSON.parse(s, (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as LogRecords;
  } catch {
    return null;
  }
}
function loadCached(key: string): LogRecords | null {
  const m = memory.get(key);
  if (m) return m;
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(storageKey(key));
    return raw ? fromJson(raw) : null;
  } catch {
    return null;
  }
}
function saveCached(key: string, r: LogRecords) {
  memory.set(key, r);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(storageKey(key), toJson(r));
  } catch {
    /* storage full or blocked: memory copy still helps this visit */
  }
}

async function fetchRecords(client: PublicClient, p: { entrypoint: Address; pool: Address; chunkSize: bigint }, fromBlock: bigint, toBlock: bigint): Promise<LogRecords> {
  const [poolLogs, epLogs] = await Promise.all([
    chunked(fromBlock, toBlock, p.chunkSize, (from, to) => client.getContractEvents({ address: p.pool, abi: PrivacyPoolComplex.abi, fromBlock: from, toBlock: to, strict: true })),
    chunked(fromBlock, toBlock, p.chunkSize, (from, to) =>
      client.getContractEvents({ address: p.entrypoint, abi: Entrypoint.abi, eventName: "RootUpdated", fromBlock: from, toBlock: to, strict: true }),
    ),
  ]);
  poolLogs.sort(order);
  epLogs.sort(order);
  const r: LogRecords = { deposits: [], withdrawals: [], ragequits: [], leafs: [], rootUpdates: [], toBlock };
  for (const l of poolLogs) {
    if (l.eventName === "Deposited") {
      const a = l.args as { _depositor: Address; _commitment: bigint; _label: bigint; _value: bigint; _precommitmentHash: bigint };
      r.deposits.push({ depositor: a._depositor, commitment: a._commitment, label: a._label, value: a._value, precommitment: a._precommitmentHash, blockNumber: l.blockNumber, txHash: l.transactionHash });
    } else if (l.eventName === "Withdrawn") {
      const a = l.args as { _value: bigint; _spentNullifier: bigint; _newCommitment: bigint };
      r.withdrawals.push({ value: a._value, spentNullifier: a._spentNullifier, newCommitment: a._newCommitment, blockNumber: l.blockNumber, txHash: l.transactionHash });
    } else if (l.eventName === "Ragequit") {
      const a = l.args as { _ragequitter: Address; _commitment: bigint; _label: bigint; _value: bigint };
      r.ragequits.push({ ragequitter: a._ragequitter, commitment: a._commitment, label: a._label, value: a._value, txHash: l.transactionHash, blockNumber: l.blockNumber });
    } else if (l.eventName === "LeafInserted") {
      // The contract emits the tree size after insertion, so the first leaf has _index 1.
      const a = l.args as { _index: bigint; _leaf: bigint; _root: bigint };
      r.leafs.push({ index: a._index - 1n, leaf: a._leaf, root: a._root, blockNumber: l.blockNumber });
    }
  }
  for (const l of epLogs) {
    const a = l.args as { _root: bigint; _ipfsCID: string; _timestamp: bigint };
    r.rootUpdates.push({ root: a._root, cid: a._ipfsCID, timestamp: a._timestamp, blockNumber: l.blockNumber });
  }
  return r;
}

function merge(base: LogRecords, from: bigint, add: LogRecords): LogRecords {
  const keep = <T extends { blockNumber: bigint }>(xs: T[]) => xs.filter((x) => x.blockNumber < from);
  return {
    deposits: [...keep(base.deposits), ...add.deposits],
    withdrawals: [...keep(base.withdrawals), ...add.withdrawals],
    ragequits: [...keep(base.ragequits), ...add.ragequits],
    leafs: [...keep(base.leafs), ...add.leafs],
    rootUpdates: [...keep(base.rootUpdates), ...add.rootUpdates],
    toBlock: add.toBlock,
  };
}

/** Rebuilds the tree's leaves and checks them against the chain's latest root. Null if they don't add up. */
function leavesOf(r: LogRecords): bigint[] | null {
  const byIndex = new Map<bigint, bigint>();
  for (const l of r.leafs) byIndex.set(l.index, l.leaf);
  const leaves: bigint[] = [];
  for (let i = 0n; i < BigInt(byIndex.size); i++) {
    const leaf = byIndex.get(i);
    if (leaf === undefined) return null;
    leaves.push(leaf);
  }
  const last = r.leafs.reduce<(typeof r.leafs)[number] | null>((m, l) => (!m || l.index > m.index ? l : m), null);
  if (leaves.length && (!last || treeRoot(leaves) !== last.root)) return null;
  return leaves;
}

/** Forgets saved pool history (tests, or a site switching chains). */
export function clearPoolEventCache() {
  memory.clear();
}

export async function fetchPoolEvents(
  client: PublicClient,
  p: { entrypoint: Address; pool: Address; fromBlock: bigint; chunkSize: bigint; toBlock?: bigint; exclusions?: ExclusionLoader; noCache?: boolean },
): Promise<PoolEvents> {
  const toBlock = p.toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const key = `${(client.chain?.id ?? 0).toString()}:${p.pool.toLowerCase()}:${p.entrypoint.toLowerCase()}:${p.fromBlock.toString()}`;
  let cached = p.noCache || p.toBlock !== undefined ? null : loadCached(key);
  if (cached && cached.toBlock > toBlock) cached = null; // ahead of the chain: a different chain or a reset
  let records: LogRecords;
  let leaves: bigint[] | null = null;
  if (cached) {
    const from = cached.toBlock - REORG_MARGIN + 1n > p.fromBlock ? cached.toBlock - REORG_MARGIN + 1n : p.fromBlock;
    records = merge(cached, from, await fetchRecords(client, p, from, toBlock));
    leaves = leavesOf(records);
  }
  if (!cached || !leaves) {
    records = await fetchRecords(client, p, p.fromBlock, toBlock);
    leaves = leavesOf(records);
    if (!leaves) throw new Error("Rebuilt pool tree does not match the onchain root.");
  }
  if (!p.noCache && p.toBlock === undefined) saveCached(key, records!);
  const { deposits, withdrawals, rootUpdates } = records!;
  const ragequits: PoolRagequit[] = records!.ragequits.map(({ blockNumber: _b, ...r }) => r);
  let exclusions: PoolEvents["exclusions"];
  const rule = rootUpdates.length ? parseAspDescriptor(rootUpdates[rootUpdates.length - 1].cid) : null;
  if (rule?.exclusionId && p.exclusions) {
    const labels = await p.exclusions(rule.exclusionId);
    if (labels) exclusions = { id: rule.exclusionId, labels };
  }
  return { deposits, withdrawals, ragequits, leaves: leaves!, rootUpdates, toBlock, exclusions };
}

export type NoteStatus = "spendable" | "spent" | "ragequit";

export interface PoolNote {
  /** Deposit index for this scope (which secrets were used). */
  depositIndex: bigint;
  label: bigint;
  /** Current value of the note (deposit minus withdrawals so far). */
  value: bigint;
  /** Secrets of the current (latest) commitment in this deposit's chain. */
  secrets: NoteSecrets;
  commitment: bigint;
  /** Withdrawals already made from this deposit; the next change note uses this index. */
  withdrawalCount: bigint;
  status: NoteStatus;
  deposit: PoolDeposit;
  history: PoolWithdrawal[];
}

/**
 * Rebuilds the user's notes by trying deposit indexes 0, 1, 2... until one is not found, then
 * following each deposit's withdrawal chain through the published nullifier hashes.
 */
export function reconstructNotes(keys: PoolMasterKeys, scope: bigint, ev: PoolEvents, maxGap = 3): { notes: PoolNote[]; nextDepositIndex: bigint } {
  const m = noteMaps(ev);
  const notes: PoolNote[] = [];
  let misses = 0;
  let nextDepositIndex = 0n;
  for (let i = 0n; misses < maxGap; i++) {
    const s = depositSecrets(keys, scope, i);
    const dep = m.byPrecommitment.get(precommitmentHash(s));
    if (!dep) {
      misses++;
      continue;
    }
    misses = 0;
    nextDepositIndex = i + 1n;
    notes.push(followNote(keys, m, dep, s, i));
  }
  return { notes, nextDepositIndex };
}

/**
 * Payments received straight into the pool use their own index range, so handing out locks
 * (some never paid) can't leave gaps in the user's own deposits. Receive lock i uses deposit
 * index RECEIVE_INDEX_BASE + i.
 */
export const RECEIVE_INDEX_BASE = 1n << 64n;
export const receiveSecrets = (keys: PoolMasterKeys, scope: bigint, i: bigint) => depositSecrets(keys, scope, RECEIVE_INDEX_BASE + i);

/**
 * Notes for payments received into the pool: checks every lock handed out so far (`issued`),
 * then keeps going until `maxGap` locks in a row are unused, which finds locks handed out on
 * another device.
 */
export function reconstructReceived(
  keys: PoolMasterKeys,
  scope: bigint,
  ev: PoolEvents,
  issued: bigint,
  maxGap = 20,
  /** First receive index of the range (0 for one-time links, PERSONAL_INDEX_BASE for personal locks). */
  offset = 0n,
): { notes: PoolNote[]; nextReceiveIndex: bigint } {
  const m = noteMaps(ev);
  const notes: PoolNote[] = [];
  let next = issued;
  let misses = 0;
  for (let i = 0n; i < issued || misses < maxGap; i++) {
    const s = receiveSecrets(keys, scope, offset + i);
    const dep = m.byPrecommitment.get(precommitmentHash(s));
    if (!dep) {
      if (i >= issued) misses++;
      continue;
    }
    misses = 0;
    if (i + 1n > next) next = i + 1n;
    notes.push(followNote(keys, m, dep, s, RECEIVE_INDEX_BASE + offset + i));
  }
  return { notes, nextReceiveIndex: next };
}

function noteMaps(ev: PoolEvents) {
  return {
    byPrecommitment: new Map(ev.deposits.map((d) => [d.precommitment, d])),
    withdrawalByNullifier: new Map(ev.withdrawals.map((w) => [w.spentNullifier, w])),
    ragequitByCommitment: new Map(ev.ragequits.map((r) => [r.commitment, r])),
  };
}

/** Follows a deposit's withdrawal chain through the published nullifier hashes. */
function followNote(keys: PoolMasterKeys, m: ReturnType<typeof noteMaps>, dep: PoolDeposit, s: NoteSecrets, depositIndex: bigint): PoolNote {
  let secrets = s;
  let value = dep.value;
  let commitment = dep.commitment;
  let count = 0n;
  const history: PoolWithdrawal[] = [];
  let status: NoteStatus = "spendable";
  for (;;) {
    if (m.ragequitByCommitment.has(commitment)) {
      status = "ragequit";
      break;
    }
    const w = m.withdrawalByNullifier.get(nullifierHash(secrets));
    if (!w) break;
    const next = withdrawalSecrets(keys, dep.label, count);
    const nextValue = value - w.value;
    if (commitmentHash(nextValue, dep.label, next) !== w.newCommitment) throw new Error("Pool note chain does not match the chain history.");
    history.push(w);
    secrets = next;
    value = nextValue;
    commitment = w.newCommitment;
    count++;
  }
  if (status === "spendable" && value === 0n) status = "spent";
  return { depositIndex, label: dep.label, value, secrets, commitment, withdrawalCount: count, status, deposit: dep, history };
}

/**
 * Approval (ASP) roots. QuietPay's approver publishes a rule instead of a file, in the
 * Entrypoint's 32 to 64 character "IPFS CID" field:
 *
 *   quietpay-asp-v1:upto=<block>          every deposit label up to <block>, in deposit order
 *   quietpay-asp-v2:upto=<block>:x=<id>   the same, minus the labels in exclusion list <id>
 *
 * Exclusion lists hold deposits that failed screening (src/lib/screening). Each version is
 * published at /api/pool/exclusions?x=<id>, where <id> is the first 8 bytes of the keccak-256 of
 * its labels (ascending, decimal, comma-separated). Anyone can rebuild the approved set from the
 * chain plus that list and check that its root matches the onchain root, so the list can't be
 * swapped without it showing.
 */
export const ASP_DESCRIPTOR_PREFIX = "quietpay-asp-v1:upto=";
const ASP_V2 = /^quietpay-asp-v2:upto=(\d{1,30}):x=([0-9a-f]{16})$/;

/** The id of an exclusion list (also checks it is in canonical order). */
export function exclusionListId(labels: bigint[]): string {
  const sorted = [...labels].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keccak256(stringToBytes(sorted.map((l) => l.toString()).join(","))).slice(2, 18);
}

export function encodeAspDescriptor(uptoBlock: bigint, exclusionId?: string | null): string {
  const block = uptoBlock.toString().padStart(18, "0");
  const s = exclusionId ? `quietpay-asp-v2:upto=${block}:x=${exclusionId}` : `${ASP_DESCRIPTOR_PREFIX}${block}`;
  if (s.length < 32 || s.length > 64) throw new Error("ASP descriptor length out of range.");
  return s;
}

export function parseAspDescriptor(cid: string): { uptoBlock: bigint; exclusionId: string | null } | null {
  const v2 = ASP_V2.exec(cid);
  if (v2) return { uptoBlock: BigInt(v2[1]), exclusionId: v2[2] };
  if (!cid.startsWith(ASP_DESCRIPTOR_PREFIX)) return null;
  const n = cid.slice(ASP_DESCRIPTOR_PREFIX.length);
  return /^\d{1,30}$/.test(n) ? { uptoBlock: BigInt(n), exclusionId: null } : null;
}

export function aspLabels(deposits: PoolDeposit[], uptoBlock: bigint, excluded: Iterable<bigint> = []): bigint[] {
  const x = new Set([...excluded].map((l) => l.toString()));
  return deposits.filter((d) => d.blockNumber <= uptoBlock && !x.has(d.label.toString())).map((d) => d.label);
}

export interface ApprovalSet {
  root: bigint;
  labels: bigint[];
  uptoBlock: bigint;
  /** Deposits up to `uptoBlock` that failed screening. They can only exit to their depositor. */
  excluded: bigint[];
}

/** Fetches an exclusion list by id. Returns null if it can't be had. */
export type ExclusionLoader = (id: string) => Promise<bigint[] | null>;

/** Loads exclusion lists from the site's public endpoint, checking each against its id. */
export function httpExclusions(url: string): ExclusionLoader {
  const cache = new Map<string, bigint[]>();
  return async (id) => {
    if (cache.has(id)) return cache.get(id)!;
    try {
      const r = await fetch(`${url}?x=${id}`, { cache: "force-cache" });
      if (!r.ok) return null;
      const j = (await r.json()) as { labels?: unknown };
      if (!Array.isArray(j.labels) || !j.labels.every((x) => typeof x === "string" && /^\d{1,78}$/.test(x))) return null;
      const labels = (j.labels as string[]).map((x) => BigInt(x));
      if (exclusionListId(labels) !== id) return null;
      cache.set(id, labels);
      return labels;
    } catch {
      return null;
    }
  };
}

/**
 * The current approval set, rebuilt from the latest root update and checked against
 * `onchainRoot`. A v2 rule needs its exclusion list, attached by fetchPoolEvents (`excluded`).
 */
export function currentApprovalSet(ev: PoolEvents, onchainRoot: bigint): ApprovalSet | null {
  const last = ev.rootUpdates.at(-1);
  if (!last || last.root !== onchainRoot) return null;
  const d = parseAspDescriptor(last.cid);
  if (!d) return null;
  let excluded: bigint[] = [];
  if (d.exclusionId) {
    if (!ev.exclusions || ev.exclusions.id !== d.exclusionId) return null;
    excluded = ev.exclusions.labels;
  }
  const labels = aspLabels(ev.deposits, d.uptoBlock, excluded);
  if (treeRoot(labels) !== onchainRoot) return null;
  const x = new Set(excluded.map(String));
  const excludedHere = ev.deposits.filter((dep) => dep.blockNumber <= d.uptoBlock && x.has(dep.label.toString())).map((dep) => dep.label);
  return { root: onchainRoot, labels, uptoBlock: d.uptoBlock, excluded: excludedHere };
}

const loaders = new Map<string, ExclusionLoader>();
/** One shared, caching exclusion-list loader per endpoint (browser side). */
export function exclusionsFrom(url: string): ExclusionLoader {
  if (!loaders.has(url)) loaders.set(url, httpExclusions(url));
  return loaders.get(url)!;
}

/**
 * Deposits the approver has excluded, including ones not yet in an onchain rule. Unverified and
 * for display only (to say a deposit won't be approved); approvals come from the onchain rule.
 */
export async function latestExclusions(url: string): Promise<Set<string>> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return new Set();
    const j = (await r.json()) as { labels?: unknown };
    return new Set(Array.isArray(j.labels) ? j.labels.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
