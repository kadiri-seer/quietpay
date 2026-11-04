"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import type { NetworkConfig } from "@/config/networks";
import { erc20Abi, mockTokenFaucetAbi } from "@/config/contracts";
import { formatAmount } from "@/lib/amount";
import { classifyTxError } from "@/lib/tx-errors";
import { useNetworkReadiness, usePublicClient } from "@/components/hooks";
import { useSelectedNetwork } from "@/components/Providers";
import { ETH_FAUCET_URL } from "@/components/SiteChrome";
import { SetupBlocker } from "@/components/SetupBlocker";
import { ExplorerLink, LoadingRows, Notice, PageTitle, Spinner, formatEthCeil } from "@/components/ui";
import { WalletGate } from "@/components/WalletGate";

export function FaucetFlow() {
  const { network } = useSelectedNetwork();
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
      <PageTitle light="Test" bold="money">
        Two things to try QuietPay on testnet: a little ETH for network fees, and test {network.expectedSymbol} to send. Neither has any value.
      </PageTitle>
      {!network.chain.testnet ? (
        <Notice tone="info">Test money is only available on testnet.</Notice>
      ) : (
        <div className="space-y-4">
          <section className="panel p-5 sm:p-7" aria-labelledby="eth-h">
            <h2 id="eth-h" className="font-display text-lg font-semibold tracking-[-0.01em] text-snow">
              <span className="mr-2 text-haze">1</span>Test ETH for fees
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-haze">
              Robinhood Chain&apos;s faucet sends free testnet ETH to your wallet address. A small amount covers many payments.
            </p>
            <a href={ETH_FAUCET_URL} target="_blank" rel="noopener noreferrer" className="btn btn-primary mt-5">
              Open the ETH faucet<span aria-hidden> ↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </section>
          <section className="panel p-5 sm:p-7" aria-labelledby="token-h">
            <h2 id="token-h" className="font-display text-lg font-semibold tracking-[-0.01em] text-snow">
              <span className="mr-2 text-haze">2</span>Test {network.expectedSymbol} to send
            </h2>
            <p className="mt-2 mb-5 text-sm leading-relaxed text-haze">
              {network.expectedSymbol} is QuietPay&apos;s test token. It is not USDG and has no value. Claiming it is a transaction, so you need a
              little test ETH first.
            </p>
            <WalletGate network={network} purpose="Connect the wallet that should receive test tokens.">
              <TokenClaim network={network} />
            </WalletGate>
          </section>
        </div>
      )}
    </div>
  );
}

function TokenClaim({ network }: { network: NetworkConfig }) {
  const { address } = useAccount();
  const { data: wallet } = useWalletClient({ chainId: network.chain.id });
  const client = usePublicClient(network);
  const readiness = useNetworkReadiness(network);
  const [bal, setBal] = useState<{ eth: bigint; token: bigint } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<`0x${string}` | null>(null);
  const token = readiness.data?.token;

  const refresh = useCallback(async () => {
    if (!address || !token) return;
    const [eth, tk] = await Promise.all([
      client.getBalance({ address }),
      client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    ]);
    setBal({ eth, token: tk });
  }, [address, token, client]);

  useEffect(() => {
    void refresh().catch(() => setBal(null));
  }, [refresh]);

  async function claim() {
    if (!wallet || !token) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const hash = await wallet.writeContract({
        chain: network.chain,
        account: wallet.account,
        address: token.address,
        abi: mockTokenFaucetAbi,
        functionName: "faucet",
        args: [10n ** BigInt(token.decimals) * 1000n],
      });
      await client.waitForTransactionReceipt({ hash, confirmations: network.confirmations });
      setDone(hash);
      await refresh();
    } catch (e) {
      setError(classifyTxError(e).message);
    } finally {
      setBusy(false);
    }
  }

  if (readiness.isLoading) return <LoadingRows label="Checking the test token" rows={2} />;
  if (!token) return <SetupBlocker network={network} readiness={readiness.data} error={readiness.error} />;
  if (!token.isMock) return <Notice tone="info">This network uses real {token.symbol}. There is no faucet for it.</Notice>;

  return (
    <div className="space-y-4">
      {bal && (
        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-haze">Test ETH in your wallet</dt>
          <dd className="text-right text-snow">{formatEthCeil(bal.eth)} ETH</dd>
          <dt className="text-haze">{token.symbol} in your wallet</dt>
          <dd className="text-right text-snow">
            {formatAmount(bal.token, token.decimals, { group: true })} {token.symbol}
          </dd>
        </dl>
      )}
      {bal && (
        <p className="text-xs leading-relaxed text-haze">
          This is your wallet, outside QuietPay. Your private QuietPay balance is on Home; money gets there when someone pays your
          username, link or request.
        </p>
      )}
      {bal && bal.eth === 0n && (
        <Notice tone="warn" title="No test ETH yet">
          Get some from the ETH faucet above first. Claiming {token.symbol} costs a tiny fee.
        </Notice>
      )}
      <button type="button" className="btn btn-primary" onClick={claim} disabled={busy || !wallet}>
        {busy ? <Spinner /> : null} Get 1,000 {token.symbol}
      </button>
      {done && (
        <Notice tone="ok">
          1,000 {token.symbol} added to your wallet · <ExplorerLink network={network} tx={done} />
        </Notice>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}
