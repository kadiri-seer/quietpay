import Link from "next/link";
import type { ReactNode } from "react";
import { PaymentTrack } from "@/components/PaymentTrack";
import { XLink } from "@/components/XLink";
import { PrivacyStatement } from "@/components/PrivacyStatement";
import { HeroFaucet, HeroNetwork } from "./HeroNetwork";

interface Tile {
  href: string;
  title: string;
  body: string;
  action: string;
  step?: number;
  art: ReactNode;
  external?: boolean;
}

const ART_STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const TILES: Tile[] = [
  {
    href: "/create",
    step: 1,
    title: "Create a link",
    body: "Set an amount and expiry. Each link gets its own receiving keys.",
    action: "Create",
    art: (
      <svg viewBox="0 0 120 80" {...ART_STROKE}>
        <rect x="30" y="18" width="60" height="40" rx="5" transform="skewX(-14)" />
        <path d="M14 34h22M8 44h22" />
        {[0, 1, 2].map((r) => [0, 1, 2].map((c) => <rect key={`${r}${c}`} x={62 + c * 7} y={28 + r * 7} width="4" height="4" />))}
      </svg>
    ),
  },
  {
    href: "/pay",
    step: 2,
    title: "Pay a link",
    body: "Review the details, then send USDG to a one-time address.",
    action: "Pay",
    art: (
      <svg viewBox="0 0 120 80" {...ART_STROKE}>
        <circle cx="26" cy="40" r="9" />
        <path d="M38 40h42M72 32l8 8-8 8" />
        <path d="M94 28l10 12-10 12-10-12z" />
        <path d="M94 16v4M94 60v4" opacity=".5" />
      </svg>
    ),
  },
  {
    href: "/receive",
    step: 3,
    title: "Receive funds",
    body: "Your browser spots payments with a private key, then moves them to any wallet.",
    action: "Receive",
    art: (
      <svg viewBox="0 0 120 80" {...ART_STROKE}>
        <path d="M60 62a6 6 0 1 1 0-.1" />
        <path d="M44 50a22 22 0 0 1 32 0" />
        <path d="M34 40a36 36 0 0 1 52 0" opacity=".7" />
        <path d="M24 30a50 50 0 0 1 72 0" opacity=".45" />
      </svg>
    ),
  },
  {
    href: "/security",
    title: "What's public",
    body: "Payer, amount, receiving address and time stay visible onchain.",
    action: "Security model",
    art: (
      <svg viewBox="0 0 120 80" {...ART_STROKE}>
        <path d="M20 40c12-16 26-22 40-22s28 6 40 22c-12 16-26 22-40 22s-28-6-40-22z" />
        <circle cx="60" cy="40" r="10" />
      </svg>
    ),
  },
  {
    href: "/receive#backup",
    title: "Back up keys",
    body: "Keys live encrypted in this browser. Export a passphrase backup.",
    action: "Back up",
    art: (
      <svg viewBox="0 0 120 80" {...ART_STROKE}>
        <rect x="44" y="36" width="32" height="26" rx="3" />
        <path d="M50 36v-8a10 10 0 0 1 20 0v8" />
        <path d="M60 46v6" />
      </svg>
    ),
  },
];

function TileBody({ t }: { t: Tile }) {
  return (
    <>
      <div className="mx-auto mb-2 h-12 w-20 text-snow opacity-70" aria-hidden>
        {t.art}
      </div>
      <h3 className="font-display whitespace-nowrap text-[1.05rem] font-semibold tracking-[-0.01em] text-snow">
        {t.step && <span className="mr-2 font-medium text-haze">{t.step}</span>}
        {t.title}
      </h3>
      <p className="mx-auto mt-2 max-w-[23ch] text-[0.8rem] leading-snug text-mist/85">{t.body}</p>
      <span className="btn btn-sm mt-3.5">{t.action}</span>
    </>
  );
}

function TileLink({ t, className, children }: { t: Tile; className: string; children: ReactNode }) {
  return t.external ? (
    <a href={t.href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <Link href={t.href} className={className}>
      {children}
    </Link>
  );
}

const HEX_CLASS =
  "hex group relative flex h-[323px] w-[280px] flex-col items-center justify-center bg-[linear-gradient(170deg,var(--qp-tile-from)_0%,var(--qp-tile-to)_100%)] px-10 text-center hover:brightness-110 focus-visible:brightness-110";

/** Hairline around each hexagon (clip-path removes borders, so the outline is a drop shadow on a wrapper). */
const HEX_WRAP = "[filter:drop-shadow(0_0_0.6px_var(--qp-tide))_drop-shadow(0_10px_24px_rgba(0,0,0,0.18))]";

export default function Home() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div className="relative mx-auto grid min-h-[72vh] max-w-6xl items-center gap-6 px-4 pb-16 pt-10 sm:px-6 lg:grid-cols-[1.02fr_1fr] lg:gap-4 lg:pb-24">
          <div className="flex flex-col items-start">
            <p className="text-balance text-sm font-medium text-haze sm:text-base">One-time USDG payment links on Robinhood Chain</p>
            <h1 className="mt-4 font-display font-bold leading-[1.02] tracking-[-0.035em] text-snow">
              <span className="block text-[2.7rem] sm:text-6xl lg:text-[4.1rem]">A fresh address</span>{" "}
              <span className="block text-[2.7rem] sm:text-6xl lg:text-[4.1rem]">for every payment.</span>
            </h1>
            <Link href="/create" className="btn btn-primary mt-9 min-h-12 px-7">
              Create a payment link
            </Link>
            <HeroFaucet />
            <HeroNetwork />
            <a href="#how" className="mt-4 -ml-2 inline-flex h-11 w-11 items-center justify-center text-mist/70 hover:text-snow" aria-label="How QuietPay works">
              <svg width="24" height="14" viewBox="0 0 28 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 2l12 12L26 2" />
              </svg>
            </a>
          </div>
          <PaymentTrack className="-mx-4 h-auto w-[calc(100%+2rem)] max-w-none sm:mx-0 sm:w-full" />
        </div>
      </section>

      <section className="relative mx-auto max-w-3xl px-4 sm:px-6">
        <PrivacyStatement />
      </section>

      <section id="how" className="relative mx-auto mt-20 max-w-6xl scroll-mt-24 px-4 sm:px-6" aria-label="How QuietPay works">
        {/* Honeycomb on wider screens: rows of two, one, two. */}
        <div className="hidden flex-col items-center md:flex">
          {[TILES.slice(0, 2), TILES.slice(2, 3), TILES.slice(3)].map((row, i) => (
            <div key={i} className={`flex gap-3 ${i > 0 ? "-mt-[69px]" : ""}`}>
              {row.map((t) => (
                <div key={t.title} className={HEX_WRAP}>
                  <TileLink t={t} className={HEX_CLASS}>
                    <TileBody t={t} />
                  </TileLink>
                </div>
              ))}
            </div>
          ))}
        </div>
        {/* Stacked on phones */}
        <div className="grid gap-3 sm:grid-cols-2 md:hidden">
          {TILES.map((t) => (
            <TileLink key={t.title} t={t} className="panel block px-6 py-7 text-center">
              <TileBody t={t} />
            </TileLink>
          ))}
        </div>
      </section>

      <section className="mx-auto mt-24 max-w-3xl border-y border-mist/15 px-4 py-10 text-center sm:px-6">
        <p className="mx-auto max-w-[62ch] leading-relaxed text-mist">
          QuietPay never asks for your main wallet address when you create a link. Payers send to a one-time address derived from public
          keys in the link, and only your browser can recognise and spend from it. Nothing is stored on a server.
        </p>
      </section>

      <section id="about" className="mx-auto mt-24 max-w-6xl scroll-mt-24 px-4 sm:px-6" aria-labelledby="about-h">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
          <div>
            <p className="text-sm font-medium text-haze">About us</p>
            <h2 id="about-h" className="mt-3 font-display text-[2rem] font-bold leading-[1.08] tracking-[-0.03em] text-snow sm:text-[2.6rem]">
              <span className="text-haze">Getting paid shouldn&apos;t</span> mean being watched.
            </h2>
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
