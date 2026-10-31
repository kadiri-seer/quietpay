# QuietPay security model

QuietPay is an experimental testnet MVP. It has not been audited. Report issues privately to the
repository owner before disclosing them publicly.

## What QuietPay protects, and what it doesn't

**Protects:** recipient address unlinkability. Each payment request has its own stealth keys, and
each payment lands at a one-time ERC-5564 stealth address. An observer can't link that address to
the recipient's main wallet or to the recipient's other payments, unless the recipient links them
(see gas top-ups and claims below).

**Does not protect:** the payer's address, the amount, the stealth address, or transaction times.
All are public on Robinhood Chain. QuietPay is not a mixer and does not provide anonymity. The UI
states this on every page and the payer must acknowledge it before paying.

## Keys and storage

| Secret | Where it lives | Protection |
| --- | --- | --- |
| Per-request spending + viewing private keys | Browser `localStorage`, inside the vault | AES-256-GCM, key from HKDF-SHA256 over a wallet signature |
| Vault encryption key | Memory only, non-extractable `CryptoKey` | Gone on reload or wallet change |
| Wallet signature used for the vault key | Never stored | — |
| Stealth private key (per payment) | Derived in memory at claim time | Used to sign locally, then discarded |
| Backup file | Downloaded by the user | AES-256-GCM, PBKDF2-SHA256 600,000 iterations, 12+ character passphrase |
| Payer record (stealth address, ephemeral **public** key, tx hashes) | Payer's `localStorage`, plaintext | Not secret; lets announcements be retried |

- The signed message is domain-separated (`QuietPay vault key`, purpose
  `quietpay/vault-encryption`, version, checksummed wallet address) and states that it is not a
  transaction. The HKDF salt and info bind the key to QuietPay and to the wallet address.
- Ciphertexts bind associated data (purpose and wallet address), so a vault cannot be swapped
  between wallets or contexts without failing authentication.
- The first time a vault is created, the wallet is asked to sign twice and the signatures must be
  identical. Wallets with non-deterministic signatures are refused rather than producing a vault
  that could never be reopened.
- No key material is ever placed in URLs, sent to a server, written to logs, or sent to analytics
  (there is no server and no analytics). Links contain public keys only.

## Threats

### Malicious or tampered links
- Links are decoded and validated before any wallet connects: version, length, 4-byte keccak
  checksum, enabled chain ID, token equal to the allowlisted token for that chain, positive amount
  within configured limits (checked against onchain decimals), expiry in the future and within
  7 days plus 5 minutes of clock skew, non-zero request ID, and both meta-address keys on the
  secp256k1 curve.
- Links cannot carry contract addresses (other than the allowlisted token), calldata, or callback
  URLs. QuietPay only ever calls `transfer` on the allowlisted token and `announce` on the
  bytecode-verified announcer.
- A link with a recipient key the attacker controls is indistinguishable from a real one: the payer
  must trust the source of the link, exactly as with any address. QuietPay shows the amount and
  network clearly and requires explicit confirmation.

### Fake tokens and contracts
- The token per network is fixed in configuration. At runtime QuietPay checks that bytecode exists,
  reads `decimals` and requires the expected `symbol` (`USDG` on mainnet, `tUSDG` on testnet).
- The announcer must match a known runtime code hash from QuietPay's own compiled artifact. An
  address with other code, or none, disables payments.
- The testnet token is an explicitly labelled mock with no value. No testnet USDG address is
  invented. The deploy script refuses to put the mock on mainnet.

### Compromised browser storage
- Anyone who reads `localStorage` gets ciphertext only. Decrypting needs a signature from the
  wallet. A malicious site can't get that signature without the user signing the same message, so
  the message tells users to sign it only on QuietPay. Phishing for this signature is the main
  residual risk.
- Malware or a malicious browser extension running in the page can read keys while the vault is
  unlocked. QuietPay cannot defend against a compromised browser.

### Key loss
- Keys exist only in this browser's storage and in backups the user makes. Clearing site data,
  private windows, or losing the device loses them, and with them any unclaimed funds. The UI warns
  on creation and on the Receive page, and offers encrypted export/restore.
- Restore merges into the current vault without dropping existing requests or claim records.

### XSS
- React escapes all rendered values. There is no `dangerouslySetInnerHTML`; QR codes are rendered
  as React SVG elements.
- Content Security Policy: `default-src 'self'`, `connect-src` limited to the configured RPC
  origins, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`,
  plus `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`, and a restrictive
  `Permissions-Policy`. `script-src` still allows `'unsafe-inline'` because Next.js bootstraps with
  inline scripts without a nonce setup; moving to nonces is a mainnet blocker.
- Dependencies are pinned by `package-lock.json`. No third-party scripts are loaded at runtime.

### RPC privacy
- Viewing keys never leave the browser. Scanning requests all scheme-1 announcements from the
  announcer for a block range and matches them locally.
- The RPC provider can still see the user's IP address, which block ranges are scanned (which hints
  at when links were created), which addresses' balances are queried during a claim, and every
  transaction submitted. Use a trusted or self-hosted RPC (`NEXT_PUBLIC_*_RPC_URL`), or a VPN/Tor,
  if that matters.

### Announcement spam
- Anyone can call `announce` with arbitrary data. Matching requires the view tag and the full
  ECDH-derived address to match the request's keys, so spam can't create false matches.
- A match is only shown as claimable after real token `Transfer` events into the stealth address are
  found, so an announcement without funds shows as "awaiting funds".
- Heavy spam increases scanning cost. Chunk size adapts on RPC range errors; an indexer may be needed
  at scale.

### Partial transaction failures
- Payment and announcement are separate transactions. The payer's stealth derivation is saved
  locally *before* the payment is sent, so the announcement can always be retried.
- A state machine (`src/lib/payment-state.ts`) makes it impossible to send a second payment once a
  payment transaction hash exists. Only a confirmed revert (no transfer happened) allows a retry.
- Payments are marked paid only after the receipt succeeds and contains a `Transfer` of exactly the
  requested amount from the payer to the stealth address.
- Timeouts leave the payment pending with a "Check again" action that re-reads the same hash.
- Fee bumps ("repriced") are followed; cancellations or replacements are treated as failures.
  After the required confirmations the receipt is re-fetched and, if its block hash changed (reorg),
  waited for again.
- One-time enforcement: before paying, QuietPay scans announcements for the link's request ID and
  blocks payment if one exists. Two payers racing can still both pay; the recipient sees and can
  claim both.

### Gas top-up linking
- A stealth address starts with no ETH, so it can't pay gas to move tokens. QuietPay never funds it
  automatically. The recipient must choose to top it up, and the UI warns that funding it from a
  known wallet publicly links that wallet to the payment. Sending from an unrelated wallet avoids
  this. Claiming to the connected wallet also links them; the UI suggests a fresh address.
- Leftover ETH dust stays at the stealth address after a sweep.

### Other
- `Number`-free amounts: all token math uses `bigint`, with strict decimal parsing (no exponents,
  separators or silent rounding).
- Transactions are never auto-submitted on page load. The payer confirms once for the two-step
  payment (and the wallet prompts for each transaction); claims and gas top-ups each need an explicit
  confirmation in the UI and then the wallet.
- Mainnet is disabled unless `NEXT_PUBLIC_ENABLE_MAINNET=true`; links for disabled networks are
  rejected.
