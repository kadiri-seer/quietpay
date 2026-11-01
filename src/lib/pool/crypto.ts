/**
 * Shielded pool cryptography, matching the audited Privacy Pools circuits (0xbow):
 *
 *   precommitment  = Poseidon(nullifier, secret)
 *   commitment     = Poseidon(value, label, precommitment)
 *   nullifierHash  = Poseidon(nullifier)           (published when a note is spent)
 *
 * Note secrets are derived, never stored: from two master keys and a counter, exactly as the
 * Privacy Pools SDK does, so every note can be rebuilt from the chain after a reinstall.
 *
 * QuietPay derives the master keys from the same deterministic wallet signature that unlocks
 * the key vault (HKDF-SHA256 with a separate salt), so pool funds survive a lost browser even
 * without a backup file, as long as the wallet still produces the same signature.
 */
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { getAddress, hexToBytes, type Address, type Hex } from "viem";

/** circomlib-compatible Poseidon, same as the circuits and the pool contract's libraries. */
function poseidon(inputs: bigint[]): bigint {
  if (inputs.length === 1) return poseidon1(inputs);
  if (inputs.length === 2) return poseidon2(inputs);
  if (inputs.length === 3) return poseidon3(inputs);
  throw new Error("Unsupported Poseidon arity.");
}

export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const MAX_TREE_DEPTH = 32;

export interface PoolMasterKeys {
  masterNullifier: bigint;
  masterSecret: bigint;
}

export interface NoteSecrets {
  nullifier: bigint;
  secret: bigint;
}

const te = new TextEncoder();
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

/** Domain-separated from the vault key: different salt, info and output. */
export async function derivePoolMasterKeys(signature: Hex, address: Address): Promise<PoolMasterKeys> {
  const ikm = await crypto.subtle.importKey("raw", buf(hexToBytes(signature)), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buf(te.encode("quietpay/pool/v1")),
      info: buf(te.encode(`privacy-pools-master-keys|${getAddress(address).toLowerCase()}`)),
    },
    ikm,
    1024,
  );
  const out = new Uint8Array(bits);
  // 64 bytes per key reduced mod the field keeps the bias negligible.
  const k1 = bytesToBigInt(out.slice(0, 64)) % SNARK_SCALAR_FIELD;
  const k2 = bytesToBigInt(out.slice(64, 128)) % SNARK_SCALAR_FIELD;
  return masterKeysFromSeeds(k1, k2);
}

/** Same construction as the SDK's generateMasterKeys, from two field-element seeds. */
export function masterKeysFromSeeds(seed1: bigint, seed2: bigint): PoolMasterKeys {
  return { masterNullifier: poseidon([seed1]), masterSecret: poseidon([seed2]) };
}

/** Secrets for the index-th deposit into a pool (scope). */
export function depositSecrets(keys: PoolMasterKeys, scope: bigint, index: bigint): NoteSecrets {
  return { nullifier: poseidon([keys.masterNullifier, scope, index]), secret: poseidon([keys.masterSecret, scope, index]) };
}

/** Secrets for the change note created by the index-th withdrawal from a deposit (label). */
export function withdrawalSecrets(keys: PoolMasterKeys, label: bigint, index: bigint): NoteSecrets {
  return { nullifier: poseidon([keys.masterNullifier, label, index]), secret: poseidon([keys.masterSecret, label, index]) };
}

export const precommitmentHash = (s: NoteSecrets) => poseidon([s.nullifier, s.secret]);
export const commitmentHash = (value: bigint, label: bigint, s: NoteSecrets) => poseidon([value, label, precommitmentHash(s)]);
export const nullifierHash = (s: NoteSecrets) => poseidon([s.nullifier]);

export interface MerkleProof {
  root: bigint;
  depth: number;
  index: number;
  /** Padded with zeros to MAX_TREE_DEPTH, as the circuit expects. */
  siblings: bigint[];
}

/** Lean incremental Merkle tree with Poseidon, as used by the pool contract and circuits. */
export function buildTree(leaves: bigint[]) {
  const tree = new LeanIMT<bigint>((a, b) => poseidon([a, b]));
  if (leaves.length) tree.insertMany(leaves);
  return tree;
}

export function merkleProof(leaves: bigint[], leaf: bigint): MerkleProof {
  const tree = buildTree(leaves);
  const index = tree.indexOf(leaf);
  if (index < 0) throw new Error("Leaf not found in tree.");
  const p = tree.generateProof(index);
  const siblings = [...p.siblings, ...Array(MAX_TREE_DEPTH - p.siblings.length).fill(0n)];
  return { root: tree.root, depth: tree.depth, index: p.index, siblings };
}

export function treeRoot(leaves: bigint[]): bigint {
  return leaves.length ? buildTree(leaves).root : 0n;
}
