# Shielded pool

Status: **testnet prototype**. Mainnet stays off until the blockers at the end of this document are
cleared.

## Why

Stealth addresses hide *who* a payment belongs to, but not where the money goes next. When the
recipient moves a payment into a wallet that is known to be theirs, the link is back. The shielded
pool breaks that second hop: payments go in from their one-time addresses, and come out later to
any fresh address without anything onchain saying which deposit they came from.

## What we use, and why not our own

QuietPay does not write its own mixer. It uses **Privacy Pools by 0xbow**, unchanged:

- Contracts and circuits are open source (Apache-2.0) and have been audited (Oxorio: circuits,
  contracts, entrypoint upgrade; Auditware: contracts).
- The Groth16 proving keys come from 0xbow's completed trusted-setup ceremony. QuietPay ships the
  exact files and refuses any file whose SHA-256 differs from the digests the official SDK pins.
- The design adds **association sets**: a withdrawal must prove its deposit is in an approved set.
  This is the main difference from unrestricted mixers, and the reason it is the right base for a
  product that wants to stay usable by ordinary people and stay out of sanctions trouble.
- It supports ERC-20 pools, any deposit amount and partial withdrawals (each withdrawal leaves a
  change note), so we don't need fixed denominations.

Everything that is QuietPay's own is glue: deployment, verification, key derivation, the UI, a
small relayer and the approver.

## How it fits QuietPay

```
payer ──(router: tokens + gas stipend + announcement)──▶ one-time address
one-time address ──approve + deposit──▶ Entrypoint ──▶ PrivacyPoolComplex (tUSDG)
                                    approver publishes approval root (public rule)
browser: Groth16 proof (state tree + approval tree + note secrets)
relayer ──relay(proof)──▶ Entrypoint ──▶ pool.withdraw ──▶ fresh address (+ small ETH drop)
```

1. **Pay.** Unchanged. When a pool is configured, the router's gas stipend is sized for the
   recipient to approve and deposit (`SHIELD_GAS_BUDGET`, 900k gas, still capped at 0.001 ETH).
2. **Shield.** On Receive, *Move funds → Shielded pool* deposits all or part of a payment from its
   one-time address. Two transactions, both signed locally with the one-time key and paid from the
   stipend. The connected wallet sends nothing. The deposit is public; it reveals the one-time
   address and amount, which were already public.
3. **Approval.** The approver publishes a new approval root as soon as a deposit lands (testnet
   default; configurable delay). The site triggers it after each shield and keeps checking while a
   deposit waits.
4. **Withdraw.** On the Pool page, pick an amount and a fresh address. The browser rebuilds the
   pool's Merkle tree from events, generates the proof (about 5 to 10 seconds on a laptop after a
   one-time 20 MB download), checks it locally, and posts it to the relayer. The proof fixes the
   recipient, fee address and fee (via the `context` signal), so the relayer cannot change them.
5. **Exit.** If a deposit is never approved, or the relayer is down, the one-time address that
   deposited can `ragequit` the remaining value back to itself, with a proof of the note. This
   needs neither the approver nor the relayer.

## Claiming privately to a wallet

On Receive, *Move funds → Shielded pool* defaults to *Send it to my wallet*: the payment is
deposited, and a delivery is saved in the vault with a destination (the connected wallet by
default, editable) and a time: as soon as it's approved, a time the user picks, or a random time
within 24 hours (the UI notes that random is more private). `DeliveryRunner` checks due deliveries
every 15 seconds while the site is open and the vault is unlocked, proves the withdrawal locally
and hands it to the relayer. There is no server-side scheduler and no key leaves the browser, so a
delivery that comes due while the site is closed goes out on the next visit. Deliveries can be
sent early or cancelled (the money then stays in the pool). They live in the local vault only; on
a new device the shielded money is still found and can be withdrawn from the Pool page.

## Keys

Note secrets follow the SDK's scheme: two master keys, then
`Poseidon(master, scope, index)` per deposit and `Poseidon(master, label, index)` per change note.
QuietPay derives the master keys with HKDF-SHA256 from the same deterministic wallet signature that
unlocks the vault (a fixed Sign-In with Ethereum message bound to www.quietpay.sbs) (separate salt and info), so the same wallet recreates them on any device. Notes are never stored: they are rebuilt from public events by trying deposit indexes
in order and following each deposit's nullifier chain.

## Verification before use

Before any deposit or withdrawal the browser checks, onchain:

- the entrypoint is the expected ERC1967 proxy and its implementation is the compiled Entrypoint;
- the pool, both verifiers and both linked Poseidon libraries match the compiled build. Immutables
  and library addresses are masked using the compiler's own offsets before hashing;
- the pool's entrypoint, asset (the allowlisted token) and verifiers are the expected ones, and the
  entrypoint routes this token to this pool;
- the rebuilt state tree's root equals the root the contract emitted;
- the approval root equals the root rebuilt from the published rule.

## The approver (ASP)

Privacy Pools needs an Association Set Provider. 0xbow's ASP does not cover Robinhood Chain, so
QuietPay runs its own on testnet, with a rule that anyone can check:

> The approved set is every deposit label up to block N, in deposit order.

The rule is written into the entrypoint's 32 to 64 character "IPFS CID" field as
`quietpay-asp-v1:upto=<block>`, so clients rebuild the set from chain events and compare roots; no
off-chain file is needed. The approver (`POST /api/pool/approvals`, also callable by anyone) only
sends a transaction when deposits older than `POOL_APPROVAL_DELAY_SECONDS` (default 0 on testnet,
so right away) are missing.

Roots go out on a fixed cadence: at most one per `POOL_ROOT_INTERVAL_SECONDS` (default 60), and
while a relay is being submitted the next one is held back, for at most three intervals after the
last root. Deposits and calls can't make roots come faster. A root change makes proofs in progress
stale (the pool accepts only its latest root, so no old root is ever accepted); the relayer
recognises that, even when the pool's error isn't decoded, and the browser proves again
automatically, once.

**On testnet this approves everything, immediately.** That is fine for worthless test tokens.

### Screening (`POOL_SCREENING`, on by default for mainnet)

Each deposit newer than the last approval is checked before it is approved, in seconds:

- **Who is checked:** the depositing address *and* every address that sent it the pool's token
  before the deposit. A QuietPay deposit comes from a one-time address no list will ever contain;
  the address that matters is the payer, found from the token transfers into it
  (`src/lib/screening/screen.ts`).
- **Against what:** OFAC-sanctioned crypto addresses that apply to EVM chains, from the official
  SDN list and a daily mirror of it, refreshed every 6 hours, with a bundled copy as the fallback
  (`src/lib/screening/sanctions.ts`, `npm run sanctions:update`).
- **Excluded deposits** are left out of the approved set. The rule becomes
  `quietpay-asp-v2:upto=<block>:x=<id>`, and the list is published at
  `/api/pool/exclusions?x=<id>` (with the matched address), so clients rebuild the set and check it
  against the onchain root. Excluded deposits can still exit to their one-time address.
- **When a check can't run** (RPC or storage down), approval stops just before that deposit and is
  retried on the next call. Nothing is approved unchecked, and deposits already approved are never
  re-screened or un-approved.
- **Limits:** list screening catches money sent straight from a sanctioned address, not money that
  passed through other wallets first. A risk-scoring provider (TRM, Elliptic, Chainalysis) can be
  added as another check in `screenDeposit`. Verdicts and lists are stored in Redis (Upstash), which
  mainnet needs.

## The relayer

`/api/relay` is a Next.js route with a testnet hot key (`RELAYER_PRIVATE_KEY`). It:

- accepts only withdrawals whose relay data names its own fee address and its own fee
  (`RELAYER_FEE_BPS`, default 0.5%, below the pool's 1% cap);
- simulates the call first (proof, roots and nullifier are all checked by the contracts), then
  submits it;
- checks that the fee pays for the relay transaction's gas, valuing tokens at
  `RELAYER_ETH_PRICE` (payment tokens per ETH, default 3000). Smaller withdrawals are refused with
  the minimum amount, which `GET /api/relay` also quotes so the UI can say so up front. Without
  this, many tiny withdrawals to addresses an attacker controls would collect the relayer's ETH;
- tops up the recipient towards `RELAYER_GAS_DROP_ETH` (default at most 0.0002 ETH) so a fresh
  address can move its tokens, only with what the fee has left after gas, and only within its
  limits: the relayer keeps `RELAYER_MIN_BALANCE_ETH` (default 0.02), each receiving address gets
  one top-up per `RELAYER_DROP_COOLDOWN_SECONDS` (default a day), each caller at most
  `RELAYER_DROPS_PER_CALLER_PER_DAY` (3), and everyone together `RELAYER_DROPS_PER_DAY` (50). On
  testnet the fee is in free tokens, so these limits are what protect the relayer's ETH
  (`src/lib/server/gas-drops.ts`).

Each client is rate-limited, a withdrawal is locked by its nullifier while it is being submitted
(so duplicate copies sent at once cost one transaction, not one failed transaction each), and the
relayer and approver send one transaction at a time so they never collide on a nonce.

It stores and logs nothing. It does see the requester's IP address and the withdrawal it submits,
and it can refuse service, but it cannot steal or redirect funds. The relayer key is separate from
the deployer key, which owns the entrypoint and must never sit on the web host.

## What the pool does not hide

- That a one-time address deposited, and how much. That an address received a withdrawal, and how
  much, and when.
- Matching amounts and quick turnarounds. A 25 tUSDG deposit followed minutes later by a 25 tUSDG
  withdrawal in a quiet pool is easy to pair. The UI says so and suggests different amounts and
  waiting.
- Anything, while the pool is small. The anonymity set is the set of approved deposits. A new pool
  on a new chain has very few.
- Network metadata: the RPC and the relayer see IP addresses.

## Owner powers (testnet deployment)

The entrypoint is upgradeable (UUPS) and has an owner. The owner can register pools, change fees,
stop new deposits, and upgrade the entrypoint. Pool funds are held by the pool contract, which the
owner cannot take from, and `ragequit` does not touch the entrypoint. An owner could still block
*private* withdrawals by upgrading the entrypoint.

`QuietPayPoolGuardian` (`contracts/src/QuietPayPoolGuardian.sol`) is the owner meant to replace the
deployer key: every change is proposed onchain, waits a delay (1 day by default), can be cancelled,
and can't push the deposit fee above 1% or the relay-fee ceiling above 5%; winding a pool down is
immediate. Its admin can be a multisig. Deploy it with `DEPLOY=guardian`, then hand it the owner
role with `DEPLOY=handover` (which also renounces the deployer's). The Security page shows the
current fees, the guardian and pending changes from the chain.

## Paying requests into the pool (pool router v2)

`QuietPayPoolRouterV2` adds `payRequest`: a one-time request is paid only by exactly its amount into
a lock signed by the request's own key, and its paid state lives in the router (`requestPaid`).
Each request also leaves three spare locks with QuietPay's lock store, used if someone burns the
link's own lock by depositing into it directly. Refund addresses that could never receive a
refund (the router, the token, the pool, the entrypoint) are refused. Deposits made through the
first router can only be refunded through it, so it stays listed in
`NEXT_PUBLIC_TESTNET_POOL_ROUTER_LEGACY`.

## Files

| Path | What |
| --- | --- |
| `contracts/vendor/privacy-pools/src` | Upstream contracts, unchanged (see `contracts/vendor/NOTICE.md`) |
| `scripts/compile-pool.ts` | solc 0.8.28 build, masked code hashes, generated ABI module |
| `scripts/pool-deploy-lib.ts` | Deployment (verifiers, proxy, libraries, pool, registration) |
| `src/lib/pool/crypto.ts` | Key derivation, Poseidon commitments, lean Merkle tree |
| `src/lib/pool/state.ts` | Event scan, note reconstruction, approval rule |
| `src/lib/pool/prover.ts` | Artifact integrity, Groth16 proving, calldata formatting |
| `src/lib/pool/actions.ts` | Verification, deposit, withdrawal preparation, exit |
| `src/lib/pool/relayer.ts` | Relayer and approver logic (server and tests) |
| `src/app/api/relay`, `src/app/api/pool/approvals` | Relayer and approver endpoints |
| `src/app/pool` | Pool page |
| `tests/e2e-pool.test.ts` | End to end on a local EVM with real proofs |
| `contracts/src/QuietPayPoolRouterV2.sol` | Pays into the pool for someone else; signed one-time requests |
| `contracts/src/QuietPayPoolGuardian.sol` | Timelocked owner of the entrypoint, with fee ceilings |
| `src/lib/pool/request-sig.ts` | Request and lock signatures the pool router v2 checks |
| `src/lib/server/gas-drops.ts` | Limits on the relayer's gas top-ups |
| `tests/e2e-pool-v2.test.ts` | Regression tests for the security fixes, on a local EVM |

## Deploying on testnet (pool router v2 and the guardian)

1. Actions → *Deploy testnet contracts* → `deploy: poolrouter`. Set the printed
   `NEXT_PUBLIC_TESTNET_POOL_ROUTER_ADDRESS` and `NEXT_PUBLIC_TESTNET_POOL_ROUTER_LEGACY` in
   `.env.production`.
2. `deploy: guardian`, `guardian_admin: <multisig or admin address>`, `guardian_delay_seconds`.
3. Check the guardian on the explorer, then `deploy: handover`, `guardian_address: <guardian>`,
   `confirm_handover: yes`. Set `NEXT_PUBLIC_TESTNET_POOL_GUARDIAN`.
4. `deploy: router` deploys `QuietPayRouterV3` for one-time-address payments; set the printed
   `NEXT_PUBLIC_TESTNET_ROUTER_ADDRESS`.

## Deploying the pool on testnet

1. Create a second throwaway account for the relayer. Fund it with testnet ETH.
2. GitHub → Actions → *Deploy testnet contracts* → `deploy: pool`, `postman: <relayer address>`.
3. Add the printed `NEXT_PUBLIC_TESTNET_POOL_*` values to `.env.production`.
4. In Vercel, add `RELAYER_PRIVATE_KEY` (sensitive) and optionally the other relayer settings.
5. Redeploy and run `npm run contracts:verify`.

## Before mainnet

1. Independent review of QuietPay's glue: key derivation, note reconstruction, verification
   masks, relayer validation. The upstream audits do not cover it.
2. Screening: list screening is built (above). Decide on a risk-scoring provider, and have a
   compliance lawyer confirm the policy.
3. Legal checks: complete.
4. Owner: the guardian (timelock, fee ceilings) with a multisig admin; consider renouncing upgrades once stable.
5. Relayer hardening: a live ETH price instead of the configured one, and an option to use any
   other relayer. (The fee has to cover gas and the top-up, top-ups are limited, and a low balance
   is monitored.)
6. Licensing: snarkjs (GPL-3.0) runs in the browser bundle. Either publish the web app's source under
   a GPL-compatible licence or isolate the prover as a separately distributed GPL component.
7. Check Robinhood Chain mainnet supports the BN254 precompiles (it is an Arbitrum Orbit chain, which
   does) by running a real withdrawal on testnet first.
