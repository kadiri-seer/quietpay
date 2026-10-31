"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { injected } from "wagmi/connectors";
import type { Chain } from "viem";
import { DEFAULT_NETWORK, NETWORKS, enabledNetworks, type NetworkConfig, type NetworkKey } from "@/config/networks";
import { VaultProvider } from "./VaultProvider";

const nets = enabledNetworks();
const chains = nets.map((n) => n.chain) as [Chain, ...Chain[]];

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected({ shimDisconnect: true })],
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
