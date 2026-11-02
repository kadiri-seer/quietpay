import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledSanctions, fetchLiveSanctions, parseAddressList, parseSdnCsv } from "@/lib/screening/sanctions";
import { encodeAspDescriptor, exclusionListId, parseAspDescriptor } from "@/lib/pool/state";
import { screeningOn } from "@/lib/pool/server";

const A = "0x8589427373D6D84E98730D7795D8f6f8731FDA16";

describe("sanctions list", () => {
  it("reads 0x addresses from the official SDN CSV remarks, for any EVM currency tag", () => {
    const csv = `36003,"SOME ENTITY","-0- ","CYBER2",...,"Digital Currency Address - ETH ${A}; Digital Currency Address - USDT 0x0330070FD38Ec3bB94F58FA55D40368271E9e54A; Digital Currency Address - XBT 1AbCdEfG"`;
    expect(parseSdnCsv(csv)).toEqual([A.toLowerCase(), "0x0330070fd38ec3bb94f58fa55d40368271e9e54a"]);
  });

  it("reads plain lists and ignores anything that isn't an address", () => {
    expect(parseAddressList(`${A}\n\nnot-an-address\n${A}\n`)).toEqual([A.toLowerCase()]);
  });

  it("ships a bundled copy so screening works with no network", () => {
    const b = bundledSanctions();
    expect(b.size).toBeGreaterThan(100);
    expect(b.has("0x0330070FD38Ec3bB94F58FA55D40368271E9e54A")).toBe(true);
    expect(b.has("0x0000000000000000000000000000000000000001")).toBe(false);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("falls back when no live source answers, and refuses a suspiciously small download", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await fetchLiveSanctions()).toBeNull();
    vi.stubGlobal("fetch", async () => new Response(`${A}\n`, { status: 200 }));
    expect(await fetchLiveSanctions()).toBeNull();
  });
});

describe("approval rule with exclusions", () => {
  it("encodes v2 within the 64-character field and parses both versions", () => {
    const id = exclusionListId([5n, 3n]);
    const v2 = encodeAspDescriptor(146_414_933n, id);
    expect(v2.length).toBeLessThanOrEqual(64);
    expect(parseAspDescriptor(v2)).toEqual({ uptoBlock: 146_414_933n, exclusionId: id });
    expect(parseAspDescriptor(encodeAspDescriptor(7n))).toEqual({ uptoBlock: 7n, exclusionId: null });
    expect(parseAspDescriptor("quietpay-asp-v2:upto=1:x=nothex")).toBeNull();
  });

  it("gives a list the same id whatever order its labels arrive in", () => {
    expect(exclusionListId([3n, 1n, 2n])).toBe(exclusionListId([1n, 2n, 3n]));
    expect(exclusionListId([1n, 2n])).not.toBe(exclusionListId([1n, 2n, 3n]));
  });
});

describe("screening switch", () => {
  it("is on for mainnet and off for testnet unless set", () => {
    expect(screeningOn(undefined, "mainnet")).toBe(true);
    expect(screeningOn(undefined, "testnet")).toBe(false);
    expect(screeningOn("on", "testnet")).toBe(true);
    expect(screeningOn("OFF", "mainnet")).toBe(false);
  });
});
