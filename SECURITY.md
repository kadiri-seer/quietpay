# QuietPay security model

## Reporting a vulnerability

Please report security issues privately, not in a public issue: use **Report a vulnerability** on
this repository's Security tab (GitHub private vulnerability reporting), or send a direct message to
[@quietpay_](https://x.com/quietpay_) on X. Include steps to reproduce. QuietPay is on testnet only;
test tokens have no value, so please never test against other people's funds.

QuietPay is an experimental testnet MVP. Its own code has not been independently audited yet; the
shielded pool uses 0xbow's audited Privacy Pools contracts and circuits, unchanged.

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
- Every key depends on the wallet signing the same message the same way each time. Ordinary
  wallets do (RFC 6979). The first time, a wallet signs once if QuietPay recognises it as an
  ordinary wallet (by its EIP-6963 id or WalletConnect name), the signature has the plain 65-byte
  shape and the address has no contract code (EIP-7702 delegation allowed). Anything else signs a
  second time, after a tap so mobile wallets open properly, and must give the identical signature;
  wallets that don't are refused rather than producing keys that could never be recreated
  (`src/lib/wallet-kind.ts`).
- If a later signature can't open the vault saved in the browser, the wallet signs once more. Same
  signature: the vault came from an older QuietPay message and is recreated. Different signature:
  the wallet signs inconsistently; QuietPay stops and leaves the saved vault untouched.
- Every QuietPay key (link keys, pool keys, name key, vault key) is derived from that one signature
  with its own HKDF salt and label. The signature therefore acts like a password: anyone who gets
  it can recreate the keys. There are no backup files.
- The message is a fixed Sign-In with Ethereum (EIP-4361) message bound to `www.quietpay.sbs`, the
  site's primary domain (fixed
  nonce and issue time, so the signature never changes). Wallets that check SIWE domains warn when
  any other site asks for it, which is the main defence against phishing for the signature. The
  apex domain and the old vercel.app address redirect there, so users never sign on another host.
  The primary domain must stay `www.quietpay.sbs`; changing it changes every user's keys.
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
  blocks payment if one exists *and* its one-time address received at least the link's amount of
  the token. Anyone holding a link can post an announcement with its ID, so an announcement alone
  doesn't block the link. Two payers racing can still both pay; the recipient sees and can claim
  both.
- Interrupted payments: if the page closes after the derivation is saved but before the wallet
  returns a transaction hash (common on phones), the next visit looks onchain for a transfer from
  the payer to that one-time address before offering a new payment, and warns if it can't tell.

### QuietPay router
- The app pays one-time addresses only through `QuietPayRouterV3` (or `QuietPayRouterV2`). Both have
  no owner, hold no funds and can't be upgraded; their token and announcer are fixed at deployment,
  the announcement must describe the transfer that happened, and a one-time link's request ID can
  be paid once. V3 also refuses destinations tokens could never leave (zero address, the router,
  the token, the announcer); the app refuses them for V2 and direct payments too.
- `QuietPayRouter` (v1) is retired: it let the caller pick the token and announcer and didn't tie
  the announcement to the transfer. Its code hash is kept only so a v1 address is recognised and
  refused with a clear error; there is no fallback to it.
- The app verifies the router's runtime bytecode hash before using it. If no router is configured
  the app falls back to the two-transaction flow below.

### One-time payment requests (pool router v2)
- New one-time requests are signed by a key made for that request alone (derived from the wallet,
  so recoverable). It signs the terms (amount, expiry, request ID, token, router, chain) and the
  lock the money goes into. `QuietPayPoolRouterV2.payRequest` marks a request paid only when
  exactly its amount goes into a lock signed by the same key, in the same transaction. An
  underpaid, overpaid, wrong-token or redirected payment reverts, and a reverted attempt records
  nothing, so it can't use the request up.
- The pool accepts any deposit under any precommitment, so someone holding a link can still burn
  its lock by depositing straight into it (the money lands with the recipient). That never marks
  the request paid: the payer then takes one of the request's spare locks (signed the same way,
  kept by QuietPay's lock store) and pays in full. The request's paid state is read from the
  router, not from whether the lock was used.
- Requests made before this, and links paid through pool router v1, keep v1's behaviour (a lock
  used by any deposit reads as paid). One-time links without the pool (stealth addresses, used only
  where no pool exists) can be paid once through router v2/v3, but the router can't check that the
  one-time address belongs to the recipient; see "Remaining limits" below.

### Remaining limits
- A stealth one-time link (no pool) can be used up by someone holding the link who pays its full
  amount to an address of their own. Only possible for whoever has the link, and costs them the
  gas; the pool request above doesn't have this problem.

### Reusable (any-amount) links
- Payments to the same link each go to a fresh one-time address, and their announcements carry no
  request ID, so onchain observers cannot group them. Anyone who holds the link knows payments made
  through it go to the same person.
- One-time enforcement applies only to fixed-amount links.
- Odd amounts are easier to correlate later than round ones; the pay page says so.

### Gas top-up linking
- With the router, the payer includes the gas, so the recipient never needs to fund the one-time
  address. Without it, a stealth address starts with no ETH and can't pay gas to move tokens.
  QuietPay never funds it automatically. The recipient must choose to top it up, and the UI explains
  that funding it from a known wallet shows onchain that the wallet is connected to the payment, as
  does claiming to the connected wallet.
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
  themselves. On testnet it approves everything immediately. With screening on (default for
  mainnet, `POOL_SCREENING`), each new deposit is checked first: the depositing address and every
  address that sent it the token (for a QuietPay payment, the payer) against the OFAC sanctions
  list. Failed deposits are left out and published in an exclusion list that clients verify against
  the onchain root; they can still exit to their one-time address. If a check can't run, approval
  stops just before that deposit and retries; nothing is approved unchecked. This is list screening
  only: money that passed through other wallets first isn't traced (a risk-scoring provider is the
  next step).
- The entrypoint is upgradeable. Its owner role is meant to be held by `QuietPayPoolGuardian`
  (see below); until the handover it is the deployer. The owner cannot take pool funds, and
  `ragequit` works without the owner, approver or relayer, but the owner could block private
  withdrawals. The relayer key is separate from the owner key and is the only key on the web host.
- Approval roots are published on a fixed cadence (at most one per `POOL_ROOT_INTERVAL_SECONDS`,
  default 60, held back up to three intervals while a relay is being submitted), not per deposit.
  The pool only accepts its latest root, so an old root is never accepted; a proof made against a
  replaced root is refused by the relayer with "The approval list changed", and the app makes it
  again automatically, once.

### Pool administration (`QuietPayPoolGuardian`)
- Holds the Entrypoint's owner role. Changes to fees, roles, pools and Entrypoint upgrades are
  proposed onchain (`Proposed` event with the full call), wait `delay` (1 hour to 30 days; 1 day by
  default), can be cancelled meanwhile, expire 14 days after becoming ready, and can then be carried
  out by anyone. Only listed calls can be proposed.
- Hard ceilings: deposit (vetting) fee at most 1%, relay-fee ceiling at most 5%, whatever is proposed.
- Immediate controls: winding a pool down (stops new deposits; withdrawals and ragequits keep
  working) and collecting the Entrypoint's fees (never users' deposits, which the pool holds).
- The admin can be any address, including a multisig (Safe). Changing the admin or the delay goes
  through the same delay. The Security page shows the guardian, its delay, the current fees and any
  pending changes, read from the chain.
- Withdrawals: the proof binds the recipient, fee recipient and fee, and the relayer only submits
  it as is; the direct path (`withdraw` by the note owner) and `ragequit` don't involve the relayer.
- The pool hides which deposit a withdrawal came from. It does not hide deposits, withdrawals,
  amounts or timing, and gives little privacy while few people use it.
- Details: [docs/shielded-pool.md](./docs/shielded-pool.md).

### Local data consistency
- Every vault change goes through one `update` function that runs under a Web Lock shared by all
  QuietPay tabs and re-reads the stored vault before applying the change, so a long scan, another
  tab or a delivery can't overwrite newer data (lost deliveries, or a reused link number and with
  it reused keys). Tabs reload the vault when another tab saves it. Only one tab sends scheduled
  deliveries at a time.

### Relayer gas top-ups
- On testnet the withdrawal fee is paid in free test tokens, so the fee covering a top-up protects
  nothing on its own. Every top-up also needs: the relayer keeping `RELAYER_MIN_BALANCE_ETH`
  (default 0.02) afterwards; one top-up per receiving address per `RELAYER_DROP_COOLDOWN_SECONDS`
  (default a day); at most `RELAYER_DROPS_PER_CALLER_PER_DAY` (default 3) per caller; at most
  `RELAYER_DROPS_PER_DAY` (default 50) in total. Refusals, a low balance and repeated top-ups are
  recorded by the repeated-action monitor (`/api/monitor`).

### Server routes
- `/api/relay` and `/api/pool/approvals` are rate-limited per client (salted IP hash in expiring
  counters, Upstash Redis, with an in-memory fallback if Redis is unreachable). Request bodies are
  size-capped after reading, whatever the Content-Length header says.
- A withdrawal is claimed by its nullifier while it is being submitted, so the same proof sent many
  times at once costs the relayer one transaction, not one failed transaction per copy. Relayer
  and approver transactions are sent one at a time (shared lock) so they never collide on a nonce.

### Other
- `Number`-free amounts: all token math uses `bigint`, with strict decimal parsing (no exponents,
  separators or silent rounding).
- Transactions are never auto-submitted on page load. The payer confirms once for the two-step
  payment (and the wallet prompts for each transaction); claims and gas top-ups each need an explicit
  confirmation in the UI and then the wallet.
- Mainnet is disabled unless `NEXT_PUBLIC_ENABLE_MAINNET=true`; links for disabled networks are
  rejected.
