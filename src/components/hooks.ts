"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { NetworkConfig } from "@/config/networks";
import { createNetworkClient, verifyAnnouncer, verifyToken, type AnnouncerInfo, type TokenInfo } from "@/lib/chain";

export function usePublicClient(network: NetworkConfig) {
  return useMemo(() => createNetworkClient(network), [network]);
}

export interface NetworkReadiness {
  token?: TokenInfo;
  announcer?: AnnouncerInfo;
  tokenError?: string;
  announcerError?: string;
}

/** Verifies the configured token and announcer onchain for a network. */
export function useNetworkReadiness(network: NetworkConfig) {
  const client = usePublicClient(network);
  return useQuery<NetworkReadiness>({
    queryKey: ["readiness", network.key, network.token, network.announcer],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const out: NetworkReadiness = {};
      await Promise.all([
        verifyToken(client, network)
          .then((t) => (out.token = t))
          .catch((e: Error) => (out.tokenError = e.message.split("\n")[0])),
        verifyAnnouncer(client, network)
          .then((a) => (out.announcer = a))
          .catch((e: Error) => (out.announcerError = e.message.split("\n")[0])),
      ]);
      return out;
    },
  });
}
