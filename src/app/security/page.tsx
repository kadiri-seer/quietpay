import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_ANNOUNCER_CODE_HASHES } from "@/config/contracts";
import { enabledNetworks, explorerAddressUrl } from "@/config/networks";
import { PrivacyStatement } from "@/components/PrivacyStatement";
import { PageTitle } from "@/components/ui";
import { LiveContractCheck } from "./LiveContractCheck";
import { PoolAdmin } from "./PoolAdmin";

export const metadata: Metadata = {
  title: "Security | QuietPay",
  description: "What QuietPay keeps unlinkable, what stays public on Robinhood Chain, where your keys live, the risks, and the contracts it uses.",
};

// Read at build time so the page shows exactly the source that was compiled and deployed.
const announcerSource = readFileSync(join(process.cwd(), "contracts", "src", "ERC5564Announcer.sol"), "utf8");

const VISIBLE = ["Your wallet address when you pay", "The amount", "The one-time receiving address", "When each transaction happened"];
const HIDDEN = [
  "Which main wallet a payment belongs to",
  "That two payments went to the same person",
  "Your receiving keys",
  "Which pool deposit a withdrawal came from",
];

const KEYS: { what: string; where: string }[] = [
  {
    what: "Each link's receiving keys",
    where: "Worked out from your wallet's signature of QuietPay's message plus the link's number, so the same wallet recreates them on any device. Cached in this browser, encrypted (AES-256-GCM).",
  },
  { what: "The message signature", where: "Never stored. Re-signed each time you unlock. It can recreate all your QuietPay keys, so only sign it on this site." },
  { what: "The key that moves a payment", where: "Worked out in your browser at claim time, used once to sign, then discarded." },
  { what: "Payment links", where: "Public keys only, kept after the # in the URL so they never reach a web server." },
  {
    what: "Pool keys",
    where: "Derived in this browser from the same signature (separate derivation), so the same wallet recreates them. Pool proofs are generated on this device.",
  },
  {
    what: "Link key",
    where: "Signs the payment locks behind your personal link. Derived in this browser from the same signature (separate derivation), kept in the vault, and never your wallet key.",
  },
];

const RISKS: { title: string; body: string }[] = [
  {
    title: "Tampered or fake links",
    body: "Every link is checked before you connect a wallet: checksum, network, accepted token, amount limits, expiry and valid keys. Links can't carry contract addresses or code. A link can still come from someone you don't trust, so only pay links from people you know.",
  },
  {
    title: "Fake tokens or contracts",
    body: "QuietPay only accepts one token per network and checks it onchain. The announcer must match QuietPay's exact compiled bytecode; anything else disables payments.",
  },
  {
    title: "Losing your keys",
    body: "There's nothing to back up. Your links, payments and pool funds all come back when you connect the same wallet on any device. Keep your wallet's recovery phrase safe: losing the wallet means losing access.",
  },
  {
    title: "Phishing for your vault signature",
    body: "Your signature of QuietPay's vault message recreates all your QuietPay keys, like a password. A fake site that tricks you into signing it could reach your funds. The message is a standard sign-in bound to quietpay.sbs, so most wallets warn when another site asks for it: if yours does, don't sign. Browser storage alone only holds ciphertext.",
  },
  {
    title: "A compromised browser",
    body: "Malware or a malicious extension running in the page can read keys while the vault is unlocked. QuietPay can't protect against that.",
  },
  {
    title: "Staying signed in",
    body: "If you choose to stay signed in, the vault opens on this device without a signature for up to 30 days. The key can be used but not copied out of the browser, yet anyone who can use the browser, or anything running in the page, could use your links and payments. Only choose it on your own device. Signing out of this device, disconnecting or connecting another wallet ends it.",
  },
  {
    title: "Network providers",
    body: "Your browser talks to Robinhood Chain's RPC directly. It can see your IP address and which blocks you scan, never your keys. WalletConnect messages are end-to-end encrypted but pass through Reown's relay, which sees connection metadata.",
  },
  {
    title: "Half-finished payments",
    body: "Paying is two transactions: the transfer, then an announcement. If the announcement fails, only it can be retried; QuietPay will never resend a payment that was already sent. Payments count only after the transfer is verified onchain.",
  },
  {
    title: "Gas for claims",
    body: "The payer covers the gas. A tiny amount of ETH goes with each payment, so you can move the funds without topping the address up from a wallet linked to you.",
  },
  {
    title: "Where you move the money",
    body: "Moving a payment into your main wallet publicly links them, and the payer can follow it. Send to a fresh account or pay someone directly from the payment. Cashing out to an exchange account in your name links the funds to you.",
  },
  {
    title: "The shielded pool",
    body: "Pool withdrawals hide which deposit they came from, not that someone withdrew. Privacy depends on how many others use the pool, and matching amounts or quick withdrawals can still be connected. The pool contracts and circuits are 0xbow's audited Privacy Pools, unchanged, with their ceremony keys.",
  },
  {
    title: "Claiming privately to your wallet",
    body: "Claim privately shields a payment, then sends it from the pool to the address you pick, right away or at a time you choose. Sending to your own wallet shows that it used the pool, not which payment it came from; a random time and a fresh address make it more private. Deliveries run in your browser, so one that comes due while QuietPay is closed goes out the next time you open it.",
  },
  {
    title: "The relayer and approver",
    body: "QuietPay runs a small relayer so withdrawals can go to an empty address. It sees your IP address and the withdrawal, can refuse to submit, but cannot change the recipient or fee because the proof fixes them. The approver publishes approvals by a public rule anyone can check. If either stops, deposits can always exit to their one-time address.",
  },
  {
    title: "Underpaid or hijacked payment requests",
    body: "New one-time requests are signed by a key made for that request alone. QuietPay's pool payment contract (v2) marks a request paid only when exactly its amount goes into a lock that same key signed, so nobody can use a request up by paying less or paying somewhere else, and a failed attempt changes nothing. If someone deposits straight into a request's lock, the money is yours, and the payer uses one of the request's spare locks instead.",
  },
  {
    title: "Approval timing",
    body: "Each withdrawal proof is made against the pool's latest approval list, and a new list makes proofs in progress start over. So the approver publishes at most one new list a minute, holds back while a withdrawal is being submitted, and ignores how many deposits arrive. The pool only accepts the latest list, so an old one is never accepted.",
  },
  {
    title: "Gas top-ups",
    body: "After a relayed withdrawal, the relayer may send a little ETH to an empty receiving address. Each address gets at most one top-up a day, each caller a few, with a daily total, and none while the relayer's balance is low. Free test tokens can't be used to drain it.",
  },
  {
    title: "Who controls the pool",
    body: "The pool's settings belong to the Entrypoint's owner. Once the guardian contract holds that role, every change (fees, roles, upgrades) is announced onchain, waits out a delay during which anyone can withdraw, and can be cancelled. The deposit fee can never go above 1%. The current fee is read from the chain and shown before you pay.",
  },
  {
    title: "Reusable links",
    body: "An any-amount link can be paid many times. Each payment still lands at its own address, and the public announcement carries no link ID, so observers cannot group payments to the same link. Everyone you share it with knows the payments go to you.",
  },
];

function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-harbor pt-8">
      <h2 className="mb-5 font-display text-lg font-semibold tracking-[-0.01em] text-snow">{title}</h2>
      {children}
    </section>
  );
}

export default function SecurityPage() {
  const networks = enabledNetworks();
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
      <PageTitle light="Security" bold="model">
        What QuietPay protects, what it can&apos;t, and the contracts it relies on. QuietPay runs on testnet and has not been independently
        audited yet. Its shielded pool is built on 0xbow&apos;s Privacy Pools, whose contracts and circuits were audited by Oxorio and
        Auditware.
      </PageTitle>

      <div className="mb-10">
        <PrivacyStatement />
      </div>

      <div className="space-y-12">
        <Section title="What stays public, what doesn't">
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <p className="mb-3 text-sm font-medium text-snow">Visible to anyone on Robinhood Chain</p>
              <ul className="space-y-2 text-sm text-mist">
                {VISIBLE.map((v) => (
                  <li key={v} className="flex gap-3">
                    <span className="mt-[0.55em] h-1.5 w-1.5 shrink-0 bg-warn" aria-hidden />
                    {v}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-3 text-sm font-medium text-snow">Kept unlinkable by QuietPay</p>
              <ul className="space-y-2 text-sm text-mist">
                {HIDDEN.map((v) => (
                  <li key={v} className="flex gap-3">
                    <span className="mt-[0.55em] h-1.5 w-1.5 shrink-0 bg-ok" aria-hidden />
                    {v}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Section>

        <Section title="Where your keys live">
          <dl className="divide-y divide-harbor/70 text-sm">
            {KEYS.map((k) => (
              <div key={k.what} className="grid gap-1 py-3 sm:grid-cols-[14rem_1fr] sm:gap-6">
                <dt className="font-medium text-snow">{k.what}</dt>
                <dd className="leading-relaxed text-mist">{k.where}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-haze">
            No keys or secrets are ever sent to a server. QuietPay has no analytics. Its only server code is the pool relayer and approver,
            which receive finished proofs, never secrets, and the lock store for personal links, which holds signed locks and never your
            wallet address.
          </p>
        </Section>

        <Section title="Risks and how QuietPay handles them">
          <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
            {RISKS.map((r) => (
              <div key={r.title}>
                <h3 className="mb-1.5 font-medium text-snow">{r.title}</h3>
                <p className="text-sm leading-relaxed text-mist">{r.body}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section id="contracts" title="Contracts">
          <p className="mb-6 text-sm leading-relaxed text-mist">
            QuietPay follows the{" "}
            <a
              href="https://eips.ethereum.org/EIPS/eip-5564"
              target="_blank"
              rel="noopener noreferrer"
              className="text-signal underline decoration-signal/40 underline-offset-4 hover:decoration-signal"
            >
              ERC-5564 stealth address standard<span className="sr-only"> (opens in a new tab)</span>
            </a>
            . The router sends the payment, the gas the payer covers and the announcement in one transaction, so they succeed or fail
            together. Like the announcer, it holds no funds and has no owner. The payer approves exactly the amount being paid.
          </p>
          {networks.map((n) => (
            <div key={n.key} className="space-y-4">
              <p className="text-sm text-haze">
                {n.label} (chain ID {n.chain.id})
              </p>
              <dl className="space-y-4 text-sm">
                <ContractRow
                  label={n.tokenIsMock ? "Payment token (test token, no value)" : "Payment token (USDG)"}
                  address={n.token}
                  href={n.token ? explorerAddressUrl(n, n.token) : null}
                />
                <ContractRow label="ERC-5564 announcer" address={n.announcer} href={n.announcer ? explorerAddressUrl(n, n.announcer) : null} />
                <ContractRow
                  label="QuietPay router (one-transaction payments)"
                  address={n.router}
                  href={n.router ? explorerAddressUrl(n, n.router) : null}
                  emptyLabel="Not deployed yet. Payments use two transactions."
                />
                <ContractRow
                  label="Shielded pool entrypoint (Privacy Pools by 0xbow)"
                  address={n.pool?.entrypoint ?? null}
                  href={n.pool ? explorerAddressUrl(n, n.pool.entrypoint) : null}
                  emptyLabel={n.chain.testnet ? "Not deployed yet." : "Testnet only for now."}
                />
                <ContractRow
                  label="Shielded pool"
                  address={n.pool?.pool ?? null}
                  href={n.pool ? explorerAddressUrl(n, n.pool.pool) : null}
                  emptyLabel={n.chain.testnet ? "Not deployed yet." : "Testnet only for now."}
                />
                <ContractRow
                  label="QuietPay pool router (pays one-time links straight into the pool)"
                  address={n.pool?.router ?? null}
                  href={n.pool?.router ? explorerAddressUrl(n, n.pool.router) : null}
                  emptyLabel={n.chain.testnet ? "Not deployed yet." : "Testnet only for now."}
                />
                <div>
                  <dt className="text-haze">Expected announcer bytecode hash</dt>
                  <dd className="mt-1 break-all font-mono text-xs text-mist">{KNOWN_ANNOUNCER_CODE_HASHES.join(", ")}</dd>
                </div>
              </dl>
              <LiveContractCheck networkKey={n.key} />
            </div>
          ))}

          <details className="group mt-8 rounded-xl border border-harbor">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-snow marker:hidden">
              <span className="mr-2 inline-block text-signal group-open:rotate-90" aria-hidden>
                ›
              </span>
              Announcer source code
              <span className="ml-2 font-normal text-haze">Solidity 0.8.23, CC0, by ScopeLift</span>
            </summary>
            <pre className="max-h-[28rem] overflow-auto border-t border-harbor bg-abyss/60 p-4 text-[0.72rem] leading-relaxed text-mist">
              <code>{announcerSource}</code>
            </pre>
          </details>
          <p className="mt-4 text-sm leading-relaxed text-haze">
            The announcer only emits a public event. It holds no funds and has no owner. Payments go straight from the payer to the one-time
            address through the token contract.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-haze">
            The shielded pool uses 0xbow&apos;s Privacy Pools contracts and circuits (Apache-2.0), compiled unchanged with the audited compiler
            version. They were audited by Oxorio and Auditware. Before any deposit, your browser checks every pool contract against that build,
            and every circuit file against the trusted-setup ceremony output. Unlike the announcer and router, the pool has an owner: on testnet,
            QuietPay&apos;s deployer can upgrade the entrypoint, add pools and stop new deposits. Funds sit in the pool contract, which the owner cannot take from, and a depositor&apos;s exit back to its one-time address does not depend on the owner, the approver or the relayer.
          </p>
        </Section>

        <Section id="pool-admin" title="Pool administration">
          <PoolAdmin />
        </Section>

        <Section title="Mainnet">
          <p className="text-sm leading-relaxed text-mist">
            Mainnet is switched off. It stays off until the announcer is deployed and verified on mainnet, USDG is confirmed onchain, the flow
            has been tested with real wallets on testnet, and the code has had an independent security review. Legal checks are complete.
          </p>
        </Section>
      </div>
    </div>
  );
}

function ContractRow({ label, address, href, emptyLabel = "Not configured" }: { label: string; address: string | null; href: string | null; emptyLabel?: string }) {
  return (
    <div>
      <dt className="text-haze">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs">
        {address && href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-signal underline decoration-signal/40 underline-offset-4 hover:decoration-signal">
            {address}
          </a>
        ) : (
          <span className="font-sans text-sm text-haze">{emptyLabel}</span>
        )}
      </dd>
    </div>
  );
}
