/**
 * Recipient flow: scan announcements, match them locally with the request's viewing key,
 * verify actual token transfers, and sweep funds with the locally derived stealth key.
 */
import {
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "@/config/contracts";
import type { NetworkConfig } from "@/config/networks";
import { scanAnnouncements, verifyTransferInReceipt, waitForConfirmedReceipt, type Announcement } from "./chain";
import { parsePaymentMetadata } from "./metadata";
import { announcementMatches, deriveStealthPrivateKey } from "./stealth";
import type { StoredPayment, StoredRequest } from "./vault";

export interface ScanResult {
  request: StoredRequest;
  newPayments: number;
  scannedTo: bigint;
}

export function matchRequestAnnouncements(req: StoredRequest, anns: Announcement[]): Announcement[] {
  return anns.filter((a) => {
    const meta = parsePaymentMetadata(a.metadata);
    if (meta.token && getAddress(meta.token) !== getAddress(req.token)) return false;
    return announcementMatches(a, req.keys);
  });
}

/** Sums verified Transfer events of `token` into `stealth` from `fromBlock`. */
export async function receivedAmount(client: PublicClient, token: Address, stealth: Address, fromBlock: bigint, chunk: bigint) {
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  let total = 0n;
  let start = fromBlock;
  let size = chunk;
  while (start <= latest) {
    const end = start + size - 1n > latest ? latest : start + size - 1n;
    try {
      const logs = await client.getContractEvents({
        address: token,
        abi: erc20Abi,
        eventName: "Transfer",
        args: { to: stealth },
        fromBlock: start,
        toBlock: end,
        strict: true,
      });
      for (const l of logs) total += l.args.value;
      start = end + 1n;
    } catch (e) {
      if (size <= 100n) throw e;
      size /= 2n;
    }
  }
  return total;
}

/**
 * Scans one request. Uses a shared announcement list when provided (scan once, match many).
 * Returns an updated copy of the request; the caller persists it to the encrypted vault.
 */
export async function scanRequest(
  client: PublicClient,
  network: NetworkConfig,
  req: StoredRequest,
  anns: Announcement[],
  scannedTo: bigint,
): Promise<ScanResult> {
  const matches = matchRequestAnnouncements(req, anns);
  const known = new Map(req.payments.map((p) => [p.stealthAddress.toLowerCase(), p]));
  let newPayments = 0;
  for (const m of matches) {
    const existing = known.get(m.stealthAddress.toLowerCase());
    if (existing?.claimTx) continue;
    const received = await receivedAmount(client, req.token, m.stealthAddress, BigInt(req.fromBlock), network.logChunkSize);
    const block = await client.getBlock({ blockNumber: m.blockNumber });
    const p: StoredPayment = {
      stealthAddress: m.stealthAddress,
      ephemeralPublicKey: m.ephemeralPubKey,
      announcementTx: m.transactionHash,
      announcementBlock: m.blockNumber.toString(),
      detectedAt: Number(block.timestamp) * 1000,
      receivedAmount: received.toString(),
      transferVerified: received > 0n,
    };
    if (!existing) newPayments++;
    known.set(m.stealthAddress.toLowerCase(), { ...existing, ...p });
  }
  return {
    request: { ...req, payments: [...known.values()], lastScannedBlock: scannedTo.toString() },
    newPayments,
    scannedTo,
  };
}

export async function fetchAnnouncementsForRequests(
  client: PublicClient,
  network: NetworkConfig,
  requests: StoredRequest[],
  onProgress?: (done: bigint, total: bigint) => void,
  signal?: AbortSignal,
) {
  if (!network.announcer) throw new Error("No announcer configured.");
  const relevant = requests.filter((r) => r.chainId === network.chain.id);
  if (relevant.length === 0) return { anns: [] as Announcement[], toBlock: 0n };
  const fromBlock = relevant.reduce((min, r) => {
    const b = BigInt(r.fromBlock);
    return b < min ? b : min;
  }, BigInt(relevant[0].fromBlock));
  const toBlock = await client.getBlockNumber({ cacheTime: 0 });
  const anns = await scanAnnouncements(client, {
    announcer: network.announcer,
    fromBlock,
    toBlock,
    chunkSize: network.logChunkSize,
    signal,
    onProgress: onProgress ? (to) => onProgress(to - fromBlock, toBlock - fromBlock) : undefined,
  });
  return { anns, toBlock };
}

export interface StealthBalances {
  token: bigint;
  eth: bigint;
}

export async function stealthBalances(client: PublicClient, token: Address, stealth: Address): Promise<StealthBalances> {
  const [t, e] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [stealth] }),
    client.getBalance({ address: stealth }),
  ]);
  return { token: t, eth: e };
}

/** Estimated ETH needed (with 50% headroom) to sweep the token balance out of a stealth address. */
export async function estimateSweepCost(client: PublicClient, token: Address, stealth: Address, to: Address, amount: bigint) {
  const [gas, fees] = await Promise.all([
    client.estimateContractGas({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount], account: stealth }),
    client.estimateFeesPerGas(),
  ]);
  const maxFeePerGas = fees.maxFeePerGas ?? 0n;
  return { gas, maxFeePerGas, cost: (gas * maxFeePerGas * 3n) / 2n };
}

/**
 * Sweeps the full token balance from a stealth address to `to`.
 * The stealth private key is derived locally, used to sign locally, and discarded.
 */
export async function sweepStealthPayment(
  client: PublicClient,
  network: NetworkConfig,
  p: { request: StoredRequest; payment: StoredPayment; to: Address },
): Promise<{ hash: Hash; amount: bigint }> {
  const to = getAddress(p.to);
  const key = deriveStealthPrivateKey(p.payment.ephemeralPublicKey, p.payment.stealthAddress, p.request.keys);
  const account = privateKeyToAccount(key);
  const { token: amount, eth } = await stealthBalances(client, p.request.token, account.address);
  if (amount === 0n) throw new Error("This stealth address holds no tokens to claim.");
  const est = await estimateSweepCost(client, p.request.token, account.address, to, amount);
  if (eth < (est.gas * est.maxFeePerGas)) {
    throw new Error("This stealth address needs a little ETH for gas before it can be claimed.");
  }
  const wallet = createWalletClient({ account, chain: network.chain, transport: http(network.rpcUrl, { timeout: 20_000 }) });
  const hash = await wallet.writeContract({
    address: p.request.token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
    gas: (est.gas * 6n) / 5n,
  });
  const receipt = await waitForConfirmedReceipt(client, hash, { confirmations: network.confirmations });
  verifyTransferInReceipt(receipt, { token: p.request.token, to, amount, from: account.address });
  return { hash: receipt.transactionHash, amount };
}

export function markClaimed(req: StoredRequest, stealth: Address, hash: Hex, to: Address): StoredRequest {
  return {
    ...req,
    payments: req.payments.map((p) =>
      getAddress(p.stealthAddress) === getAddress(stealth) ? { ...p, claimTx: hash, claimedTo: getAddress(to), claimedAt: Date.now() } : p,
    ),
  };
}
