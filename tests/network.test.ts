import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_NETWORK,
  MAINNET_ENABLED,
  MAINNET_USDG,
  NETWORKS,
  ROBINHOOD_MAINNET_ID,
  ROBINHOOD_TESTNET_ID,
  enabledNetworks,
  networkForChainId,
} from "@/config/networks";
import { KNOWN_ANNOUNCER_CODE_HASHES, MOCK_TOKEN_CODE_HASH } from "@/config/contracts";
import { testNetworks } from "./helpers";

describe("network configuration", () => {
  it("uses the documented chain IDs and endpoints", () => {
    expect(NETWORKS.testnet.chain.id).toBe(ROBINHOOD_TESTNET_ID);
    expect(NETWORKS.mainnet.chain.id).toBe(ROBINHOOD_MAINNET_ID);
    expect(ROBINHOOD_TESTNET_ID).toBe(46630);
    expect(ROBINHOOD_MAINNET_ID).toBe(4663);
    expect(NETWORKS.mainnet.explorerUrl).toBe("https://robinhoodchain.blockscout.com");
    expect(MAINNET_USDG).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  });

  it("defaults to testnet and keeps mainnet disabled unless explicitly enabled", () => {
    expect(MAINNET_ENABLED).toBe(false);
    expect(DEFAULT_NETWORK).toBe("testnet");
    expect(NETWORKS.mainnet.enabled).toBe(false);
    expect(enabledNetworks().map((n) => n.key)).toEqual(["testnet"]);
    expect(networkForChainId(ROBINHOOD_MAINNET_ID)).toBeNull();
    expect(networkForChainId(ROBINHOOD_TESTNET_ID)?.key).toBe("testnet");
    expect(networkForChainId(1)).toBeNull();
  });

  it("enables mainnet only when its flag is set", () => {
    const nets = testNetworks({}, { enabled: true });
    expect(networkForChainId(ROBINHOOD_MAINNET_ID, nets)?.key).toBe("mainnet");
  });

  it("labels the testnet token as a mock and never assumes an announcer", () => {
    expect(NETWORKS.testnet.tokenIsMock).toBe(true);
    expect(NETWORKS.mainnet.tokenIsMock).toBe(false);
    expect(NETWORKS.testnet.expectedSymbol).toBe("tUSDG");
    // No Ethereum deployment address is baked in.
    expect(NETWORKS.testnet.announcer).toBeNull();
    expect(NETWORKS.mainnet.announcer).toBeNull();
  });

  it("pins bytecode fingerprints to the committed compiled artifacts", () => {
    const art = (n: string) => JSON.parse(readFileSync(join(__dirname, "..", "contracts", "artifacts", `${n}.json`), "utf8"));
    expect(KNOWN_ANNOUNCER_CODE_HASHES).toContain(art("ERC5564Announcer").runtimeCodeHash);
    expect(MOCK_TOKEN_CODE_HASH).toBe(art("QuietPayTestUSDG").runtimeCodeHash);
  });
});
