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

async function chunked<T>(
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let start = fromBlock;
  let chunk = chunkSize > 0n ? chunkSize : 10_000n;
  while (start <= toBlock) {
    const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
    try {
      out.push(...(await fetch(start, end)));
      start = end + 1n;
    } catch (e) {
      if (chunk <= 100n) throw e;
      chunk /= 2n;
    }
  }
  return out;
}

const order = (a: { blockNumber: bigint; logIndex: number }, b: { blockNumber: bigint; logIndex: number }) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

export async function fetchPoolEvents(
  client: PublicClient,
  p: { entrypoint: Address; pool: Address; fromBlock: bigint; chunkSize: bigint; toBlock?: bigint; exclusions?: ExclusionLoader },
): Promise<PoolEvents> {
  const toBlock = p.toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const poolLogs = await chunked(p.fromBlock, toBlock, p.chunkSize, (fromBlock, to) =>
    client.getContractEvents({ address: p.pool, abi: PrivacyPoolComplex.abi, fromBlock, toBlock: to, strict: true }),
  );
  const epLogs = await chunked(p.fromBlock, toBlock, p.chunkSize, (fromBlock, to) =>
    client.getContractEvents({ address: p.entrypoint, abi: Entrypoint.abi, eventName: "RootUpdated", fromBlock, toBlock: to, strict: true }),
  );
  poolLogs.sort(order);
  epLogs.sort(order);

  const deposits: PoolDeposit[] = [];
  const withdrawals: PoolWithdrawal[] = [];
  const ragequits: PoolRagequit[] = [];
  const leafByIndex = new Map<bigint, bigint>();
  let lastRoot = 0n;
  for (const l of poolLogs) {
    if (l.eventName === "Deposited") {
      const a = l.args as { _depositor: Address; _commitment: bigint; _label: bigint; _value: bigint; _precommitmentHash: bigint };
      deposits.push({
        depositor: a._depositor,
        commitment: a._commitment,
        label: a._label,
        value: a._value,
        precommitment: a._precommitmentHash,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
      });
    } else if (l.eventName === "Withdrawn") {
      const a = l.args as { _value: bigint; _spentNullifier: bigint; _newCommitment: bigint };
      withdrawals.push({ value: a._value, spentNullifier: a._spentNullifier, newCommitment: a._newCommitment, blockNumber: l.blockNumber, txHash: l.transactionHash });
    } else if (l.eventName === "Ragequit") {
      const a = l.args as { _ragequitter: Address; _commitment: bigint; _label: bigint; _value: bigint };
      ragequits.push({ ragequitter: a._ragequitter, commitment: a._commitment, label: a._label, value: a._value, txHash: l.transactionHash });
    } else if (l.eventName === "LeafInserted") {
      // The contract emits the tree size after insertion, so the first leaf has _index 1.
      const a = l.args as { _index: bigint; _leaf: bigint; _root: bigint };
      leafByIndex.set(a._index - 1n, a._leaf);
      lastRoot = a._root;
    }
  }
  const leaves: bigint[] = [];
  for (let i = 0n; i < BigInt(leafByIndex.size); i++) {
    const leaf = leafByIndex.get(i);
    if (leaf === undefined) throw new Error(`Pool history is incomplete: missing leaf ${i}.`);
    leaves.push(leaf);
  }
  if (leaves.length && treeRoot(leaves) !== lastRoot) throw new Error("Rebuilt pool tree does not match the onchain root.");
  const rootUpdates = epLogs.map((l) => {
    const a = l.args as { _root: bigint; _ipfsCID: string; _timestamp: bigint };
    return { root: a._root, cid: a._ipfsCID, timestamp: a._timestamp, blockNumber: l.blockNumber };
  });
  let exclusions: PoolEvents["exclusions"];
  const rule = rootUpdates.length ? parseAspDescriptor(rootUpdates[rootUpdates.length - 1].cid) : null;
  if (rule?.exclusionId && p.exclusions) {
    const labels = await p.exclusions(rule.exclusionId);
    if (labels) exclusions = { id: rule.exclusionId, labels };
  }
  return { deposits, withdrawals, ragequits, leaves, rootUpdates, toBlock, exclusions };
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
  const byPrecommitment = new Map(ev.deposits.map((d) => [d.precommitment, d]));
  const withdrawalByNullifier = new Map(ev.withdrawals.map((w) => [w.spentNullifier, w]));
  const ragequitByCommitment = new Map(ev.ragequits.map((r) => [r.commitment, r]));
  const notes: PoolNote[] = [];
  let misses = 0;
  let nextDepositIndex = 0n;
  for (let i = 0n; misses < maxGap; i++) {
    const s = depositSecrets(keys, scope, i);
    const dep = byPrecommitment.get(precommitmentHash(s));
    if (!dep) {
      misses++;
      continue;
    }
    misses = 0;
    nextDepositIndex = i + 1n;
    let secrets = s;
    let value = dep.value;
    let commitment = dep.commitment;
    let count = 0n;
    const history: PoolWithdrawal[] = [];
    let status: NoteStatus = "spendable";
    for (;;) {
      if (ragequitByCommitment.has(commitment)) {
        status = "ragequit";
        break;
      }
      const w = withdrawalByNullifier.get(nullifierHash(secrets));
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
    notes.push({ depositIndex: i, label: dep.label, value, secrets, commitment, withdrawalCount: count, status, deposit: dep, history });
  }
  return { notes, nextDepositIndex };
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
