import Link from "next/link";
import type { ReactNode } from "react";
import { PaymentTrack } from "@/components/PaymentTrack";
import { PrivacyStatement } from "@/components/PrivacyStatement";
import { HeroFaucet, HeroNetwork } from "./HeroNetwork";
import { GetStarted, HomeApp } from "./home/HomeFlow";

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
    href: "/receive",
    step: 1,
    title: "Get paid",
    body: "Share your personal link, or a request for a set amount.",
    action: "Receive",
    art: (
      <svg viewBox="0 0 120 80" {...ART_STROKE}>
        <rect x="30" y="18" width="60" height="40" rx="5" transform="skewX(-14)" />
        <path d="M14 34h22M8 44h22" />
        {[0, 1, 2].map((r) => [0, 1, 2].map((c) => <rect key={`${r}${c}`} x={62 + c * 7} y={28 + r * 7} width="4" height="4" />))}
      </svg>
    ),
  },
  {
    href: "/send",
    step: 2,
    title: "Payments go into the pool",
    body: "Every payment lands straight in your shielded balance. Nothing onchain says it's yours.",
    action: "Send",
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
    href: "/send",
    step: 3,
    title: "Send privately",
    body: "Send to a personal link or any wallet. Your device proves the money is yours without saying where it came from.",
    action: "Send",
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
    body: "Who paid in, amounts and times stay visible onchain. Who received doesn't.",
    action: "Security model",
    art: (
      <svg viewBox="0 0 120 80" {...ART_STROKE}>
        <path d="M20 40c12-16 26-22 40-22s28 6 40 22c-12 16-26 22-40 22s-28-6-40-22z" />
        <circle cx="60" cy="40" r="10" />
      </svg>
    ),
  },
  {
    href: "/receive",
    title: "Recover anywhere",
    body: "Connect the same wallet on any device and your balance comes back.",
    action: "Receive",
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
      {/* Your balance, for people who use QuietPay on this device (see HomeApp). */}
      <section className="app-top mx-auto max-w-xl px-4 pb-16 pt-6 sm:px-6" aria-label="Your balance">
        <HomeApp />
      </section>
      <section className="landing-hero relative overflow-hidden">
        <div className="relative mx-auto grid min-h-[72vh] max-w-6xl items-center gap-6 px-4 pb-16 pt-10 sm:px-6 lg:grid-cols-[1.02fr_1fr] lg:gap-4 lg:pb-24">
          <div className="flex flex-col items-start">
            <p className="text-balance text-sm font-medium text-haze sm:text-base">Private USDG payments on Robinhood Chain</p>
            <h1 className="mt-4 font-display font-bold leading-[1.02] tracking-[-0.035em] text-snow">
              <span className="block text-[2.7rem] sm:text-6xl lg:text-[4.1rem]">A fresh address</span>{" "}
              <span className="block text-[2.7rem] sm:text-6xl lg:text-[4.1rem]">for every payment.</span>
            </h1>
            <GetStarted className="btn btn-primary mt-9 min-h-12 px-7" />
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
          Your wallet address never goes into a link. Payers pay into the shielded pool under a one-time lock that only your device can
          open. QuietPay&apos;s server keeps those locks for your personal link, never your keys or your wallet address.
        </p>
      </section>

    </>
  );
}
