# QuietPay

**A fresh address for every payment.** One-time USDG payment links on Robinhood Chain using
[ERC-5564](https://eips.ethereum.org/EIPS/eip-5564) stealth addresses.

> QuietPay gives each payment a fresh receiving address. Robinhood Chain is public: the payer,
> amount, destination address, and transaction time can be visible. This is not full anonymity.

QuietPay provides **recipient address unlinkability**: a payer, or anyone watching the chain, can't
tie a payment to the recipient's regular wallet. It does not hide the payer, the amount or timing.

**Status: testnet MVP.** Mainnet is disabled by default. See [Mainnet blockers](#mainnet-blockers).

## How it works

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

### Payment link format (v1)

`https://<host>/pay#<code>`. The code is base64url of 132 bytes:

| Bytes | Field |
| --- | --- |
| 1 | version (`1`) |
| 4 | chain ID |
| 20 | token address (must equal the allowlisted token for that chain) |
| 16 | amount, token base units (uint128) |
| 5 | expiry, unix seconds |
| 16 | random request ID |
| 66 | stealth meta-address (compressed spending key ‖ compressed viewing key) |
| 4 | checksum: first 4 bytes of keccak256 of the above |

It lives in the URL fragment, so it is never sent to the web server. It never contains private keys.

### Announcement metadata

Bytes 0–56 follow ERC-5564's recommendation (view tag, `transfer` selector, token, amount), built
with the ScopeLift SDK. QuietPay appends `0x515001` and the 16-byte request ID so anyone holding the
link can see whether it was already paid (one-time enforcement) without learning the recipient.

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
   The script refuses any chain other than 46630, deploys the exact bytecode committed in
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
Security headers, including the Content Security Policy, are set in `next.config.ts`.

### Contract addresses and configuration

| Item | Testnet (46630) | Mainnet (4663) |
| --- | --- | --- |
| Payment token | `QuietPayTestUSDG` (**mock**, `tUSDG`, 6 decimals): you deploy it; set `NEXT_PUBLIC_TESTNET_TOKEN_ADDRESS` | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (hard-coded; symbol and decimals verified onchain at runtime) |
| ERC-5564 announcer | You deploy it; set `NEXT_PUBLIC_TESTNET_ANNOUNCER_ADDRESS` | Not deployed; set `NEXT_PUBLIC_MAINNET_ANNOUNCER_ADDRESS` after deployment |
| ERC-6538 registry | Not used in v1 | Not used in v1 |

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
npm run lint      # TypeScript type check
npm run build     # production build
```

The suite (78 tests) covers amount parsing and limits, link encoding/validation/tampering, AES-GCM
vault encryption, passphrase backups and recovery, stealth derivation and matching, metadata,
network gating and bytecode fingerprints, the payment state machine, and transaction-error
classification. `tests/e2e-anvil.test.ts` runs the full flow on a real local EVM: deploy, create,
validate, preflight, pay, announce, duplicate-payment blocking, scan, match, gas top-up, sweep.

## Project layout

```
src/config/      networks, token/announcer config, ABIs, bytecode fingerprints
src/lib/         amount, link, stealth, metadata, vault + crypto, chain, payer, receive, state machine
src/app/         Home, /create, /pay, /receive
src/components/  wallet + vault gates, UI primitives, logo, skyline hero
contracts/       ERC5564Announcer (CC0, ScopeLift) and QuietPayTestUSDG (mock) + compiled artifacts
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
5. **Key recovery UX.** Vault keys depend on the browser plus wallet signature; backups are manual.
   Losing both the browser data and the backup loses unclaimed funds.
6. **Scanning at scale.** Client-side `eth_getLogs` scanning has not been load-tested against public
   RPC range limits over long periods. An indexer that never sees viewing keys may be needed.
7. **Gas top-up privacy.** Funding a stealth address from a known wallet links them. A safer
   gas-sponsorship design (e.g. ERC-4337 paymaster) is not implemented.
8. **CSP hardening.** Move to nonce-based scripts to drop `'unsafe-inline'`.

See [SECURITY.md](./SECURITY.md) for the threat model.

## Licence

Application code: MIT. `contracts/src/ERC5564Announcer.sol`: CC0-1.0 (ScopeLift).
