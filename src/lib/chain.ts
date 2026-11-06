/**
 * Onchain reads and verification. Every function takes a viem PublicClient so it works
 * identically against Robinhood Chain and a local anvil node in tests.
 */
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import {
  KNOWN_ANNOUNCER_CODE_HASHES,
  RETIRED_ROUTER_V1_CODE_HASHES,
  KNOWN_ROUTER_V3_CODE_HASHES,
  KNOWN_ROUTER_V2_CODE_HASHES,
  announcerAbi,
  erc20Abi,
  ERC5564_SCHEME_ID,
  routerV2Abi,
} from "@/config/contracts";
import type { NetworkConfig } from "@/config/networks";
import { TransferNotVerifiedError, TxReplacedError } from "./tx-errors";

export function createNetworkClient(network: NetworkConfig): PublicClient {
  return createPublicClient({
    chain: network.chain,
    transport: http(network.rpcUrl, { timeout: 20_000, retryCount: 2, batch: false }),
  }) as PublicClient;
}

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

export async function assertChainId(client: PublicClient, expected: number) {
  const id = await client.getChainId();
  if (id !== expected) throw new VerificationError(`RPC reports chain ${id}, expected ${expected}.`);
}

export interface TokenInfo {
  address: Address;
  decimals: number;
  symbol: string;
  name: string;
  codeHash: Hex;
  isMock: boolean;
}

/** Verifies that the allowlisted token has bytecode and reads decimals/symbol onchain. */
export async function verifyToken(client: PublicClient, network: NetworkConfig): Promise<TokenInfo> {
  if (!network.token) {
    throw new VerificationError(
      network.tokenIsMock
        ? "No testnet token is configured. Deploy the QuietPay mock token and set NEXT_PUBLIC_TESTNET_TOKEN_ADDRESS."
        : "No payment token is configured.",
    );
  }
  const code = await client.getCode({ address: network.token });
  if (!code || code === "0x") throw new VerificationError(`No contract is deployed at the configured token address on ${network.label}.`);
  const [decimals, symbol, name] = await Promise.all([
    client.readContract({ address: network.token, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: network.token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: network.token, abi: erc20Abi, functionName: "name" }),
  ]);
  if (decimals > 36) throw new VerificationError("Token reports unsupported decimals.");
  if (symbol !== network.expectedSymbol) {
    throw new VerificationError(`Token symbol is "${symbol}", expected "${network.expectedSymbol}". Refusing to continue.`);
  }
  return { address: network.token, decimals: Number(decimals), symbol, name, codeHash: keccak256(code), isMock: network.tokenIsMock };
}

export interface AnnouncerInfo {
  address: Address;
  codeHash: Hex;
}

/** Verifies the announcer exists AND its runtime bytecode matches a known ERC5564Announcer build. */
export async function verifyAnnouncer(
  client: PublicClient,
  network: NetworkConfig,
  knownHashes: readonly Hex[] = KNOWN_ANNOUNCER_CODE_HASHES,
): Promise<AnnouncerInfo> {
  if (!network.announcer) {
    throw new VerificationError(
      `No ERC-5564 announcer is configured for ${network.label}. Deploy contracts/src/ERC5564Announcer.sol and set the announcer address.`,
    );
  }
  const code = await client.getCode({ address: network.announcer });
  if (!code || code === "0x") throw new VerificationError(`No contract is deployed at the configured announcer address on ${network.label}.`);
  const codeHash = keccak256(code);
  if (!knownHashes.map((h) => h.toLowerCase()).includes(codeHash.toLowerCase())) {
    throw new VerificationError("The configured announcer's bytecode does not match a known ERC-5564 announcer build.");
  }
  return { address: network.announcer, codeHash };
}

export interface RouterInfo {
  address: Address;
  codeHash: Hex;
  /**
   * 2: v2 (token and announcer fixed at deployment, one-time links enforced onchain).
   * 3: v3 (v2 plus onchain destination checks).
   * v1 is retired and refused.
   */
  version: 2 | 3;
}

/**
 * Verifies the optional QuietPay router. Returns null when none is configured (the app then uses
 * the two-transaction flow); throws if one is configured but its bytecode is unknown, or if a v2
 * router is bound to a different token or announcer than this network's.
 */
export async function verifyRouter(
  client: PublicClient,
  network: NetworkConfig,
  knownV2Hashes: readonly Hex[] = KNOWN_ROUTER_V2_CODE_HASHES,
  knownV3Hashes: readonly Hex[] = KNOWN_ROUTER_V3_CODE_HASHES,
): Promise<RouterInfo | null> {
  if (!network.router) return null;
  const code = await client.getCode({ address: network.router });
  if (!code || code === "0x") throw new VerificationError(`No contract is deployed at the configured router address on ${network.label}.`);
  const codeHash = keccak256(code).toLowerCase() as Hex;
  const v3 = knownV3Hashes.map((h) => h.toLowerCase()).includes(codeHash);
  if (v3 || knownV2Hashes.map((h) => h.toLowerCase()).includes(codeHash)) {
    const [token, announcer] = await Promise.all([
      client.readContract({ address: network.router, abi: routerV2Abi, functionName: "token" }),
      client.readContract({ address: network.router, abi: routerV2Abi, functionName: "announcer" }),
    ]);
    if (!network.token || getAddress(token) !== getAddress(network.token)) {
      throw new VerificationError("The configured router is bound to a different token than this network's.");
    }
    if (!network.announcer || getAddress(announcer) !== getAddress(network.announcer)) {
      throw new VerificationError("The configured router is bound to a different announcer than this network's.");
    }
    return { address: network.router, codeHash, version: v3 ? 3 : 2 };
  }
  if (RETIRED_ROUTER_V1_CODE_HASHES.map((h) => h.toLowerCase()).includes(codeHash))
    throw new VerificationError("The configured router is QuietPay's retired v1 router. QuietPay no longer pays through it; configure the v3 (or v2) router.");
  throw new VerificationError("The configured router's bytecode does not match QuietPay's router build.");
}

/**
 * First block at which `address` has code (binary search over historical state). Needs an RPC
 * that serves old state; if it doesn't, this throws instead of quietly returning a late block
 * (which would make a history search find nothing). Networks can set the block in config.
 */
export async function findDeployBlock(client: PublicClient, address: Address): Promise<bigint> {
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const has = async (b: bigint) => {
    let code: Hex | undefined;
    try {
      code = await client.getCode({ address, blockNumber: b });
    } catch {
      throw new Error("This network's RPC can't read old blocks, so QuietPay can't find where to start searching. Try again later.");
    }
    return !!code && code !== "0x";
  };
  if (!(await has(latest))) throw new Error("No contract at that address.");
  let lo = 0n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await has(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** Finds the latest block with timestamp <= ts (binary search). */
export async function findBlockAtOrBefore(client: PublicClient, timestamp: bigint, fromBlock = 0n): Promise<bigint> {
  const latest = await client.getBlock({ blockTag: "latest" });
  if (latest.timestamp <= timestamp) return latest.number;
  let lo = fromBlock;
  let hi = latest.number;
  const first = await client.getBlock({ blockNumber: fromBlock });
  if (first.timestamp > timestamp) return fromBlock;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const b = await client.getBlock({ blockNumber: mid });
    if (b.timestamp <= timestamp) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface Announcement {
  stealthAddress: Address;
  caller: Address;
  ephemeralPubKey: Hex;
  metadata: Hex;
  blockNumber: bigint;
  transactionHash: Hash;
  logIndex: number;
}

/**
 * Fetches scheme-1 announcements in [fromBlock, toBlock] in chunks, halving the chunk on RPC
 * errors (range limits). Only public filter parameters go to the RPC; viewing keys never leave
 * the browser.
 */
export async function scanAnnouncements(
  client: PublicClient,
  opts: {
    announcer: Address;
    fromBlock: bigint;
    toBlock: bigint;
    chunkSize: bigint;
    onProgress?: (scannedTo: bigint, toBlock: bigint) => void;
    signal?: AbortSignal;
  },
): Promise<Announcement[]> {
  // Chunks are fetched several at a time; one the RPC refuses is split in half and retried.
  const size = opts.chunkSize > 0n ? opts.chunkSize : 10_000n;
  const ranges: [bigint, bigint][] = [];
  for (let s = opts.fromBlock; s <= opts.toBlock; s += size) ranges.push([s, s + size - 1n > opts.toBlock ? opts.toBlock : s + size - 1n]);
  const get = async (from: bigint, to: bigint): Promise<Announcement[]> => {
    if (opts.signal?.aborted) throw new DOMException("Scan cancelled", "AbortError");
    try {
      const logs = await client.getContractEvents({
        address: opts.announcer,
        abi: announcerAbi,
        eventName: "Announcement",
        args: { schemeId: ERC5564_SCHEME_ID },
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      return logs.map((l) => ({
        stealthAddress: getAddress(l.args.stealthAddress),
        caller: getAddress(l.args.caller),
        ephemeralPubKey: l.args.ephemeralPubKey,
        metadata: l.args.metadata,
        blockNumber: l.blockNumber,
        transactionHash: l.transactionHash,
        logIndex: l.logIndex,
      }));
    } catch (e) {
      if ((e as Error).name === "AbortError" || to - from < 100n) throw e;
      const mid = from + (to - from) / 2n;
      return [...(await get(from, mid)), ...(await get(mid + 1n, to))];
    }
  };
  const parts: Announcement[][] = new Array(ranges.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, ranges.length) }, async () => {
      while (next < ranges.length) {
        const i = next++;
        parts[i] = await get(ranges[i][0], ranges[i][1]);
        done++;
        // Progress as a share of the range (chunks finish out of order).
        opts.onProgress?.(opts.fromBlock + ((opts.toBlock - opts.fromBlock) * BigInt(done)) / BigInt(ranges.length), opts.toBlock);
      }
    }),
  );
  const out = parts.flat();
  out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  return out;
}

/** Confirms that `receipt` succeeded and contains a token Transfer of exactly `amount` to `to`. */
export function verifyTransferInReceipt(
  receipt: TransactionReceipt,
  p: { token: Address; to: Address; amount: bigint; from?: Address },
) {
  if (receipt.status !== "success") throw new TransferNotVerifiedError("The payment transaction reverted. No tokens moved.");
  const logs = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs, strict: true }).filter(
    (l) => getAddress(l.address) === getAddress(p.token),
  );
  const match = logs.find(
    (l) =>
      getAddress(l.args.to) === getAddress(p.to) &&
      l.args.value === p.amount &&
      (!p.from || getAddress(l.args.from) === getAddress(p.from)),
  );
  if (!match) throw new TransferNotVerifiedError("The transaction succeeded but no matching USDG transfer was found.");
  return match;
}

export function verifyAnnouncementInReceipt(receipt: TransactionReceipt, p: { announcer: Address; stealthAddress: Address }) {
  if (receipt.status !== "success") throw new TransferNotVerifiedError("The announcement transaction reverted.");
  const logs = parseEventLogs({ abi: announcerAbi, eventName: "Announcement", logs: receipt.logs, strict: true });
  const ok = logs.some(
    (l) => getAddress(l.address) === getAddress(p.announcer) && getAddress(l.args.stealthAddress) === getAddress(p.stealthAddress),
  );
  if (!ok) throw new TransferNotVerifiedError("The announcement transaction did not emit the expected event.");
}

/**
 * Waits for a receipt with confirmations, handling replacement and shallow reorgs:
 *  - "repriced" replacements (same tx, higher fee) are followed automatically.
 *  - "cancelled"/"replaced" replacements throw TxReplacedError.
 *  - After confirmation the receipt is re-fetched; if its block hash changed (reorg), we wait again.
 */
export async function waitForConfirmedReceipt(
  client: PublicClient,
  hash: Hash,
  opts: { confirmations: number; timeoutMs?: number; onReplaced?: (newHash: Hash) => void },
): Promise<TransactionReceipt> {
  let current = hash;
  for (let attempt = 0; attempt < 3; attempt++) {
    let replacement: { reason: string; hash: Hash } | null = null;
    const receipt = await client.waitForTransactionReceipt({
      hash: current,
      confirmations: opts.confirmations,
      timeout: opts.timeoutMs ?? 180_000,
      pollingInterval: 1_000,
      onReplaced: (r) => {
        replacement = { reason: r.reason, hash: r.transaction.hash };
      },
    });
    const rep = replacement as { reason: string; hash: Hash } | null;
    if (rep) {
      if (rep.reason === "cancelled" || rep.reason === "replaced") throw new TxReplacedError(rep.reason, rep.hash);
      current = rep.hash;
      opts.onReplaced?.(current);
    }
    const again = await client.getTransactionReceipt({ hash: receipt.transactionHash }).catch(() => null);
    if (again && again.blockHash === receipt.blockHash) return receipt;
    // Reorged out or moved: loop and wait for it to be (re)included.
    current = receipt.transactionHash;
  }
  throw new Error("The transaction kept moving between blocks (reorg). Check the explorer before retrying.");
}
