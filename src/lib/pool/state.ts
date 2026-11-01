/**
 * Reads the shielded pool's public state from chain events and rebuilds the user's notes.
 *
 * Everything here is public data: the RPC only sees which contract and block ranges are read,
 * never which notes belong to whom. Matching happens locally with keys derived in the browser.
 */
import type { Address, PublicClient } from "viem";
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
  p: { entrypoint: Address; pool: Address; fromBlock: bigint; chunkSize: bigint; toBlock?: bigint },
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
  return { deposits, withdrawals, ragequits, leaves, rootUpdates, toBlock };
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
 * Approval (ASP) roots. QuietPay's testnet approver publishes a rule instead of a file: the
 * approved set is every deposit label up to a block, in deposit order. The rule fits in the
 * Entrypoint's 32 to 64 character "IPFS CID" field, so anyone can rebuild the set from the chain
 * and check that its root matches the onchain root.
 */
export const ASP_DESCRIPTOR_PREFIX = "quietpay-asp-v1:upto=";

export function encodeAspDescriptor(uptoBlock: bigint): string {
  const s = `${ASP_DESCRIPTOR_PREFIX}${uptoBlock.toString().padStart(18, "0")}`;
  if (s.length < 32 || s.length > 64) throw new Error("ASP descriptor length out of range.");
  return s;
}

export function parseAspDescriptor(cid: string): { uptoBlock: bigint } | null {
  if (!cid.startsWith(ASP_DESCRIPTOR_PREFIX)) return null;
  const n = cid.slice(ASP_DESCRIPTOR_PREFIX.length);
  return /^\d{1,30}$/.test(n) ? { uptoBlock: BigInt(n) } : null;
}

export function aspLabels(deposits: PoolDeposit[], uptoBlock: bigint): bigint[] {
  return deposits.filter((d) => d.blockNumber <= uptoBlock).map((d) => d.label);
}

export interface ApprovalSet {
  root: bigint;
  labels: bigint[];
  uptoBlock: bigint;
}

/** The current approval set, rebuilt from the latest root update and checked against `onchainRoot`. */
export function currentApprovalSet(ev: PoolEvents, onchainRoot: bigint): ApprovalSet | null {
  const last = ev.rootUpdates.at(-1);
  if (!last || last.root !== onchainRoot) return null;
  const d = parseAspDescriptor(last.cid);
  if (!d) return null;
  const labels = aspLabels(ev.deposits, d.uptoBlock);
  return treeRoot(labels) === onchainRoot ? { root: onchainRoot, labels, uptoBlock: d.uptoBlock } : null;
}
