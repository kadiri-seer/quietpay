import { describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  DecryptionError,
  buildVaultMessage,
  deriveVaultKey,
  open,
  seal,
  vaultAad,
} from "@/lib/vault-crypto";
import { emptyVault, hasVault, loadVault, saveVault, vaultStorageKey } from "@/lib/vault";
import { createPaymentRequest } from "@/lib/request";
import { TEST_TOKEN, MemoryStore } from "./helpers";


async function walletKey() {
  const acct = privateKeyToAccount(generatePrivateKey());
  const sig = await acct.signMessage({ message: buildVaultMessage(acct.address) });
  return { acct, sig, key: await deriveVaultKey(sig, acct.address) };
}

function sampleRequest() {
  return createPaymentRequest({
    chainId: 46630,
    token: TEST_TOKEN,
    amount: 5_000_000n,
    decimals: 6,
    symbol: "tUSDG",
    expirySeconds: 3600,
    fromBlock: 10n,
  });
}

describe("vault message", () => {
  it("is domain separated and names the wallet", () => {
    const m = buildVaultMessage("0x1111111111111111111111111111111111111111");
    expect(m).toContain("QuietPay keys");
    expect(m).toContain("quietpay/vault-encryption");
    expect(m).toContain("does not send a transaction");
    expect(m).toContain("only sign this message on QuietPay's own website");
    expect(m).toContain("0x1111111111111111111111111111111111111111");
  });
});

describe("authenticated encryption", () => {
  it("round-trips with the signature-derived key", async () => {
    const { acct, key } = await walletKey();
    const sealed = await seal(key, { hello: "world" }, vaultAad(acct.address));
    expect(sealed.alg).toBe("AES-256-GCM");
    expect(await open(key, sealed, vaultAad(acct.address))).toEqual({ hello: "world" });
  });

  it("derives the same key from the same deterministic signature", async () => {
    const { acct, sig } = await walletKey();
    const k1 = await deriveVaultKey(sig, acct.address);
    const k2 = await deriveVaultKey(sig, acct.address);
    const sealed = await seal(k1, [1, 2, 3], "aad");
    expect(await open(k2, sealed, "aad")).toEqual([1, 2, 3]);
  });

  it("fails with a different wallet's key", async () => {
    const a = await walletKey();
    const b = await walletKey();
    const sealed = await seal(a.key, { secret: 1 }, vaultAad(a.acct.address));
    await expect(open(b.key, sealed, vaultAad(a.acct.address))).rejects.toBeInstanceOf(DecryptionError);
  });

  it("fails if associated data (wallet binding) differs", async () => {
    const a = await walletKey();
    const sealed = await seal(a.key, { secret: 1 }, vaultAad(a.acct.address));
    await expect(open(a.key, sealed, vaultAad("0x2222222222222222222222222222222222222222"))).rejects.toBeInstanceOf(DecryptionError);
  });

  it("fails if ciphertext is tampered", async () => {
    const a = await walletKey();
    const sealed = await seal(a.key, { secret: 1 }, "aad");
    const bytes = Buffer.from(sealed.ct, "base64");
    bytes[0] ^= 1;
    await expect(open(a.key, { ...sealed, ct: bytes.toString("base64") }, "aad")).rejects.toBeInstanceOf(DecryptionError);
  });

  it("uses a fresh IV per encryption", async () => {
    const a = await walletKey();
    const s1 = await seal(a.key, { x: 1 }, "aad");
    const s2 = await seal(a.key, { x: 1 }, "aad");
    expect(s1.iv).not.toBe(s2.iv);
    expect(s1.ct).not.toBe(s2.ct);
  });
});

describe("vault storage", () => {
  it("stores only ciphertext and loads it back", async () => {
    const { acct, key } = await walletKey();
    const store = new MemoryStore();
    const req = sampleRequest();
    const vault = { ...emptyVault(acct.address), requests: [req] };
    await saveVault(store, key, vault);
    expect(hasVault(store, acct.address)).toBe(true);
    const raw = store.getItem(vaultStorageKey(acct.address))!;
    expect(raw).not.toContain(req.keys.spendingPrivateKey.slice(2));
    expect(raw).not.toContain(req.keys.viewingPrivateKey.slice(2));
    expect(raw).not.toContain(req.id.slice(2));
    const loaded = await loadVault(store, key, acct.address);
    expect(loaded.requests[0].keys).toEqual(req.keys);
  });

  it("returns an empty vault when none exists", async () => {
    const { acct, key } = await walletKey();
    expect((await loadVault(new MemoryStore(), key, acct.address)).requests).toEqual([]);
  });
});
