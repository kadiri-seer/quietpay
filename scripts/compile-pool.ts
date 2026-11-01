/**
 * Compiles the vendored Privacy Pools contracts (0xbow, Apache-2.0) with solc 0.8.28, the
 * compiler version they were audited with, and writes artifacts to contracts/artifacts/pool.
 *
 * The contract sources are copied unchanged from upstream (see contracts/vendor/NOTICE.md).
 * Their library imports (OpenZeppelin, poseidon-solidity, lean-imt.sol) are vendored too, in
 * contracts/vendor/deps, so builds never depend on what npm resolves today.
 *
 * Usage:
 *   npm run contracts:compile:pool
 *   DEPS_FROM=/path/to/node_modules npm run contracts:compile:pool   # refresh vendored deps
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { keccak256 } from "viem";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const solc = require("solc-0828");

const ROOT = join(import.meta.dirname, "..");
const VENDOR = join(ROOT, "contracts", "vendor");
const PP = join(VENDOR, "privacy-pools", "src");
const DEPS = join(VENDOR, "deps");
const OUT = join(ROOT, "contracts", "artifacts", "pool");
const DEPS_FROM = process.env.DEPS_FROM;

/** Upstream remappings (packages/contracts/remappings.txt), pointed at vendored copies. */
const REMAPS: [prefix: string, npmPath: string][] = [
  ["@oz/", "@openzeppelin/contracts/"],
  ["@oz-upgradeable/", "@openzeppelin/contracts-upgradeable/"],
  ["poseidon/", "poseidon-solidity/"],
  ["lean-imt/", "@zk-kit/lean-imt.sol/"],
];

const CONTRACTS = [
  { path: "contracts/Entrypoint.sol", name: "Entrypoint" },
  { path: "contracts/implementations/PrivacyPoolComplex.sol", name: "PrivacyPoolComplex" },
  { path: "contracts/verifiers/WithdrawalVerifier.sol", name: "WithdrawalVerifier" },
  { path: "contracts/verifiers/CommitmentVerifier.sol", name: "CommitmentVerifier" },
  { path: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol", name: "ERC1967Proxy" },
  // Public libraries the pool links against (state tree hashing and commitments).
  { path: "poseidon-solidity/PoseidonT3.sol", name: "PoseidonT3" },
  { path: "poseidon-solidity/PoseidonT4.sol", name: "PoseidonT4" },
];

// Upstream foundry.toml: optimizer 10_000 runs, no metadata hash. "paris" avoids PUSH0/MCOPY so
// the bytecode runs on any EVM-equivalent chain regardless of hardfork.
const SETTINGS = {
  optimizer: { enabled: true, runs: 10_000 },
  evmVersion: "paris",
  metadata: { bytecodeHash: "none", appendCBOR: false },
  // Normalise upstream aliases to npm paths so each file is one source unit, as in Foundry.
  remappings: REMAPS.map(([prefix, npm]) => `${prefix}=${npm}`),
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences", "evm.bytecode.linkReferences", "evm.deployedBytecode.linkReferences"] } },
};

function resolve(importPath: string): string | null {
  if (importPath.startsWith("contracts/") || importPath.startsWith("interfaces/")) return join(PP, importPath);
  for (const [prefix, npm] of REMAPS) {
    if (!importPath.startsWith(prefix) && !importPath.startsWith(npm)) continue;
    const rel = importPath.startsWith(npm) ? importPath : npm + importPath.slice(prefix.length);
    const vendored = join(DEPS, rel);
    if (DEPS_FROM) {
      const src = join(DEPS_FROM, rel);
      if (!existsSync(src)) return null;
      mkdirSync(dirname(vendored), { recursive: true });
      copyFileSync(src, vendored);
    }
    return vendored;
  }
  return null;
}

const sources: Record<string, { content: string }> = {};
const used = new Set<string>();
function findImports(p: string) {
  const file = resolve(p);
  if (!file || !existsSync(file)) return { error: `File not found: ${p}` };
  used.add(p);
  return { contents: readFileSync(file, "utf8") };
}
for (const c of CONTRACTS) {
  const r = findImports(c.path);
  if ("error" in r) throw new Error(r.error);
  sources[c.path] = { content: r.contents };
}

const input = { language: "Solidity", sources, settings: SETTINGS };
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}

// Full standard JSON input (every source inlined) for explorer verification.
const fullSources: Record<string, { content: string }> = {};
for (const p of [...used].sort()) fullSources[p] = { content: readFileSync(resolve(p)!, "utf8") };
const standardJsonInput = { language: "Solidity", sources: fullSources, settings: SETTINGS };

type ImmRefs = Record<string, { start: number; length: number }[]>;
type LinkRefs = Record<string, Record<string, { start: number; length: number }[]>>;
function flattenLinks(refs: LinkRefs): ImmRefs {
  const out: ImmRefs = {};
  for (const [file, libs] of Object.entries(refs)) for (const [lib, r] of Object.entries(libs)) out[`${file}:${lib}`] = r;
  return out;
}
/** Deployed libraries start with PUSH20 <own address> (call guard); solc leaves it zero. */
function libraryGuard(code: string): ImmRefs {
  return code.startsWith("0x73" + "0".repeat(40) + "30") ? { libraryAddress: [{ start: 1, length: 20 }] } : {};
}
function maskImmutables(code: `0x${string}`, refs: ImmRefs): `0x${string}` {
  // Library placeholders ("__$...$__") are not hex; masking them turns them into zeros too.
  const hex = code.slice(2).split("");
  for (const ranges of Object.values(refs))
    for (const { start, length } of ranges) for (let i = start * 2; i < (start + length) * 2; i++) hex[i] = "0";
  return `0x${hex.join("")}`;
}

mkdirSync(OUT, { recursive: true });
const generated: Record<string, unknown> = {};
for (const c of CONTRACTS) {
  const compiled = output.contracts[c.path][c.name];
  const bytecode = `0x${compiled.evm.bytecode.object}` as const;
  const deployedBytecode = `0x${compiled.evm.deployedBytecode.object}` as const;
  const size = (deployedBytecode.length - 2) / 2;
  if (size > 24_576) throw new Error(`${c.name} runtime is ${size} bytes, over the 24,576 byte limit`);
  const artifact = {
    contractName: c.name,
    sourceFile: c.path,
    compiler: solc.version(),
    settings: { optimizer: SETTINGS.optimizer, evmVersion: SETTINGS.evmVersion },
    abi: compiled.abi,
    bytecode,
    deployedBytecode,
    // Immutables (proxy self address, pool entrypoint, asset, scope...) differ per deployment, so
    // the app hashes runtime code with these byte ranges zeroed. See src/lib/pool/verify.ts.
    immutableReferences: compiled.evm.deployedBytecode.immutableReferences ?? {},
    // Library placeholders; the deploy script links them and the app checks each linked address.
    linkReferences: compiled.evm.bytecode.linkReferences ?? {},
    deployedLinkReferences: compiled.evm.deployedBytecode.linkReferences ?? {},
    runtimeCodeHash: deployedBytecode.includes("__$") ? null : keccak256(deployedBytecode),
    maskedRuntimeCodeHash: keccak256(
      maskImmutables(deployedBytecode, {
        ...(compiled.evm.deployedBytecode.immutableReferences ?? {}),
        ...flattenLinks(compiled.evm.deployedBytecode.linkReferences ?? {}),
        ...libraryGuard(deployedBytecode),
      }),
    ),
    standardJsonInput,
  };
  writeFileSync(join(OUT, `${c.name}.json`), JSON.stringify(artifact, null, 2) + "\n");
  const masks = Object.values<{ start: number; length: number }[]>({
    ...(compiled.evm.deployedBytecode.immutableReferences ?? {}),
    ...flattenLinks(compiled.evm.deployedBytecode.linkReferences ?? {}),
    ...libraryGuard(deployedBytecode),
  })
    .flat()
    .map(({ start, length }) => [start, length] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const links = Object.fromEntries(
    Object.entries(flattenLinks(compiled.evm.deployedBytecode.linkReferences ?? {})).map(([k, v]) => [k.split(":")[1], v.map((r) => r.start)]),
  );
  generated[c.name] = { abi: compiled.abi, maskedRuntimeCodeHash: artifact.maskedRuntimeCodeHash, masks, links };
  console.log(`${c.name.padEnd(20)} ${String(size).padStart(6)} bytes  masked ${artifact.maskedRuntimeCodeHash}`);
}

// Small typed module for the app: ABIs, masked code hashes and mask ranges (no bytecode).
const ts = [
  "// Generated by scripts/compile-pool.ts. Do not edit.",
  "// Privacy Pools contracts by 0xbow (Apache-2.0), compiled unchanged. See contracts/vendor/NOTICE.md.",
  ...Object.entries(generated).map(([name, v]) => `export const ${name} = ${JSON.stringify(v)} as const;`),
  "",
].join("\n");
writeFileSync(join(ROOT, "src", "config", "pool-contracts.generated.ts"), ts);
