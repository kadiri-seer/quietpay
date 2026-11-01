import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_ANNOUNCER_CODE_HASHES } from "@/config/contracts";
import { enabledNetworks, explorerAddressUrl } from "@/config/networks";
import { PrivacyStatement } from "@/components/PrivacyStatement";
import { PageTitle } from "@/components/ui";
import { LiveContractCheck } from "./LiveContractCheck";

export const metadata: Metadata = {
  title: "Security | QuietPay",
  description: "What QuietPay keeps unlinkable, what stays public on Robinhood Chain, where your keys live, the risks, and the contracts it uses.",
};

// Read at build time so the page shows exactly the source that was compiled and deployed.
const announcerSource = readFileSync(join(process.cwd(), "contracts", "src", "ERC5564Announcer.sol"), "utf8");

const VISIBLE = ["Your wallet address when you pay", "The amount", "The one-time receiving address", "When each transaction happened"];
const HIDDEN = ["Which main wallet a payment belongs to", "That two payments went to the same person", "Your receiving keys"];

const KEYS: { what: string; where: string }[] = [
  { what: "Each link's receiving keys", where: "Encrypted in this browser (AES-256-GCM). The key comes from a message your wallet signs and only lives in memory." },
  { what: "The message signature", where: "Never stored. Re-signed each time you unlock." },
  { what: "The key that moves a payment", where: "Worked out in your browser at claim time, used once to sign, then discarded." },
  { what: "Backup files", where: "Encrypted with your passphrase (PBKDF2, 600,000 rounds). Keep the file and passphrase apart." },
  { what: "Payment links", where: "Public keys only, kept after the # in the URL so they never reach a web server." },
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
    body: "Clearing browser data, private windows or a lost device lose the keys, and any unclaimed funds with them. Export an encrypted backup from the Receive page.",
  },
  {
    title: "Phishing for your vault signature",
    body: "Anyone who reads this browser's storage only sees ciphertext. Unlocking it needs your wallet's signature of QuietPay's vault message, so only sign that message on this site.",
  },
  {
    title: "A compromised browser",
    body: "Malware or a malicious extension running in the page can read keys while the vault is unlocked. QuietPay can't protect against that.",
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
    title: "Gas top-ups and claims",
    body: "A one-time address starts with no ETH for fees. QuietPay never funds it automatically. Topping it up from, or claiming to, your main wallet publicly links them, so use an unrelated wallet or a fresh address if that matters.",
  },
];

function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-harbor pt-8">
      <h2 className="mb-5 font-display text-lg font-semibold uppercase tracking-[0.06em] text-snow">{title}</h2>
      {children}
    </section>
  );
}

export default function SecurityPage() {
  const networks = enabledNetworks();
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
      <PageTitle light="Security" bold="model">
        What QuietPay protects, what it can&apos;t, and the contracts it relies on. QuietPay is experimental, unaudited software running on
        testnet.
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
          <p className="mt-4 text-sm text-haze">Nothing is sent to a QuietPay server. There is no QuietPay server, database or analytics.</p>
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
                <div>
                  <dt className="text-haze">Expected announcer bytecode hash</dt>
                  <dd className="mt-1 break-all font-mono text-xs text-mist">{KNOWN_ANNOUNCER_CODE_HASHES.join(", ")}</dd>
                </div>
              </dl>
              <LiveContractCheck networkKey={n.key} />
            </div>
          ))}

          <details className="group mt-8 rounded-[3px] border border-harbor">
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
        </Section>

        <Section title="Mainnet">
          <p className="text-sm leading-relaxed text-mist">
            Mainnet is switched off. It stays off until the announcer is deployed and verified on mainnet, USDG is confirmed onchain, the flow
            has been tested with real wallets on testnet, and the code has had an independent security review.
          </p>
        </Section>
      </div>
    </div>
  );
}

function ContractRow({ label, address, href }: { label: string; address: string | null; href: string | null }) {
  return (
    <div>
      <dt className="text-haze">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs">
        {address && href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-signal underline decoration-signal/40 underline-offset-4 hover:decoration-signal">
            {address}
          </a>
        ) : (
          <span className="text-bad">Not configured</span>
        )}
      </dd>
    </div>
  );
}
