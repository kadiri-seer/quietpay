/**
 * Recipient flow: scan announcements, match them locally with the request's viewing key,
 * verify actual token transfers, and sweep funds with the locally derived stealth key.
 */
import {
  createWalletClient,
  getAddress,
  keccak256,
  http,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "@/config/contracts";
import type { NetworkConfig } from "@/config/networks";
import { findDeployBlock, scanAnnouncements, verifyTransferInReceipt, waitForConfirmedReceipt, type Announcement } from "./chain";
import { deriveLinkKeys, RECOVERY_GAP } from "./link-keys";
import { parsePaymentMetadata } from "./metadata";
import { announcementMatches, deriveStealthPrivateKey } from "./stealth";
import type { StoredPayment, StoredRequest, VaultData } from "./vault";

export interface ScanResult {
  request: StoredRequest;
  newPayments: number;
  scannedTo: bigint;
}

export function matchRequestAnnouncements(req: StoredRequest, anns: Announcement[]): Announcement[] {
  return anns.filter((a) => {
    const meta = parsePaymentMetadata(a.metadata);
    if (meta.token && getAddress(meta.token) !== getAddress(req.token)) return false;
    // A fixed link's payments carry its request ID; skip payments marked for a different link.
    if (req.kind !== "open" && !req.recovered && meta.requestId && meta.requestId.toLowerCase() !== req.id.toLowerCase()) return false;
    return announcementMatches(a, req.keys);
  });
}

/**
 * Sums verified Transfer events of `token` into `stealth` from `fromBlock`. Transfers from
 * `excludeFrom` (the shielded pool, when an exit sends money back) are the payment's own money
 * returning, not new money received, so they don't count.
 */
export async function receivedAmount(
  client: PublicClient,
  token: Address,
  stealth: Address,
  fromBlock: bigint,
  chunk: bigint,
  toBlock?: bigint,
  excludeFrom: Address[] = [],
) {
  const skip = new Set(excludeFrom.map((a) => a.toLowerCase()));
  const latest = toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
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
      for (const l of logs) if (!skip.has(l.args.from.toLowerCase())) total += l.args.value;
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
    const poolAddrs = network.pool ? [network.pool.pool, network.pool.entrypoint] : [];
    const received = await receivedAmount(client, req.token, m.stealthAddress, BigInt(req.fromBlock), network.logChunkSize, undefined, poolAddrs);
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

/**
 * Applies what a scan found to the latest saved copy of a request. A scan can take a while and
 * starts from an older copy, so only the scan's own findings are taken from it (new payments,
 * received amounts, the scanned block); sends, claims and returns recorded in the meantime stay.
 */
export function mergeScannedRequest(fresh: StoredRequest, scanned: StoredRequest): StoredRequest {
  const byAddr = new Map(fresh.payments.map((p) => [p.stealthAddress.toLowerCase(), p]));
  for (const sp of scanned.payments) {
    const k = sp.stealthAddress.toLowerCase();
    const cur = byAddr.get(k);
    byAddr.set(
      k,
      cur
        ? { ...cur, receivedAmount: sp.receivedAmount, transferVerified: sp.transferVerified, detectedAt: sp.detectedAt, announcementTx: sp.announcementTx, announcementBlock: sp.announcementBlock }
        : sp,
    );
  }
  const scannedTo = scanned.lastScannedBlock && (!fresh.lastScannedBlock || BigInt(scanned.lastScannedBlock) > BigInt(fresh.lastScannedBlock)) ? scanned.lastScannedBlock : fresh.lastScannedBlock;
  return { ...fresh, payments: [...byAddr.values()], ...(scannedTo ? { lastScannedBlock: scannedTo } : {}) };
}

/** Adds scan results (and links recovered from the chain) to the latest vault without dropping anything. */
export function applyScan(
  v: VaultData,
  p: { scanned: StoredRequest[]; recovered: StoredRequest[]; nextLinkIndex: number; checkedAt: number },
): VaultData {
  const scannedById = new Map(p.scanned.map((r) => [r.id, r]));
  const requests = v.requests.map((r) => (scannedById.has(r.id) ? mergeScannedRequest(r, scannedById.get(r.id)!) : r));
  const knownIds = new Set(requests.map((r) => r.id));
  const knownMeta = new Set(requests.map((r) => r.keys.stealthMetaAddress.toLowerCase()));
  const added = p.recovered.filter((r) => !knownIds.has(r.id) && !knownMeta.has(r.keys.stealthMetaAddress.toLowerCase()));
  return {
    ...v,
    requests: [...added, ...requests].sort((a, b) => b.createdAt - a.createdAt),
    nextLinkIndex: Math.max(v.nextLinkIndex ?? 0, p.nextLinkIndex),
    linksCheckedAt: p.checkedAt,
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

export interface DiscoveryResult {
  /** Links found on the chain that this browser didn't know about. */
  found: StoredRequest[];
  /** Next unused link number, at least as high as before. */
  nextLinkIndex: number;
  anns: Announcement[];
  toBlock: bigint;
}

/**
 * Finds wallet-derived links that have received payments but aren't in this browser yet: on a new
 * device, after clearing site data, or when links were made on another device. Checks link
 * numbers in order and keeps going until RECOVERY_GAP numbers in a row have no payments.
 *
 * `fullHistory` scans from the announcer's deployment; otherwise from the oldest known link.
 * All matching is local; the RPC only sees which blocks are read.
 */
export async function discoverLinks(
  client: PublicClient,
  network: NetworkConfig,
  p: {
    seed: Hex;
    nextLinkIndex: number;
    known: StoredRequest[];
    token: { address: Address; decimals: number; symbol: string };
    fullHistory: boolean;
    onProgress?: (done: bigint, total: bigint) => void;
    onChecking?: (index: number) => void;
    signal?: AbortSignal;
  },
): Promise<DiscoveryResult> {
  if (!network.announcer) throw new Error("No announcer configured.");
  const knownHere = p.known.filter((r) => r.chainId === network.chain.id);
  const toBlock = await client.getBlockNumber({ cacheTime: 0 });
  const fromBlock =
    p.fullHistory || knownHere.length === 0
      ? (network.announcerFromBlock ?? (await findDeployBlock(client, network.announcer)))
      : knownHere.reduce((min, r) => (BigInt(r.fromBlock) < min ? BigInt(r.fromBlock) : min), BigInt(knownHere[0].fromBlock));
  const anns = await scanAnnouncements(client, {
    announcer: network.announcer,
    fromBlock,
    toBlock,
    chunkSize: network.logChunkSize,
    signal: p.signal,
    onProgress: p.onProgress ? (to) => p.onProgress!(to - fromBlock, toBlock - fromBlock) : undefined,
  });

  const knownIndexes = new Set(knownHere.filter((r) => r.index !== undefined).map((r) => r.index!));
  const knownMeta = new Set(p.known.map((r) => r.keys.stealthMetaAddress.toLowerCase()));
  const highestKnown = Math.max(p.nextLinkIndex - 1, ...[...knownIndexes], -1);
  let upper = highestKnown + 1 + RECOVERY_GAP;
  let next = p.nextLinkIndex;
  const found: StoredRequest[] = [];
  const candidates = anns.filter((a) => {
    const meta = parsePaymentMetadata(a.metadata);
    return !meta.token || getAddress(meta.token) === getAddress(p.token.address);
  });

  for (let i = 0; i < upper; i++) {
    if (p.signal?.aborted) throw new DOMException("Scan cancelled", "AbortError");
    if (knownIndexes.has(i)) continue;
    p.onChecking?.(i);
    const keys = await deriveLinkKeys(p.seed, network.chain.id, i);
    if (knownMeta.has(keys.stealthMetaAddress.toLowerCase())) continue;
    const matches = candidates.filter((a) => announcementMatches(a, keys));
    if (matches.length === 0) continue;
    upper = Math.max(upper, i + 1 + RECOVERY_GAP);
    next = Math.max(next, i + 1);
    const requestId = matches.map((m) => parsePaymentMetadata(m.metadata).requestId).find((x) => !!x) ?? null;
    const first = matches.reduce((a, b) => (a.blockNumber <= b.blockNumber ? a : b));
    const block = await client.getBlock({ blockNumber: first.blockNumber });
    found.push({
      id: (requestId ?? (`0x${keccak256(keys.stealthMetaAddress).slice(2, 34)}` as Hex)).toLowerCase() as Hex,
      kind: requestId ? "fixed" : "open",
      chainId: network.chain.id,
      token: p.token.address,
      amount: "0",
      decimals: p.token.decimals,
      symbol: p.token.symbol,
      expiresAt: 0,
      createdAt: Number(block.timestamp) * 1000,
      fromBlock: first.blockNumber.toString(),
      link: "",
      keys,
      index: i,
      recovered: true,
      payments: [],
    });
  }
  return { found, nextLinkIndex: next, anns, toBlock };
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
 * Sends `amount` (default: everything) of the payment's tokens from its one-time address to `to`.
 * The one-time private key is derived locally, used to sign locally, and discarded. Gas is paid by
 * the address's own ETH (normally the stipend the payer included), never auto-funded.
 */
export async function sendFromStealthPayment(
  client: PublicClient,
  network: NetworkConfig,
  p: { request: StoredRequest; payment: StoredPayment; to: Address; amount?: bigint },
): Promise<{ hash: Hash; amount: bigint; remaining: bigint }> {
  const to = getAddress(p.to);
  const key = deriveStealthPrivateKey(p.payment.ephemeralPublicKey, p.payment.stealthAddress, p.request.keys);
  const account = privateKeyToAccount(key);
  if (getAddress(to) === getAddress(account.address)) throw new Error("Choose a different destination address.");
  const { token: balance, eth } = await stealthBalances(client, p.request.token, account.address);
  if (balance === 0n) throw new Error("This one-time address holds no tokens.");
  const amount = p.amount ?? balance;
  if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
  if (amount > balance) throw new Error("That is more than this payment holds.");
  const est = await estimateSweepCost(client, p.request.token, account.address, to, amount);
  if (eth < est.gas * est.maxFeePerGas) {
    throw new Error("This one-time address needs a little ETH for gas before it can send.");
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
  return { hash: receipt.transactionHash, amount, remaining: balance - amount };
}

/** Gas for a plain ETH transfer. */
const ETH_TRANSFER_GAS = 21_000n;

/** ETH left at a one-time address (the payer's gas money) and what moving it would leave after fees. */
export async function leftoverEth(client: PublicClient, stealth: Address): Promise<{ eth: bigint; movable: bigint; maxFeePerGas: bigint }> {
  const [eth, fees] = await Promise.all([client.getBalance({ address: stealth }), client.estimateFeesPerGas()]);
  const maxFeePerGas = ((fees.maxFeePerGas ?? 0n) * 6n) / 5n;
  const cost = ETH_TRANSFER_GAS * maxFeePerGas;
  return { eth, movable: eth > cost ? eth - cost : 0n, maxFeePerGas };
}

/**
 * Sends the ETH left at a payment's one-time address to `to`, once its tokens are gone. The fee
 * is reserved first, so the transfer can't fail for lack of gas; a few wei may stay behind.
 */
export async function sweepLeftoverEth(
  client: PublicClient,
  network: NetworkConfig,
  p: { request: StoredRequest; payment: StoredPayment; to: Address },
): Promise<{ hash: Hash; amount: bigint }> {
  const account = stealthAccount(p.request, p.payment);
  const to = getAddress(p.to);
  if (to === getAddress(account.address)) throw new Error("Choose a different destination address.");
  const { movable, maxFeePerGas } = await leftoverEth(client, account.address);
  if (movable <= 0n) throw new Error("There is too little ETH here to cover the fee for moving it.");
  const wallet = createWalletClient({ account, chain: network.chain, transport: http(network.rpcUrl, { timeout: 20_000 }) });
  const priority = maxFeePerGas / 10n;
  const hash = await wallet.sendTransaction({ to, value: movable, gas: ETH_TRANSFER_GAS, maxFeePerGas, maxPriorityFeePerGas: priority });
  const receipt = await waitForConfirmedReceipt(client, hash, { confirmations: network.confirmations });
  if (receipt.status !== "success") throw new Error("The transfer failed.");
  return { hash: receipt.transactionHash, amount: movable };
}

/** The payment's one-time address as a local signer. The key is derived in memory only. */
export function stealthAccount(request: StoredRequest, payment: StoredPayment) {
  return privateKeyToAccount(deriveStealthPrivateKey(payment.ephemeralPublicKey, payment.stealthAddress, request.keys));
}

/** Moves the whole balance (a full claim). */
export function sweepStealthPayment(client: PublicClient, network: NetworkConfig, p: { request: StoredRequest; payment: StoredPayment; to: Address }) {
  return sendFromStealthPayment(client, network, p);
}

/** Records a send; marks the payment claimed once its balance reaches zero. */
export function recordSend(
  req: StoredRequest,
  stealth: Address,
  send: { tx: Hex; to: Address; amount: bigint },
  remaining: bigint,
): StoredRequest {
  return {
    ...req,
    payments: req.payments.map((p) => {
      if (getAddress(p.stealthAddress) !== getAddress(stealth)) return p;
      const sends = [...(p.sends ?? []), { tx: send.tx, to: getAddress(send.to), amount: send.amount.toString(), at: Date.now() }];
      return remaining === 0n
        ? { ...p, sends, claimTx: send.tx, claimedTo: getAddress(send.to), claimedAt: Date.now() }
        : { ...p, sends };
    }),
  };
}

export function markClaimed(req: StoredRequest, stealth: Address, hash: Hex, to: Address): StoredRequest {
  return {
    ...req,
    payments: req.payments.map((p) =>
      getAddress(p.stealthAddress) === getAddress(stealth) ? { ...p, claimTx: hash, claimedTo: getAddress(to), claimedAt: Date.now() } : p,
    ),
  };
}
