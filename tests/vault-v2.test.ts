import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildVaultMessage, DecryptionError, deriveVaultKey, seal, newDataKey } from "@/lib/vault-crypto";
import {
  emptyVault,
  KeyChangedError,
  MAX_DATA_KEY_AGE_MS,
  openVault,
  readBlob,
  rekeyVault,
  saveVault,
  shouldRotate,
  vaultStorageKey,
  vaultV1BackupKey,
  writeVault,
  type VaultData,
} from "@/lib/vault";
import { MemoryStore } from "./helpers";

async function wallet() {
  const acct = privateKeyToAccount(generatePrivateKey());
  const sig = await acct.signMessage({ message: buildVaultMessage(acct.address) });
  return { acct, kek: await deriveVaultKey(sig, acct.address) };
}
const sample = (address: `0x${string}`): VaultData => ({ ...emptyVault(address), nextLinkIndex: 4, linksCheckedAt: 123 });

describe("vault format v2", () => {
  it("encrypts with a random data key that only the signature key can unwrap", async () => {
    const { acct, kek } = await wallet();
    const store = new MemoryStore();
    const keys = await rekeyVault(store, kek, sample(acct.address));
    expect(readBlob(store, acct.address)?.v).toBe(2);
    // The data key is usable but can't be read out.
    await expect(crypto.subtle.exportKey("raw", keys.dek)).rejects.toThrow();
    const bySig = await openVault(store, acct.address, { kek });
    expect(bySig.data.nextLinkIndex).toBe(4);
    expect(bySig.keys?.kid).toBe(keys.kid);
    const byDek = await openVault(store, acct.address, { dek: { key: keys.dek, kid: keys.kid } });
    expect(byDek.data).toEqual(bySig.data);
    // The stored blob never contains the plaintext.
    expect(store.getItem(vaultStorageKey(acct.address))).not.toContain("linksCheckedAt");
  });

  it("rejects a wrong key or any altered byte, and never returns partial data", async () => {
    const { acct, kek } = await wallet();
    const other = await wallet();
    const store = new MemoryStore();
    await rekeyVault(store, kek, sample(acct.address));
    await expect(openVault(store, acct.address, { kek: other.kek })).rejects.toBeInstanceOf(DecryptionError);
    const raw = JSON.parse(store.getItem(vaultStorageKey(acct.address))!);
    const flip = (b64: string) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      bytes[bytes.length - 1] ^= 1;
      return btoa(String.fromCharCode(...bytes));
    };
    for (const mutate of [
      (r: typeof raw) => ({ ...r, ct: flip(r.ct) }),
      (r: typeof raw) => ({ ...r, iv: flip(r.iv) }),
      (r: typeof raw) => ({ ...r, key: { ...r.key, ct: flip(r.key.ct) } }),
      (r: typeof raw) => ({ ...r, kid: "0000000000000000" }),
    ]) {
      const s2 = new MemoryStore();
      s2.setItem(vaultStorageKey(acct.address), JSON.stringify(mutate(raw)));
      await expect(openVault(s2, acct.address, { kek })).rejects.toBeInstanceOf(DecryptionError);
    }
    // A vault copied to another wallet's slot doesn't open for that wallet.
    const s3 = new MemoryStore();
    s3.setItem(vaultStorageKey(other.acct.address), JSON.stringify(raw));
    await expect(openVault(s3, other.acct.address, { kek: other.kek })).rejects.toBeInstanceOf(DecryptionError);
    // Garbage isn't mistaken for a vault.
    const s4 = new MemoryStore();
    s4.setItem(vaultStorageKey(acct.address), "{not json");
    await expect(openVault(s4, acct.address, { kek })).rejects.toBeInstanceOf(DecryptionError);
  });

  it("upgrades a v1 vault and keeps its original ciphertext as a backup", async () => {
    const { acct, kek } = await wallet();
    const store = new MemoryStore();
    await saveVault(store, kek, sample(acct.address));
    const original = store.getItem(vaultStorageKey(acct.address));
    const v1 = await openVault(store, acct.address, { kek });
    expect(v1.version).toBe(1);
    expect(v1.keys).toBeNull();
    // A kept data key can't open a v1 vault; only the signature can.
    const stray = await newDataKey(kek, acct.address);
    await expect(openVault(store, acct.address, { dek: { key: stray.dek, kid: stray.kid } })).rejects.toBeInstanceOf(DecryptionError);
    const keys = await rekeyVault(store, kek, v1.data);
    expect(store.getItem(vaultV1BackupKey(acct.address))).toBe(original);
    const v2 = await openVault(store, acct.address, { dek: { key: keys.dek, kid: keys.kid } });
    expect(v2.version).toBe(2);
    expect(v2.data).toEqual(v1.data);
  });

  it("rotates the data key; an old kept key then stops working and saving with it is refused", async () => {
    const { acct, kek } = await wallet();
    const store = new MemoryStore();
    const first = await rekeyVault(store, kek, sample(acct.address));
    const { data } = await openVault(store, acct.address, { kek });
    const second = await rekeyVault(store, kek, data);
    expect(second.kid).not.toBe(first.kid);
    await expect(openVault(store, acct.address, { dek: { key: first.dek, kid: first.kid } })).rejects.toBeInstanceOf(KeyChangedError);
    expect((await openVault(store, acct.address, { kek })).data).toEqual(data);
    // Rotation happens when a key was kept on a device or is old.
    const now = Date.now();
    expect(shouldRotate({ ...second, created: now, remembered: false }, now)).toBe(false);
    expect(shouldRotate({ ...second, created: now, remembered: true }, now)).toBe(true);
    expect(shouldRotate({ ...second, created: now - MAX_DATA_KEY_AGE_MS - 1, remembered: false }, now)).toBe(true);
  });

  it("uses a fresh nonce for every save", async () => {
    const { acct, kek } = await wallet();
    const store = new MemoryStore();
    const keys = await rekeyVault(store, kek, sample(acct.address));
    const ivs = new Set<string>();
    for (let i = 0; i < 500; i++) {
      await writeVault(store, keys, sample(acct.address));
      ivs.add(JSON.parse(store.getItem(vaultStorageKey(acct.address))!).iv);
    }
    expect(ivs.size).toBe(500);
    const sealed = await Promise.all(Array.from({ length: 200 }, () => seal(keys.dek, {}, "x")));
    expect(new Set(sealed.map((x) => x.iv)).size).toBe(200);
  });
});
