import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, type LegalSection } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy | QuietPay",
  description: "What QuietPay stores, where it lives, and which outside services can see your activity. QuietPay has no accounts, no server database and no analytics.",
};

const sections: LegalSection[] = [
  {
    id: "summary",
    title: "Summary",
    body: (
      <ul>
        <li>QuietPay has no accounts, no server database, no cookies for tracking and no analytics.</li>
        <li>
          QuietPay&apos;s server code is the shielded pool&apos;s relayer and approver, and a store of payment locks for personal links,
          signed by a key that is not your wallet.
        </li>
        <li>Your payment keys are encrypted and stored only in your own browser.</li>
        <li>Blockchain activity is public and permanent, and some outside services can see technical details such as your IP address.</li>
      </ul>
    ),
  },
  {
    id: "collect",
    title: "What QuietPay collects",
    body: (
      <p>
        QuietPay itself does not collect, receive or store personal information. It does not ask for your name, email address or main wallet
        address when you create a link. Payment links keep their data after the # in the address, which browsers do not send to the web server.
        For your personal link, QuietPay&apos;s server stores payment locks (hashes and refund addresses) signed by a key your browser
        creates (not your wallet address). To limit abuse, it also keeps short-lived counters tied to a scrambled form of your IP address,
        which expire within an hour.
      </p>
    ),
  },
  {
    id: "browser",
    title: "What stays in your browser",
    body: (
      <>
        <p>QuietPay uses your browser's local storage for:</p>
        <ul>
          <li>Your key vault: a cache of your links, keys and payment records, encrypted with a key derived from your wallet's signature.</li>
          <li>Payments you have sent: the one-time address, public announcement data and transaction hashes, so an interrupted payment can be finished.</li>
          <li>Wallet connection settings, so your wallet reconnects when you return.</li>
          <li>
            If you choose to stay signed in: the key that opens your vault, kept for up to 30 days in browser storage that lets it be used but
            not copied out. Signing out of this device, disconnecting or connecting another wallet deletes it.
          </li>
          <li>Circuit files for the shielded pool, cached by your browser after the first withdrawal.</li>
        </ul>
        <p>
          This data never leaves your device. You can delete it at any time by clearing this site&apos;s data in your browser settings.
          Your links and payments come back when you connect the same wallet again.
        </p>
      </>
    ),
  },
  {
    id: "blockchain",
    title: "Information on the blockchain",
    body: (
      <p>
        When you pay or move funds, transactions are recorded on Robinhood Chain. Anyone can see the sending address, the amount, the
        receiving address, any ETH included for fees, and the time. This record cannot be changed or deleted by QuietPay or anyone else. See the{" "}
        <Link href="/security">Security model</Link> for what QuietPay keeps unlinkable.
      </p>
    ),
  },
  {
    id: "third-parties",
    title: "Outside services that see your activity",
    body: (
      <ul>
        <li>
          <strong className="text-snow">Website host (Vercel).</strong> Serves the site and receives standard request information such as your
          IP address and browser type, under its own privacy policy.
        </li>
        <li>
          <strong className="text-snow">Robinhood Chain RPC.</strong> Your browser sends blockchain requests directly to it. The provider can
          see your IP address, the addresses and block ranges you look up, and transactions you send. It never receives your keys.
        </li>
        <li>
          <strong className="text-snow">WalletConnect (Reown).</strong> Only if you choose it. Messages to your mobile wallet are end-to-end
          encrypted but pass through Reown's relay, which can see connection metadata such as your IP address.
        </li>
        <li>
          <strong className="text-snow">QuietPay relayer.</strong> Only if you withdraw from the shielded pool. It receives the finished
          proof and the receiving address, sees your IP address, and submits the withdrawal. It never receives your keys or learns which
          deposit is yours. It does not store or log requests.
        </li>
        <li>
          <strong className="text-snow">Your wallet.</strong> Sees the transactions and messages you approve, under its own policy.
        </li>
        <li>
          <strong className="text-snow">Block explorer.</strong> Only when you open an explorer link.
        </li>
      </ul>
    ),
  },
  {
    id: "no-tracking",
    title: "Cookies and tracking",
    body: (
      <p>
        QuietPay does not use advertising or analytics cookies, tracking pixels or third-party scripts. Fonts are served from QuietPay's own
        host, so loading the site does not contact font services.
      </p>
    ),
  },
  {
    id: "rights",
    title: "Your choices",
    body: (
      <p>
        Because QuietPay holds no personal data about you, there is nothing for it to access, correct or delete on your behalf. You control
        everything QuietPay stores in your browser and can remove it by clearing this site&apos;s data.
      </p>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: <p>QuietPay is not intended for anyone under 18.</p>,
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        If QuietPay's handling of information changes, this page will be updated and the date at the top will change. The{" "}
        <Link href="/terms">Terms of Service</Link> cover the rest of your use of the site.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      light="Privacy"
      bold="Policy"
      intro="QuietPay is built so it never needs your personal information. This page explains what is stored, where, and who else can see what."
      updated="1 November 2026"
      sections={sections}
    />
  );
}
