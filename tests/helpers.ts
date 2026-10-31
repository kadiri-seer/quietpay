import type { Address } from "viem";
import { NETWORKS, type NetworkConfig, type NetworkKey } from "@/config/networks";

export const TEST_TOKEN: Address = "0x1111111111111111111111111111111111111111";

export function testNetworks(overrides: Partial<NetworkConfig> = {}, mainnet: Partial<NetworkConfig> = {}): Record<NetworkKey, NetworkConfig> {
  return {
    testnet: { ...NETWORKS.testnet, token: TEST_TOKEN, ...overrides },
    mainnet: { ...NETWORKS.mainnet, ...mainnet },
  };
}

/** In-memory localStorage stand-in. */
export class MemoryStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
