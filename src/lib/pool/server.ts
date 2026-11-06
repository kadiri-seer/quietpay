/**
 * Server-side relayer setup (route handlers only). Reads the relayer's hot key from the
 * server environment. Testnet only: the relayer never runs for a network without a pool.
 *
 *   RELAYER_PRIVATE_KEY          relayer + approver key (testnet ETH only, never the pool owner)
 *   RELAYER_FEE_BPS              fee taken from each withdrawal, default 50 (0.5%)
 *   RELAYER_GAS_DROP_ETH         most ETH topped up at an empty receiving address, default 0.0002
 *   RELAYER_ETH_PRICE            payment tokens per 1 ETH, default 3000; the fee must cover gas
 *                                and the top-up at this price, so tiny withdrawals are refused
 *   POOL_APPROVAL_DELAY_SECONDS  how old a deposit must be before it is approved, default 0 (immediately)
 *   POOL_SCREENING               "on" or "off": check deposits against the OFAC sanctions list before
 *                                approving them. Default on for mainnet, off for testnet.
 *   POOL_ROOT_INTERVAL_SECONDS   least time between approval roots, 15 to 3600, default 60
 *   RELAYER_MIN_BALANCE_ETH      no gas top-ups below this relayer balance, default 0.02
 *   RELAYER_DROP_COOLDOWN_SECONDS one top-up per receiving address per this long, default 86400
 *   RELAYER_DROPS_PER_CALLER_PER_DAY  top-ups per caller (salted IP hash) per day, default 3
 *   RELAYER_DROPS_PER_DAY        top-ups in total per day, default 50
 */
import "server-only";
import { createWalletClient, http, parseEther, parseUnits, type Hex, type WalletClient } from "viem";
import { erc20Abi } from "@/config/contracts";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS, type NetworkConfig } from "@/config/networks";
import { createNetworkClient } from "@/lib/chain";
import type { RelayerPolicy } from "./relayer";

export interface RelayerContext {
  network: NetworkConfig;
  client: ReturnType<typeof createNetworkClient>;
  wallet: WalletClient;
  /** Fee policy without the price (see `withPrice`). */
  policy: Omit<RelayerPolicy, "tokenUnitsPerEth">;
  approvalDelaySeconds: number;
  /** Payment tokens per 1 ETH, as a decimal string. */
  ethPrice: string;
  /** Whether the approver screens deposits (src/lib/screening). */
  screening: boolean;
}

export function screeningOn(setting: string | undefined, network: "testnet" | "mainnet"): boolean {
  const v = (setting ?? "").trim().toLowerCase();
  if (v === "on") return true;
  if (v === "off") return false;
  return network === "mainnet";
}

let decimalsCache: { token: string; decimals: number } | null = null;

/** The full policy, with the ETH price converted to token base units (decimals read onchain once). */
export async function withPrice(ctx: RelayerContext): Promise<RelayerPolicy> {
  const token = ctx.network.token!;
  if (decimalsCache?.token !== token) {
    const decimals = await ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
    decimalsCache = { token, decimals: Number(decimals) };
  }
  let tokenUnitsPerEth: bigint;
  try {
    tokenUnitsPerEth = parseUnits(ctx.ethPrice, decimalsCache.decimals);
  } catch {
    tokenUnitsPerEth = parseUnits("3000", decimalsCache.decimals);
  }
  if (tokenUnitsPerEth <= 0n) tokenUnitsPerEth = parseUnits("3000", decimalsCache.decimals);
  return { ...ctx.policy, tokenUnitsPerEth };
}

export function relayerContext(): RelayerContext | null {
  const network = NETWORKS.testnet;
  const raw = (process.env.RELAYER_PRIVATE_KEY ?? "").replace(/[\s"']/g, "");
  if (!network.pool || !network.token || !raw) return null;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  const account = privateKeyToAccount(key);
  const feeBPS = BigInt(Math.max(0, Math.min(100, Number(process.env.RELAYER_FEE_BPS ?? 50) | 0)));
  let gasDrop = 0n;
  try {
    gasDrop = parseEther(process.env.RELAYER_GAS_DROP_ETH ?? "0.0002");
  } catch {}
  if (gasDrop > parseEther("0.001")) gasDrop = parseEther("0.001");
  return {
    network,
    client: createNetworkClient(network),
    wallet: createWalletClient({ account, chain: network.chain, transport: http(network.rpcUrl, { timeout: 20_000 }) }),
    policy: { feeRecipient: account.address, feeBPS, gasDrop },
    approvalDelaySeconds: Math.max(0, Number(process.env.POOL_APPROVAL_DELAY_SECONDS ?? 0) | 0),
    ethPrice: (process.env.RELAYER_ETH_PRICE ?? "3000").trim() || "3000",
    screening: screeningOn(process.env.POOL_SCREENING, network.key),
  };
}
