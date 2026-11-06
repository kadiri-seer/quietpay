"use client";

/**
 * Your connected wallet's own tokens, as part of QuietPay.
 *
 * They count in the Home total, but they are public: anyone can see a wallet's balance. Two ways
 * to use them:
 *   - "Add to balance": one signature pays them into your own shielded balance, through the pool
 *     router, under a lock only your keys open. Onchain it shows your wallet paid into the pool,
 *     not where the money goes afterwards.
 *   - Send tops up from the wallet when your private balance is short; those parts show your
 *     wallet as the payer.
 */
import { useCallback, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Entrypoint } from "@/config/pool-contracts.generated";
import type { NetworkConfig } from "@/config/networks";
import { erc20Abi } from "@/config/contracts";
import { payIntoPool, receiveLock } from "@/lib/pool/receive";
import { classifyTxError } from "@/lib/tx-errors";
import { useNetworkReadiness, usePublicClient } from "./hooks";
import { usePoolInfo, usePoolKeys, usePoolRouter, usePoolSnapshot, type PoolSnapshot } from "./pool-hooks";
import { useVault } from "./VaultProvider";

export function useWalletToken(network: NetworkConfig) {
  const { address } = useAccount();
  const client = usePublicClient(network);
  const readiness = useNetworkReadiness(network);
  const token = readiness.data?.token;
  return useQuery({
    queryKey: ["wallet-token", network.key, address, token?.address],
    enabled: !!address && !!token,
    staleTime: 15_000,
    queryFn: () => client.readContract({ address: token!.address, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
  });
}

/**
 * Pays `amount` from your connected wallet into your own shielded balance (one signature, or an
 * approval first if the pool router was never allowed). The lock takes the next link number,
 * saved before paying, so no link ever shares it and any device finds the money again.
 */
export function useDepositToSelf(network: NetworkConfig) {
  const client = usePublicClient(network);
  const { data: wallet } = useWalletClient({ chainId: network.chain.id });
  const readiness = useNetworkReadiness(network);
  const info = usePoolInfo(network);
  const router = usePoolRouter(network);
  const snap = usePoolSnapshot(network);
  const keys = usePoolKeys();
  const { update } = useVault();
  const queryClient = useQueryClient();
  const ready = !!wallet && !!info.data && !!router.data && !!readiness.data?.token && keys.length > 0 && !!snap.data;

  const deposit = useCallback(
    async (amount: bigint) => {
      if (!ready) throw new Error("Still getting ready. Try again in a moment.");
      const pool = info.data!;
      if (amount < pool.minimumDeposit) throw new Error("That's below the pool's smallest deposit.");
      try {
        let index = 0;
        await update(async (cur) => {
          index = Math.max(cur.nextLinkIndex ?? 0, Number(snap.data!.nextReceiveIndex));
          for (let tries = 0; tries < 50; tries++) {
            const used = await client.readContract({ address: pool.entrypoint, abi: Entrypoint.abi, functionName: "usedPrecommitments", args: [receiveLock(keys[0], pool.scope, BigInt(index)).precommitment] });
            if (!used) break;
            index++;
          }
          return { ...cur, nextLinkIndex: index + 1 };
        });
        const lock = receiveLock(keys[0], pool.scope, BigInt(index));
        const { hash } = await payIntoPool(wallet!, client, { network, router: router.data!, token: readiness.data!.token!.address, lock, amount });
        await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
        // Ask for the pool's approval straight away (on testnet it takes seconds).
        void fetch("/api/pool/approvals", { method: "POST" }).catch(() => null);
        // Re-read until the balance shows it, so the screen never lags behind the chain.
        for (let i = 0; i < 20; i++) {
          await queryClient.refetchQueries({ queryKey: ["pool-snapshot"], type: "active" });
          const seen = queryClient
            .getQueriesData<PoolSnapshot>({ queryKey: ["pool-snapshot"] })
            .some(([, d]) => d?.notes.some((n) => n.received?.receiveIndex === BigInt(index)));
          if (seen) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        return hash;
      } finally {
        await Promise.all(["wallet-token", "pool-info", "pool-snapshot"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      }
    },
    [ready, info.data, router.data, readiness.data, keys, snap.data, wallet, client, network, update, queryClient],
  );
  return { deposit, ready };
}

/** Home's "Add to private balance". */
export function useAddToBalance(network: NetworkConfig) {
  const { deposit, ready } = useDepositToSelf(network);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const run = useCallback(
    async (amount: bigint) => {
      if (state.busy) return;
      setState({ busy: true, error: null, done: false });
      try {
        await deposit(amount);
        setState({ busy: false, error: null, done: true });
      } catch (e) {
        setState({ busy: false, error: e instanceof Error && !("shortMessage" in e) ? e.message : classifyTxError(e).message, done: false });
      }
    },
    [deposit, state.busy],
  );
  return { run, ready, ...state };
}
