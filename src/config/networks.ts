/**
 * Central network, token and contract configuration.
 *
 * Rules (see SECURITY.md):
 *  - Testnet is the default. Mainnet is only enabled when NEXT_PUBLIC_ENABLE_MAINNET === "true".
 *  - The token for each network is an allowlisted constant/env value. Payment links can only
 *    reference that exact token; arbitrary contract addresses are rejected.
 *  - No testnet USDG address is invented. Testnet uses an explicitly labelled mock token
 *    (QuietPayTestUSDG) whose address must be supplied after deployment.
 *  - No Ethereum ERC-5564 deployment address is assumed. The announcer must be configured and
 *    its bytecode is verified at runtime against KNOWN_ANNOUNCER_CODE_HASHES.
 *
 * NEXT_PUBLIC_* variables are referenced literally so Next.js can inline them at build time.
 */
import { defineChain, getAddress, isAddress, type Address, type Chain } from "viem";

export type NetworkKey = "testnet" | "mainnet";

export interface NetworkConfig {
  key: NetworkKey;
  label: string;
  chain: Chain;
  rpcUrl: string;
  explorerUrl: string;
  /** Allowlisted payment token (USDG on mainnet, labelled mock on testnet). Null if unconfigured. */
  token: Address | null;
  /** True when the token is the QuietPay mock and not real USDG. */
  tokenIsMock: boolean;
  /** Expected token symbol, checked onchain. */
  expectedSymbol: string;
  /** ERC-5564 announcer address. Null if not deployed/configured. */
  announcer: Address | null;
  /** QuietPayRouter: one-transaction payment + gas stipend + announcement. Null falls back to two transactions. */
  router: Address | null;
  /** Confirmations to wait before treating a transaction as final in the UI. */
  confirmations: number;
  /** Max block span per eth_getLogs request (adaptively reduced on RPC errors). */
  logChunkSize: bigint;
  enabled: boolean;
}

function optionalAddress(value: string | undefined): Address | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (!isAddress(v, { strict: false })) {
    throw new Error(`Invalid address in configuration: ${v}`);
  }
  return getAddress(v);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const ROBINHOOD_TESTNET_ID = 46630;
export const ROBINHOOD_MAINNET_ID = 4663;

/** Official mainnet USDG address (Paxos Global Dollar) on Robinhood Chain. Verified onchain at runtime. */
export const MAINNET_USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

const TESTNET_RPC = process.env.NEXT_PUBLIC_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const MAINNET_RPC = process.env.NEXT_PUBLIC_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

export const robinhoodTestnet = defineChain({
  id: ROBINHOOD_TESTNET_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [TESTNET_RPC] } },
  blockExplorers: {
    default: { name: "Robinhood Testnet Explorer", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  testnet: true,
});

export const robinhoodMainnet = defineChain({
  id: ROBINHOOD_MAINNET_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [MAINNET_RPC] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export const MAINNET_ENABLED = process.env.NEXT_PUBLIC_ENABLE_MAINNET === "true";

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  testnet: {
    key: "testnet",
    label: "Robinhood Chain Testnet",
    chain: robinhoodTestnet,
    rpcUrl: TESTNET_RPC,
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    token: optionalAddress(process.env.NEXT_PUBLIC_TESTNET_TOKEN_ADDRESS),
    tokenIsMock: true,
    expectedSymbol: "tUSDG",
    announcer: optionalAddress(process.env.NEXT_PUBLIC_TESTNET_ANNOUNCER_ADDRESS),
    router: optionalAddress(process.env.NEXT_PUBLIC_TESTNET_ROUTER_ADDRESS),
    confirmations: positiveInt(process.env.NEXT_PUBLIC_TESTNET_CONFIRMATIONS, 1),
    logChunkSize: BigInt(positiveInt(process.env.NEXT_PUBLIC_LOG_CHUNK_SIZE, 50_000)),
    enabled: true,
  },
  mainnet: {
    key: "mainnet",
    label: "Robinhood Chain",
    chain: robinhoodMainnet,
    rpcUrl: MAINNET_RPC,
    explorerUrl: "https://robinhoodchain.blockscout.com",
    token: MAINNET_USDG,
    tokenIsMock: false,
    expectedSymbol: "USDG",
    announcer: optionalAddress(process.env.NEXT_PUBLIC_MAINNET_ANNOUNCER_ADDRESS),
    router: optionalAddress(process.env.NEXT_PUBLIC_MAINNET_ROUTER_ADDRESS),
    confirmations: positiveInt(process.env.NEXT_PUBLIC_MAINNET_CONFIRMATIONS, 3),
    logChunkSize: BigInt(positiveInt(process.env.NEXT_PUBLIC_LOG_CHUNK_SIZE, 50_000)),
    enabled: MAINNET_ENABLED,
  },
};

export const DEFAULT_NETWORK: NetworkKey =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK === "mainnet" && MAINNET_ENABLED ? "mainnet" : "testnet";

export function enabledNetworks(networks: Record<NetworkKey, NetworkConfig> = NETWORKS): NetworkConfig[] {
  return Object.values(networks).filter((n) => n.enabled);
}

/** Returns the enabled network for a chain ID, or null if unknown or disabled. */
export function networkForChainId(
  chainId: number,
  networks: Record<NetworkKey, NetworkConfig> = NETWORKS,
): NetworkConfig | null {
  const n = Object.values(networks).find((x) => x.chain.id === chainId);
  return n && n.enabled ? n : null;
}

/** Payment limits in human units, converted with the onchain decimals at runtime. */
export const PAYMENT_LIMITS = {
  min: process.env.NEXT_PUBLIC_MIN_PAYMENT || "0.01",
  max: process.env.NEXT_PUBLIC_MAX_PAYMENT || "10000",
};

export const EXPIRY_OPTIONS = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const;

/** Expiry choices for reusable "any amount" links. 0 means the link never expires. */
export const OPEN_EXPIRY_OPTIONS = [
  { label: "Never", seconds: 0 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
] as const;

export const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
export const MAX_OPEN_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
/** Clock skew tolerated when validating link expiry. */
export const CLOCK_SKEW_SECONDS = 5 * 60;

export function explorerTxUrl(network: NetworkConfig, hash: string) {
  return `${network.explorerUrl}/tx/${hash}`;
}
export function explorerAddressUrl(network: NetworkConfig, address: string) {
  return `${network.explorerUrl}/address/${address}`;
}
