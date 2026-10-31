"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import type { Chain } from "viem";
import { DEFAULT_NETWORK, NETWORKS, enabledNetworks, type NetworkConfig, type NetworkKey } from "@/config/networks";
import { VaultProvider } from "./VaultProvider";

const nets = enabledNetworks();
const chains = nets.map((n) => n.chain) as [Chain, ...Chain[]];

/** Public Reown (WalletConnect) project ID. WalletConnect is offered only when it is set. */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

const origin = typeof window !== "undefined" ? window.location.origin : "https://quietpay.app";

export const wagmiConfig = createConfig({
  chains,
  connectors: [
    injected({ shimDisconnect: true }),
    ...(WALLETCONNECT_PROJECT_ID
      ? [
          walletConnect({
            projectId: WALLETCONNECT_PROJECT_ID,
            showQrModal: true,
            metadata: {
              name: "QuietPay",
              description: "One-time USDG payment links on Robinhood Chain",
              url: origin,
              icons: [`${origin}/icon.svg`],
            },
            qrModalOptions: { themeMode: "dark", themeVariables: { "--wcm-accent-color": "#5bb8ea", "--wcm-background-color": "#0c2c39" } },
          }),
        ]
      : []),
  ],
  transports: Object.fromEntries(nets.map((n) => [n.chain.id, http(n.rpcUrl)])),
  ssr: true,
});

interface NetworkContextValue {
  network: NetworkConfig;
  setNetwork: (k: NetworkKey) => void;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function useSelectedNetwork() {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error("NetworkContext missing");
  return ctx;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  const [key, setKey] = useState<NetworkKey>(DEFAULT_NETWORK);
  const value = useMemo<NetworkContextValue>(
    () => ({ network: NETWORKS[key], setNetwork: (k) => NETWORKS[k].enabled && setKey(k) }),
    [key],
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <NetworkContext.Provider value={value}>
          <VaultProvider>{children}</VaultProvider>
        </NetworkContext.Provider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
