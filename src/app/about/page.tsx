import type { Metadata } from "next";
import { XLink } from "@/components/XLink";

export const metadata: Metadata = {
  title: "About us | QuietPay",
  description: "Why QuietPay exists: getting paid in stablecoins shouldn't mean showing everyone your wallet.",
};

export default function AboutPage() {
  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pt-6 sm:px-6" aria-labelledby="about-h">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
          <div>
            <p className="text-sm font-medium text-haze">About us</p>
            <h1 id="about-h" className="mt-3 font-display text-[2rem] font-bold leading-[1.08] tracking-[-0.03em] text-snow sm:text-[2.6rem]">
              <span className="text-haze">Getting paid shouldn&apos;t</span> mean being watched.
            </h1>
            <div className="mt-6 space-y-4 leading-relaxed text-mist">
              <p>
                On a public blockchain, sharing one address to get paid shows everyone your balance, your income and every person who pays
                you. QuietPay exists to fix that for everyday stablecoin payments.
              </p>
              <p>
                Every payment goes to a fresh address that only you can open, the payer covers the gas, and you decide where the money goes
                next, including into a shielded pool where nothing onchain says which deposit a withdrawal came from.
              </p>
              <p className="text-haze">
                QuietPay is live on Robinhood Chain testnet. It has not been independently audited yet; its shielded pool is built on
                0xbow&apos;s audited Privacy Pools.
              </p>
            </div>
            <div className="mt-4 flex items-center gap-2 text-sm text-haze">
              <XLink className="-ml-3" />
              <span>Follow along for updates</span>
            </div>
          </div>
          <ul className="grid content-start gap-3 sm:grid-cols-2">
            {[
              ["Your keys stay with you", "Keys are created and encrypted in your browser. QuietPay never holds your funds or sees your keys."],
              ["Honest about privacy", "We say exactly what stays public and what doesn't. QuietPay keeps payments from being tied to your wallet; it doesn't hide that they happen."],
              ["Built on open standards", "Fresh addresses use the ERC-5564 stealth address standard, so the method is public and checkable."],
              ["Proven foundations", "The shielded pool reuses 0xbow's audited Privacy Pools contracts and circuits rather than inventing new cryptography."],
            ].map(([title, body]) => (
              <li key={title} className="panel p-5">
                <h3 className="font-semibold tracking-[-0.01em] text-snow">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-haze">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
