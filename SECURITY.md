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
| Per-link spending + viewing private keys | Derived from the wallet signature, chain ID and link number (HKDF-SHA256); cached in the vault | Re-derivable on any device; cache encrypted with AES-256-GCM |
| Vault encryption key | Memory, non-extractable `CryptoKey`; in IndexedDB (still non-extractable) only if the user chooses to stay signed in | Gone on reload or wallet change; if kept, after 30 days, or on sign out, disconnect or another wallet connecting |
| Wallet signature used for the vault key | Never stored | Not applicable |
| Stealth private key (per payment) | Derived in memory at claim time | Used to sign locally, then discarded |
| Payer record (stealth address, ephemeral **public** key, tx hashes) | Payer's `localStorage`, plaintext | Not secret; lets announcements be retried |

- The signed message is domain-separated (`QuietPay vault key`, purpose
  `quietpay/vault-encryption`, version, checksummed wallet address) and states that it is not a
  transaction. The HKDF salt and info bind the key to QuietPay and to the wallet address.
- Ciphertexts bind associated data (purpose and wallet address), so a vault cannot be swapped
  between wallets or contexts without failing authentication.
- The first time a vault is created, the wallet is asked to sign twice and the signatures must be
  identical. Wallets with non-deterministic signatures are refused rather than producing keys that
  could never be recreated.
- Every QuietPay key (link keys, pool keys, name key, vault key) is derived from that one signature
  with its own HKDF salt and label. The signature therefore acts like a password: anyone who gets
  it can recreate the keys. There are no backup files.
- The message is a fixed Sign-In with Ethereum (EIP-4361) message bound to `quietpay.sbs` (fixed
  nonce and issue time, so the signature never changes). Wallets that check SIWE domains warn when
  any other site asks for it, which is the main defence against phishing for the signature. The
  old vercel.app address redirects to quietpay.sbs so users never sign there.
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
  wallet. A malicious site can't get that signature without the user signing the same message,
  and wallets that check sign-in domains warn when another site asks for it. Phishing for this
  signature (in a wallet that doesn't check) is the main residual risk.
- Malware or a malicious browser extension running in the page can read keys while the vault is
  unlocked. QuietPay cannot defend against a compromised browser.

### Key loss
- Link keys are derived from the wallet signature, the chain ID and a link number, so nothing needs
  backing up, and the same link number on two chains has unrelated keys.
  On a new device (or after clearing site data) the Receive page scans announcements from the
  announcer's deployment and checks link numbers in order until 20 in a row have no payments, then
  rebuilds those links and their payments. Unpaid links can't be found this way, but hold no funds.
- Recovered links lose what only lived in the link itself (amount, expiry, shareable code); their
  payments and funds are fully recovered. Fixed links are recognised by their request ID.
- The first time a device creates a link, it checks the chain first so the new link gets an unused
  number. Two devices creating links offline at the same moment can still pick the same number;
  the links then share keys. Funds stay recoverable, and fixed links only show payments carrying
  their own request ID.
- Losing the wallet (or its recovery phrase) loses access to QuietPay funds.

### XSS
- React escapes all rendered values. The only `dangerouslySetInnerHTML` is the fixed theme script in
  the root layout (a constant, no user data); QR codes are rendered as React SVG elements.
- Content Security Policy, built per request in `src/proxy.ts` (`src/lib/csp.ts`):
  `script-src 'nonce-…' 'strict-dynamic'` with a fresh nonce on every page, no `'unsafe-inline'`
  for scripts and `script-src-attr 'none'`, so injected scripts and inline handlers don't run.
  `'wasm-unsafe-eval'` is allowed for the proof generator's WebAssembly (it does not allow
  `eval`). Inline styles stay allowed. API routes get `default-src 'none'`. Also `default-src
  'self'`, `connect-src` limited to the configured RPC
  origins, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`,
  plus `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`, and a restrictive
  `Permissions-Policy`. Every page is rendered per request so it can carry its nonce.
- Dependencies are pinned by `package-lock.json`. No third-party scripts are loaded at runtime.

### RPC privacy
- Viewing keys never leave the browser. Scanning requests all scheme-1 announcements from the
  announcer for a block range and matches them locally.
- The RPC provider can still see the user's IP address, which block ranges are scanned (which hints
  at when links were created), which addresses' balances are queried during a claim, and every
  transaction submitted. Use a trusted or self-hosted RPC (`NEXT_PUBLIC_*_RPC_URL`), or a VPN/Tor,
  if that matters.

### WalletConnect
- Optional. Enabled only when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set; otherwise the CSP
  allows no WalletConnect hosts at all.
- Messages between the site and the mobile wallet are end-to-end encrypted, but they pass through
  Reown's relay, which can see IP addresses, connection timing and session topics. Users who mind
  that can use a browser extension or a wallet's in-app browser instead.
- `@walletconnect/ethereum-provider` is pinned to 2.21.1, the last Apache-2.0 release, as wagmi
  recommends. It pulls in `pino@7`. The advisory against pino 7 concerns its server-side redaction
  dependency; QuietPay only ever loads pino's browser build (WalletConnect runs client-side only),
  which does not include it. Newer pino browser builds are incompatible with WalletConnect's logger.

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

### QuietPay router
- `QuietPayRouter` has no owner, no storage of funds and no upgrade path. It pulls exactly the
  approved amount from the payer to the one-time address, forwards any ETH sent with the call
  (capped at 0.001 ETH) to the same address, and calls the announcer, all in one transaction.
- The app verifies the router's runtime bytecode hash before using it, and only ever passes its
  allowlisted token and verified announcer. Approvals are for the exact payment amount, so no
  lingering allowance remains after a payment.
- If no router is configured the app falls back to the two-transaction flow below.

### Reusable (any-amount) links
- Payments to the same link each go to a fresh one-time address, and their announcements carry no
  request ID, so onchain observers cannot group them. Anyone who holds the link knows payments made
  through it go to the same person.
- One-time enforcement applies only to fixed-amount links.
- Odd amounts are easier to correlate later than round ones; the pay page says so.

### Gas top-up linking
- With the router, the payer includes the gas, so the recipient never needs to fund the one-time
  address. Without it, a stealth address starts with no ETH and can't pay gas to move tokens.
  QuietPay never funds it automatically. The recipient must choose to top it up, and the UI warns that funding it from a
  known wallet publicly links that wallet to the payment. Sending from an unrelated wallet avoids
  this. Claiming to the connected wallet also links them; the UI suggests a fresh address.
- Leftover ETH dust stays at the stealth address after a sweep.

### Shielded pool
- Contracts and circuits are 0xbow's audited Privacy Pools, unchanged; QuietPay's own code around
  them (key derivation, note reconstruction, verification, relayer) is not audited.
- Before use, the browser checks every pool contract against the compiled build (immutables and
  library addresses masked by the compiler's offsets), the contracts' wiring, and every circuit file
  against the ceremony's SHA-256 digests. A mismatch blocks the pool.
- The relayer only accepts withdrawals that name its own fee address and fee, simulates them, then
  submits. The proof binds recipient, fee address and fee, so it cannot redirect funds. It sees IP
  addresses and can refuse service; it stores nothing.
- The approver publishes roots by a public rule encoded onchain, so clients verify the approval set
  themselves. On testnet it approves everything immediately. Real screening is a mainnet blocker.
- The entrypoint is upgradeable and owned by the deployer. The owner cannot take pool funds, and
  `ragequit` works without the owner, approver or relayer, but the owner could block private
  withdrawals. The relayer key is separate from the owner key and is the only key on the web host.
- The pool hides which deposit a withdrawal came from. It does not hide deposits, withdrawals,
  amounts or timing, and gives little privacy while few people use it.
- Details: [docs/shielded-pool.md](./docs/shielded-pool.md).

### Other
- `Number`-free amounts: all token math uses `bigint`, with strict decimal parsing (no exponents,
  separators or silent rounding).
- Transactions are never auto-submitted on page load. The payer confirms once for the two-step
  payment (and the wallet prompts for each transaction); claims and gas top-ups each need an explicit
  confirmation in the UI and then the wallet.
- Mainnet is disabled unless `NEXT_PUBLIC_ENABLE_MAINNET=true`; links for disabled networks are
  rejected.
