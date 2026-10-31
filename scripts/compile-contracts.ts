/**
 * Compiles the contracts in contracts/src with the pinned solc 0.8.23 (solc-js, bundled in npm)
 * and writes deterministic artifacts to contracts/artifacts.
 *
 * The artifacts are committed so the app and the deploy script share the exact same bytecode,
 * and the app can verify a deployed announcer by its runtime code hash.
 *
 * Usage: npm run contracts:compile
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { keccak256 } from "viem";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const solc = require("solc");

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "contracts", "src");
const OUT = join(ROOT, "contracts", "artifacts");

const CONTRACTS = [
  { file: "ERC5564Announcer.sol", name: "ERC5564Announcer" },
  { file: "QuietPayTestUSDG.sol", name: "QuietPayTestUSDG" },
] as const;

// "paris" avoids PUSH0 so the bytecode runs on any EVM-equivalent chain regardless of hardfork.
const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "paris",
  metadata: { bytecodeHash: "ipfs" },
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
};

mkdirSync(OUT, { recursive: true });

for (const c of CONTRACTS) {
  const sources = { [c.file]: { content: readFileSync(join(SRC, c.file), "utf8") } };
  const input = { language: "Solidity", sources, settings: SETTINGS };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) {
    console.error(errors);
    process.exit(1);
  }
  const compiled = output.contracts[c.file][c.name];
  const bytecode = `0x${compiled.evm.bytecode.object}` as const;
  const deployedBytecode = `0x${compiled.evm.deployedBytecode.object}` as const;
  const artifact = {
    contractName: c.name,
    sourceFile: `contracts/src/${c.file}`,
    compiler: solc.version(),
    settings: { optimizer: SETTINGS.optimizer, evmVersion: SETTINGS.evmVersion },
    abi: compiled.abi,
    bytecode,
    deployedBytecode,
    runtimeCodeHash: keccak256(deployedBytecode),
    // Standard JSON input for Blockscout "Solidity (Standard JSON input)" verification.
    standardJsonInput: input,
  };
  writeFileSync(join(OUT, `${c.name}.json`), JSON.stringify(artifact, null, 2) + "\n");
  console.log(`${c.name}: runtimeCodeHash ${artifact.runtimeCodeHash}`);
}
