import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, type LegalSection } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service | QuietPay",
  description: "The terms for using QuietPay, an experimental, non-custodial interface for one-time USDG payment links on Robinhood Chain.",
};

const sections: LegalSection[] = [
  {
    id: "about",
    title: "What QuietPay is",
    body: (
      <>
        <p>
          QuietPay is a website that helps you create and pay one-time payment links on Robinhood Chain using ERC-5564 stealth addresses.
          It runs entirely in your browser and talks directly to the blockchain and to the wallet you choose.
        </p>
        <p>
          QuietPay is experimental software. It currently runs on Robinhood Chain Testnet using a test token with no monetary value. QuietPay
          itself has not been independently audited yet. Its shielded pool uses 0xbow&apos;s Privacy Pools contracts and circuits, which were
          audited by Oxorio and Auditware.
        </p>
      </>
    ),
  },
  {
    id: "acceptance",
    title: "Accepting these terms",
    body: (
      <p>
        By using QuietPay you agree to these terms. If you do not agree, do not use the site. You must be at least 18 years old and legally
        able to enter into this agreement where you live.
      </p>
    ),
  },
  {
    id: "non-custodial",
    title: "QuietPay never holds your funds or keys",
    body: (
      <>
        <p>
          QuietPay does not take custody of tokens, private keys, recovery phrases or payment keys. Payments move directly between wallets on
          Robinhood Chain. Payment keys are generated and encrypted in your browser and are never sent to QuietPay.
        </p>
        <p>
          Funds you shield are held by the Privacy Pools smart contract, not by QuietPay. Only someone with your pool keys can withdraw them,
          and the address that made a deposit can always take it back. The QuietPay relayer only submits withdrawals you have already
          proved; it can decline to submit one but cannot redirect it.
        </p>
        <p>
          Because of this, QuietPay cannot recover lost keys, reverse or cancel transactions, freeze funds, or retrieve payments sent to the
          wrong place. Blockchain transactions are final once confirmed.
        </p>
      </>
    ),
  },
  {
    id: "responsibilities",
    title: "Your responsibilities",
    body: (
      <ul>
        <li>
          Keeping your wallet and its recovery phrase safe. Your QuietPay keys are recreated from your wallet, so losing the wallet means
          losing access to your QuietPay payments.
        </li>
        <li>Only signing QuietPay&apos;s vault message on QuietPay itself.</li>
        <li>Checking the amount, network and source of every link before you pay it.</li>
        <li>Paying network fees, which are set by Robinhood Chain and not by QuietPay.</li>
        <li>Complying with the laws that apply to you, including tax, sanctions and anti-money-laundering rules.</li>
      </ul>
    ),
  },
  {
    id: "privacy-limits",
    title: "Privacy limits",
    body: (
      <p>
        QuietPay gives each payment a fresh receiving address. Robinhood Chain is public: the payer, amount, destination address and
        transaction time can be visible. The shielded pool hides which deposit a withdrawal came from, but deposits and withdrawals themselves
        are public and can sometimes be matched by amount and timing. QuietPay does not provide anonymity, and you should not rely on it to
        hide activity from anyone.
        The <Link href="/security">Security model</Link> explains what is and is not protected.
      </p>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>You must not use QuietPay, including its shielded pool, to:</p>
        <ul>
          <li>break any law or regulation, or help anyone else do so;</li>
          <li>launder money, finance terrorism, evade sanctions or commit fraud;</li>
          <li>receive the proceeds of crime or pay for illegal goods or services;</li>
          <li>attack, disrupt or overload the site, the blockchain or other users.</li>
        </ul>
        <p>
          Every pool deposit must be approved before it can be withdrawn privately. Approval may be withheld from deposits linked to sanctions,
          theft or other illicit activity; such deposits can only exit back to the address that made them.
        </p>
      </>
    ),
  },
  {
    id: "test-tokens",
    title: "Test tokens",
    body: (
      <p>
        On testnet, QuietPay uses tUSDG, a test token created for QuietPay. It is not USDG, is not issued by Paxos or any other issuer, and has
        no monetary value. Do not buy, sell or accept tUSDG as payment for anything of value.
      </p>
    ),
  },
  {
    id: "third-parties",
    title: "Third-party services",
    body: (
      <p>
        QuietPay relies on services it does not control, including Robinhood Chain and its RPC endpoints, your wallet software, WalletConnect
        (Reown) if you choose it, block explorers and the website host. Their availability, fees and terms are their own, and QuietPay is not
        responsible for them.
      </p>
    ),
  },
  {
    id: "warranty",
    title: "No warranty",
    body: (
      <p>
        QuietPay is provided “as is” and “as available”, without warranties of any kind, express or implied, including fitness for a
        particular purpose, accuracy, security and uninterrupted availability. Software can contain bugs, and smart contracts and blockchains
        can behave unexpectedly.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <p>
        To the fullest extent permitted by law, the people who build and operate QuietPay are not liable for any loss of funds, keys, data or
        profits, or for any indirect or consequential loss, arising from your use of the site or your inability to use it. Nothing in these
        terms limits liability that cannot be limited by law.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to QuietPay and these terms",
    body: (
      <p>
        QuietPay may change, pause or stop at any time. These terms may be updated; the date at the top of this page shows when they last
        changed. Continuing to use the site after a change means you accept the updated terms.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      light="Terms of"
      bold="Service"
      intro="Plain-language terms for an experimental, non-custodial payment tool. Please read them before you create or pay a link."
      updated="1 November 2026"
      sections={sections}
    />
  );
}
