/**
 * Deploys the shielded pool (Privacy Pools contracts, unchanged) for one ERC-20 token.
 * Shared by scripts/deploy-pool.ts and the local end-to-end tests.
 *
 * Order, as upstream's Deploy script: verifiers -> Entrypoint implementation + ERC1967 proxy
 * (initialize(owner, postman)) -> Poseidon libraries -> PrivacyPoolComplex -> registerPool.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

const ART = join(import.meta.dirname, "..", "contracts", "artifacts", "pool");
type Artifact = {
  abi: unknown[];
  bytecode: Hex;
  linkReferences: Record<string, Record<string, { start: number; length: number }[]>>;
};
export const poolArtifact = (name: string): Artifact => JSON.parse(readFileSync(join(ART, `${name}.json`), "utf8"));

export function linkBytecode(a: Artifact, libs: Record<string, Address>): Hex {
  const hex = a.bytecode.slice(2).split("");
  for (const refs of Object.values(a.linkReferences)) {
    for (const [lib, ranges] of Object.entries(refs)) {
      const addr = libs[lib];
      if (!addr) throw new Error(`Missing library address for ${lib}`);
      const body = addr.slice(2).toLowerCase();
      for (const { start, length } of ranges) {
        if (length !== 20) throw new Error("Unexpected link length");
        for (let i = 0; i < 40; i++) hex[start * 2 + i] = body[i];
      }
    }
  }
  const out = hex.join("");
  if (out.includes("_")) throw new Error("Unlinked library placeholder left in bytecode");
  return `0x${out}`;
}

export interface PoolDeployParams {
  token: Address;
  owner: Address;
  postman: Address;
  /** Smallest deposit, in token base units. */
  minimumDeposit: bigint;
  vettingFeeBPS: bigint;
  maxRelayFeeBPS: bigint;
  log?: (msg: string) => void;
}

export interface PoolDeployment {
  entrypoint: Address;
  entrypointImplementation: Address;
  pool: Address;
  withdrawalVerifier: Address;
  ragequitVerifier: Address;
  poseidonT3: Address;
  poseidonT4: Address;
  scope: bigint;
  fromBlock: bigint;
}

export async function deployPool(wallet: WalletClient, client: PublicClient, p: PoolDeployParams): Promise<PoolDeployment> {
  const log = p.log ?? (() => {});
  const account = wallet.account!;
  const chain = wallet.chain!;
  const startBlock = await client.getBlockNumber({ cacheTime: 0 });

  async function deploy(name: string, bytecode: Hex, args: unknown[] = []): Promise<Address> {
    const a = poolArtifact(name);
    const hash = await wallet.deployContract({ abi: a.abi as never, bytecode, args: args as never, account, chain });
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deployment failed (${hash})`);
    log(`${name.padEnd(22)} ${r.contractAddress}`);
    return r.contractAddress;
  }
  async function send(to: Address, data: Hex, label: string) {
    const hash = await wallet.sendTransaction({ to, data, account, chain });
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} failed (${hash})`);
    log(`${label.padEnd(22)} ${hash}`);
  }

  const withdrawalVerifier = await deploy("WithdrawalVerifier", poolArtifact("WithdrawalVerifier").bytecode);
  const ragequitVerifier = await deploy("CommitmentVerifier", poolArtifact("CommitmentVerifier").bytecode);
  const ep = poolArtifact("Entrypoint");
  const entrypointImplementation = await deploy("Entrypoint", ep.bytecode);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const encode = encodeFunctionData as (x: { abi: unknown; functionName: string; args: unknown[] }) => Hex;
  const init = encode({ abi: ep.abi, functionName: "initialize", args: [p.owner, p.postman] });
  const entrypoint = await deploy("ERC1967Proxy", poolArtifact("ERC1967Proxy").bytecode, [entrypointImplementation, init]);
  const poseidonT3 = await deploy("PoseidonT3", poolArtifact("PoseidonT3").bytecode);
  const poseidonT4 = await deploy("PoseidonT4", poolArtifact("PoseidonT4").bytecode);
  const pc = poolArtifact("PrivacyPoolComplex");
  const pool = await deploy("PrivacyPoolComplex", linkBytecode(pc, { PoseidonT3: poseidonT3, PoseidonT4: poseidonT4 }), [
    entrypoint,
    withdrawalVerifier,
    ragequitVerifier,
    p.token,
  ]);
  await send(
    entrypoint,
    encode({ abi: ep.abi, functionName: "registerPool", args: [p.token, pool, p.minimumDeposit, p.vettingFeeBPS, p.maxRelayFeeBPS] }),
    "registerPool",
  );
  const scope = (await client.readContract({ address: pool, abi: pc.abi as never, functionName: "SCOPE" })) as bigint;
  return { entrypoint, entrypointImplementation, pool, withdrawalVerifier, ragequitVerifier, poseidonT3, poseidonT4, scope, fromBlock: startBlock };
}
