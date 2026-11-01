/**
 * Groth16 proving with the Privacy Pools circuits and the keys from 0xbow's completed trusted
 * setup ceremony. QuietPay does not run its own setup: the files in public/pool-artifacts are
 * byte-identical to upstream and every one is checked against the SHA-256 digests below (the
 * same digests the official SDK pins) before use. A mismatched file is refused.
 *
 * Proofs are generated on the user's device. Secrets never leave it.
 */
import type { Address, Hex } from "viem";
import { encodeAbiParameters, keccak256 } from "viem";
import { SNARK_SCALAR_FIELD, type MerkleProof, type NoteSecrets } from "./crypto";

export const ARTIFACT_HASHES = {
  "withdraw.wasm": "36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10",
  "withdraw.zkey": "2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677",
  "withdraw.vkey": "666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e",
  "commitment.wasm": "254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8",
  "commitment.zkey": "494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3",
  "commitment.vkey": "7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8",
} as const;
export type ArtifactName = keyof typeof ARTIFACT_HASHES;

export type ArtifactLoader = (name: ArtifactName) => Promise<Uint8Array>;

/** Loads artifacts over HTTP from the site's own origin. */
export const fetchArtifact = (base = "/pool-artifacts/artifacts/"): ArtifactLoader => async (name) => {
  const res = await fetch(base + name, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Could not download ${name} (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
};

export class ArtifactIntegrityError extends Error {
  constructor(name: string) {
    super(`${name} does not match the ceremony file. Refusing to use it.`);
    this.name = "ArtifactIntegrityError";
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cache = new Map<ArtifactName, Promise<Uint8Array>>();
export async function loadVerified(load: ArtifactLoader, name: ArtifactName): Promise<Uint8Array> {
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      const data = await load(name);
      if ((await sha256Hex(data)) !== ARTIFACT_HASHES[name]) throw new ArtifactIntegrityError(name);
      return data;
    })();
    cache.set(name, p);
    p.catch(() => cache.delete(name));
  }
  return p;
}

export interface SolidityProof {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
}

interface SnarkProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

/** snarkjs proof to the verifier's calldata layout (G2 coordinates are swapped). */
export function toSolidityProof(p: SnarkProof): SolidityProof {
  return {
    pA: [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])],
    pB: [
      [BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])],
      [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])],
    ],
    pC: [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])],
  };
}

async function snark() {
  return (await import("snarkjs")).groth16;
}

async function fullProve(load: ArtifactLoader, circuit: "withdraw" | "commitment", input: Record<string, unknown>) {
  const [wasm, zkey] = await Promise.all([loadVerified(load, `${circuit}.wasm`), loadVerified(load, `${circuit}.zkey`)]);
  const g = await snark();
  const { proof, publicSignals } = await g.fullProve(input as never, wasm, zkey);
  const vkey = JSON.parse(new TextDecoder().decode(await loadVerified(load, `${circuit}.vkey`)));
  // Check locally before anything is sent: a bad proof should never reach the relayer.
  if (!(await g.verify(vkey, publicSignals, proof))) throw new Error("Generated proof did not verify.");
  return { proof: toSolidityProof(proof as unknown as SnarkProof), publicSignals: publicSignals.map((s) => BigInt(s)) };
}

export interface RelayData {
  recipient: Address;
  feeRecipient: Address;
  relayFeeBPS: bigint;
}

export interface Withdrawal {
  processooor: Address;
  data: Hex;
}

export function encodeRelayData(d: RelayData): Hex {
  return encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "recipient", type: "address" }, { name: "feeRecipient", type: "address" }, { name: "relayFeeBPS", type: "uint256" }] }],
    [d],
  );
}

/** keccak256(abi.encode(withdrawal, scope)) mod field: binds the proof to recipient, fee and pool. */
export function withdrawalContext(w: Withdrawal, scope: bigint): bigint {
  const enc = encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "processooor", type: "address" }, { name: "data", type: "bytes" }] }, { type: "uint256" }],
    [w, scope],
  );
  return BigInt(keccak256(enc)) % SNARK_SCALAR_FIELD;
}

export interface WithdrawProofInput {
  value: bigint;
  label: bigint;
  existing: NoteSecrets;
  next: NoteSecrets;
  withdrawnValue: bigint;
  context: bigint;
  state: MerkleProof;
  asp: MerkleProof;
}

export interface WithdrawProof extends SolidityProof {
  /** [newCommitment, existingNullifierHash, withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context] */
  pubSignals: bigint[];
}

export async function proveWithdrawal(load: ArtifactLoader, i: WithdrawProofInput): Promise<WithdrawProof> {
  if (i.withdrawnValue <= 0n || i.withdrawnValue > i.value) throw new Error("Withdrawal amount is out of range.");
  const { proof, publicSignals } = await fullProve(load, "withdraw", {
    withdrawnValue: i.withdrawnValue,
    stateRoot: i.state.root,
    stateTreeDepth: BigInt(i.state.depth),
    ASPRoot: i.asp.root,
    ASPTreeDepth: BigInt(i.asp.depth),
    context: i.context,
    label: i.label,
    existingValue: i.value,
    existingNullifier: i.existing.nullifier,
    existingSecret: i.existing.secret,
    newNullifier: i.next.nullifier,
    newSecret: i.next.secret,
    stateSiblings: i.state.siblings,
    stateIndex: BigInt(i.state.index),
    ASPSiblings: i.asp.siblings,
    ASPIndex: BigInt(i.asp.index),
  });
  if (publicSignals.length !== 8) throw new Error("Unexpected withdrawal proof shape.");
  return { ...proof, pubSignals: publicSignals };
}

export interface RagequitProof extends SolidityProof {
  /** [commitment, nullifierHash, value, label] */
  pubSignals: bigint[];
}

/** Proof of knowing a note's secrets, used by the original depositor to exit without approval. */
export async function proveRagequit(load: ArtifactLoader, i: { value: bigint; label: bigint; secrets: NoteSecrets }): Promise<RagequitProof> {
  const { proof, publicSignals } = await fullProve(load, "commitment", {
    value: i.value,
    label: i.label,
    nullifier: i.secrets.nullifier,
    secret: i.secrets.secret,
  });
  if (publicSignals.length !== 4) throw new Error("Unexpected commitment proof shape.");
  return { ...proof, pubSignals: publicSignals };
}
