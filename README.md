# QuietPay

**A fresh address for every payment.** One-time USDG payment links on Robinhood Chain using
[ERC-5564](https://eips.ethereum.org/EIPS/eip-5564) stealth addresses.

> QuietPay gives each payment a fresh receiving address. Robinhood Chain is public: the payer,
> amount, destination address, and transaction time can be visible. This is not full anonymity.

QuietPay provides **recipient address unlinkability**: a payer, or anyone watching the chain, can't
tie a payment to the recipient's regular wallet. It does not hide the payer, the amount or timing.

**Status: testnet MVP.** Mainnet is disabled by default. See [Mainnet blockers](#mainnet-blockers).

## How it works

QuietPay has two kinds of link:

- **Fixed amount**: an invoice. Paid once, expires after 1 hour, 24 hours or 7 days.
- **Any amount**: a reusable link. The payer chooses the amount and can pay many times. Never expires
  by default (or after 7 or 30 days).

1. **Create** (recipient). Connect a wallet and sign a message that unlocks an encrypted key vault in
   the browser. Enter an amount and expiry. QuietPay generates a brand-new spending/viewing key pair
   for this request only and produces a link holding the public stealth meta-address. The recipient's
   wallet address is never requested or put in the link.
2. **Pay** (payer). The link is validated before any wallet connects (version, checksum, chain,
   allowlisted token, expiry, curve points). The payer's browser derives a one-time stealth address,
   runs onchain checks, then (after explicit confirmation) sends two transactions: the USDG
   `transfer` to the stealth address, then an ERC-5564 `announce`. If the announcement fails, only
   the announcement can be retried; the payment is never resent.
3. **Receive** (recipient). The browser downloads public `Announcement` events and matches them
   locally with each request's viewing key. Matches are confirmed against real token `Transfer`
   logs. To claim, the stealth private key is derived locally and signs a sweep to any address.
   If the stealth address has no ETH for gas, the recipient can top it up manually; QuietPay never
   funds addresses automatically.

### Payment link format (v2)

`https://<host>/pay#<code>`. The code is base64url of 133 bytes (v1 links, 132 bytes without the
flags byte, are still accepted):

| Bytes | Field |
| --- | --- |
| 1 | version (`2`) |
| 1 | flags (bit 0: any amount) |
| 4 | chain ID |
| 20 | token address (must equal the allowlisted token for that chain) |
| 16 | amount, token base units (uint128; 0 for any-amount links) |
| 5 | expiry, unix seconds (0 = never, any-amount links only) |
| 16 | random request ID |
| 66 | stealth meta-address (compressed spending key ‖ compressed viewing key) |
| 4 | checksum: first 4 bytes of keccak256 of the above |

It lives in the URL fragment, so it is never sent to the web server. It never contains private keys.

### One-transaction payments (QuietPay router)

When `NEXT_PUBLIC_TESTNET_ROUTER_ADDRESS` points at a deployed, bytecode-verified `QuietPayRouter`,
the payer approves exactly the amount, then one transaction:

1. moves the tokens to the one-time address,
2. sends a small ETH gas allowance with it (capped at 0.001 ETH), so the recipient can move the funds
   without topping the address up from a wallet linked to them,
3. posts the ERC-5564 announcement.

They succeed or fail together. Without a router, QuietPay falls back to the two-transaction flow
(payment, then a separately retryable announcement) and the recipient must add gas manually.

### Moving funds

From the Receive page you can send all or part of a payment to any address. QuietPay never
suggests your connected wallet: sending there publicly links the payment to it. Use a fresh account
or pay someone directly from the payment.

### Shielded pool (testnet)

Moving a payment to a fresh address still leaves a public trail from the one-time address. The
shielded pool breaks it: *Move funds → Shielded pool* deposits the payment into
[Privacy Pools by 0xbow](https://github.com/0xbow-io/privacy-pools-core) (audited contracts and
circuits, used unchanged), and the Pool page withdraws any amount to any fresh address through a
relayer, with the zero-knowledge proof generated in the browser. Deposits must be approved before
they can be withdrawn privately; on testnet the approver approves every deposit as soon as it
lands, and on mainnet it first checks the deposit and its payer against the OFAC sanctions list.
Any deposit can exit back to its one-time address without approval.

Full design, trust assumptions and mainnet blockers: [docs/shielded-pool.md](./docs/shielded-pool.md).

### Announcement metadata

Bytes 0 to 56 follow ERC-5564's recommendation (view tag, `transfer` selector, token, amount), built
with the ScopeLift SDK. For fixed links QuietPay appends `0x515001` and the 16-byte request ID so
anyone holding the link can see whether it was already paid (one-time enforcement) without learning
the recipient. Any-amount links omit it, so payments to the same reusable link can't be grouped.

## Tech

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · wagmi + viem ·
`@scopelift/stealth-address-sdk` (crypto utilities only; Robinhood Chain isn't in its chain config) ·
Zod · Vitest · solc 0.8.23 (solc-js) · anvil (local EVM for end-to-end tests).
No database, no backend, no analytics.

## Run locally

Requires Node 20+.

```bash
npm ci
cp .env.example .env.local      # then fill in the addresses below
npm run dev                     # http://localhost:3000
```

Use `http://localhost:3000` (not `127.0.0.1`): Next.js blocks dev assets for unlisted origins.

### Fully local chain (no testnet needed)

```bash
# 1. Local EVM with the testnet chain ID
node node_modules/@foundry-rs/anvil/bin.mjs --chain-id 46630

# 2. Deploy the announcer and mock token (anvil dev key #0)
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
RPC_URL=http://127.0.0.1:8545 npm run contracts:deploy

# 3. Put the printed addresses in .env.local with
#    NEXT_PUBLIC_TESTNET_RPC_URL=http://127.0.0.1:8545, then
npm run dev
```

Import anvil dev accounts into your wallet and add a custom network (RPC `http://127.0.0.1:8545`,
chain ID 46630). The Pay page has a "Get test tUSDG" button when the payer's balance is short.

## Testnet deployment

Robinhood Chain Testnet: chain ID **46630**, RPC `https://rpc.testnet.chain.robinhood.com`,
explorer `https://explorer.testnet.chain.robinhood.com`, ETH faucet
`https://faucet.testnet.chain.robinhood.com`.

1. Create a throwaway deployer key and fund it with testnet ETH from the faucet.
2. Deploy both contracts:
   ```bash
   DEPLOYER_PRIVATE_KEY=0x<throwaway key> npm run contracts:deploy
   ```
   Add `DEPLOY=router` (or `announcer,token,router`) to choose what to deploy. The GitHub workflow
   "Deploy testnet contracts" does the same from the Actions tab. The script refuses any chain other
   than 46630, deploys the exact bytecode committed in
   `contracts/artifacts/`, checks the deployed runtime code hash and prints:
   ```
   NEXT_PUBLIC_TESTNET_ANNOUNCER_ADDRESS=0x…
   NEXT_PUBLIC_TESTNET_TOKEN_ADDRESS=0x…
   ```
3. Set those in `.env.local` and in your host's environment (e.g. Vercel/Netlify), then build.
4. Verify the configuration exactly as the app does:
   ```bash
   npm run contracts:verify
   ```
5. Optional but recommended: verify source on the explorer (contract page → *Verify & Publish* →
   *Solidity (Standard JSON input)*, compiler `v0.8.23`, using the `standardJsonInput` object from
   `contracts/artifacts/<Contract>.json`).

Deploy the web app anywhere that serves Next.js (`npm run build && npm start`, Vercel, Netlify).
Security headers are set in `next.config.ts`; the per-request Content Security Policy with its
script nonce is set in `src/proxy.ts`.

### Wallets

Browser extensions (MetaMask, Rabby, Coinbase Wallet…) are detected automatically via EIP-6963.
For phones and other wallets, set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (free from
[dashboard.reown.com](https://dashboard.reown.com), with your site's domain added to its
allowlist) to enable WalletConnect. Without it, phone users can still open the site inside their
wallet app's browser.

### Contract addresses and configuration

The deployed testnet addresses are committed in `.env.production`, so a production build needs no extra configuration. Host environment variables override them.

| Item | Testnet (46630) | Mainnet (4663) |
| --- | --- | --- |
| Payment token | `QuietPayTestUSDG` (**mock**, `tUSDG`, 6 decimals) at `0x271c29c9d99e0dd4ae250c7dd302052355cb3db9` | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (hard-coded; symbol and decimals verified onchain at runtime) |
| ERC-5564 announcer | `0x6ec677c1195ac4951afcaead14debad6f74be577` | Not deployed; set `NEXT_PUBLIC_MAINNET_ANNOUNCER_ADDRESS` after deployment |
| QuietPay router | Deploy with `DEPLOY=router`; set `NEXT_PUBLIC_TESTNET_ROUTER_ADDRESS` | Not deployed |
| ERC-6538 registry | Not used | Not used |

Why no defaults:

- **No testnet USDG.** No verified testnet USDG contract address could be found, so QuietPay does not
  invent one. Testnet uses `QuietPayTestUSDG`, which says "MOCK" in its name and is labelled in the UI.
- **No ERC-5564 announcer on Robinhood Chain.** ScopeLift's canonical deployments
  (`0x55649E01B5Df198D18D95b5cc5051630cfD45564`) list Ethereum, Arbitrum, Base, Optimism, Polygon,
  Gnosis and Scroll, not Robinhood Chain. QuietPay does not reuse that address. It ships the CC0
  ScopeLift `ERC5564Announcer` source and verifies any configured announcer's runtime bytecode hash
  against its own build (`KNOWN_ANNOUNCER_CODE_HASHES` in `src/config/contracts.ts`).
- The build sandbox for this MVP could not reach Robinhood Chain RPCs, so none of the above was
  confirmed onchain during development. The app and `npm run contracts:verify` check everything at
  runtime and refuse to run against anything that doesn't verify.

### Mainnet announcer deployment (when ready)

```bash
ALLOW_MAINNET_ANNOUNCER=true DEPLOY=announcer \
RPC_URL=https://rpc.mainnet.chain.robinhood.com \
DEPLOYER_PRIVATE_KEY=0x… npm run contracts:deploy
```

The script will never deploy the mock token to mainnet. Enabling mainnet in the UI additionally
requires `NEXT_PUBLIC_ENABLE_MAINNET=true` and should wait for the blockers below.

## Tests

```bash
npm test          # unit + end-to-end (anvil) tests
npm run test:unit # unit tests only (fast)
npm run lint      # TypeScript type check
npm run build     # production build
```

GitHub Actions runs the type check and the full suite on every push (`.github/workflows/ci.yml`).
Vercel builds with `npm run vercel-build`, which runs the type check and the unit tests first, so a
failing build is never deployed.

The suite (126 tests) covers amount parsing and limits, link encoding/validation/tampering, AES-GCM
vault encryption, wallet-derived link keys and recovery on a new device, stealth derivation and matching, metadata,
network gating and bytecode fingerprints, the payment state machine, and transaction-error
classification. `tests/e2e-anvil.test.ts` runs the full flow on a real local EVM: deploy, create,
validate, preflight, pay, announce, duplicate-payment blocking, scan, match, gas top-up, sweep.
`tests/e2e-router.test.ts` covers router payments and reusable links. `tests/e2e-pool.test.ts`
deploys the real pool contracts, deposits from a one-time address, publishes an approval root,
generates a real Groth16 proof with the ceremony keys, relays a withdrawal to an empty address,
withdraws the change note, rejects tampered and replayed proofs, and exits a deposit.

## Project layout

```
src/config/      networks, token/announcer config, ABIs, bytecode fingerprints
src/lib/         amount, link, stealth, metadata, vault + crypto, chain, payer, receive, state machine
src/lib/pool/    shielded pool: keys, notes, proving, verification, relayer
src/app/         Home, /create, /pay, /receive, /pool, /api/relay, /api/pool/approvals
src/components/  wallet + vault gates, UI primitives, logo, skyline hero
contracts/       ERC5564Announcer (CC0, ScopeLift), QuietPayTestUSDG (mock), QuietPayRouter + artifacts
contracts/vendor Privacy Pools contracts (Apache-2.0, unchanged) and their library imports
public/pool-artifacts  circuit files from the Privacy Pools trusted-setup ceremony
scripts/         compile, deploy (testnet), verify
tests/           Vitest unit and anvil end-to-end tests
```

## Mainnet blockers

Mainnet must stay disabled until all of these are done:

1. **Announcer deployment.** Deploy `ERC5564Announcer` on mainnet, verify source on Blockscout, and
   run `npm run contracts:verify` with mainnet enabled.
2. **USDG verification.** Confirm onchain that `0x5fc5…d168` is Paxos USDG (symbol, decimals, proxy
   implementation, issuer) and decide how to handle future proxy upgrades or freezes.
3. **Real testnet validation.** Run the full flow on Robinhood Chain Testnet with real wallets
   (MetaMask, Rabby, hardware wallets) including replacement, timeout and reorg paths.
4. **Independent security review** of key handling, the vault, link parsing and the sweep logic.
5. **Key recovery.** All keys are derived from one wallet signature, so recovery needs only the wallet,
   but that signature must be protected like a password, and recovery scans full chain history.
6. **Scanning at scale.** Client-side `eth_getLogs` scanning has not been load-tested against public
   RPC range limits over long periods. An indexer that never sees viewing keys may be needed.
7. **Gas top-up privacy.** Funding a stealth address from a known wallet links them. A safer
   gas-sponsorship design (e.g. ERC-4337 paymaster) is not implemented.
8. **CSP.** Done: nonce-based scripts, no `'unsafe-inline'` for scripts (`src/proxy.ts`).
9. **Dependency upgrades.** `npm audit` reports advisories in wagmi 2 / WalletConnect / viem / zod 3
   transitive dependencies whose fixes need major upgrades (wagmi 3, zod 4). Review and upgrade
   before mainnet.

10. **Shielded pool.** Testnet only. See the blockers in [docs/shielded-pool.md](./docs/shielded-pool.md).

See [SECURITY.md](./SECURITY.md) for the threat model.

## Licence

Application code: MIT. `contracts/src/ERC5564Announcer.sol`: CC0-1.0 (ScopeLift).
`contracts/vendor/privacy-pools`: Apache-2.0 (0xbow); its generated verifiers and the browser prover
(snarkjs) are GPL-3.0. See [contracts/vendor/NOTICE.md](./contracts/vendor/NOTICE.md).
