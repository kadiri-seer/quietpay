import Link from "next/link";
import type { ReactNode } from "react";
import { Skyline } from "@/components/Skyline";
import { PrivacyStatement } from "@/components/PrivacyStatement";
import { HeroNetwork } from "./HeroNetwork";

interface Tile {
  href: string;
  title: string;
  body: string;
  action: string;
  step?: number;
  art: ReactNode;
  external?: boolean;
}

const ART_STROKE = { fill: "none", stroke: "#5bb8ea", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

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
      <div className="mx-auto mb-2 h-12 w-20 opacity-80" aria-hidden>
        {t.art}
      </div>
      <h3 className="font-display whitespace-nowrap text-[1rem] font-semibold uppercase tracking-[0.06em] text-snow">
        {t.step && <span className="mr-2 font-extralight text-signal">{t.step}</span>}
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
  "hex group relative flex h-[323px] w-[280px] flex-col items-center justify-center bg-[linear-gradient(170deg,#1b5569_0%,#0e3443_55%,#082430_100%)] px-10 text-center transition-[filter] duration-200 hover:brightness-125 focus-visible:brightness-125";

export default function Home() {
  return (
    <>
      <section className="relative -mt-[132px] overflow-hidden pt-[132px] sm:-mt-[84px] sm:pt-[84px]">
        <Skyline className="absolute inset-0 h-full w-full" />
        <div className="relative mx-auto flex min-h-[78vh] max-w-6xl flex-col items-center justify-center px-4 pb-28 pt-10 text-center sm:px-6">
          <p className="font-display text-sm font-semibold tracking-[0.04em] text-mist sm:text-base">
            One-time USDG payment links on Robinhood Chain
          </p>
          <h1 className="mt-5 font-display uppercase leading-[0.98] text-snow">
            <span className="block text-[2.6rem] font-extralight tracking-[0.02em] sm:text-6xl lg:text-7xl">A fresh address</span>{" "}
            <span className="block text-[2.6rem] font-bold tracking-[0.01em] sm:text-6xl lg:text-7xl">for every payment.</span>
          </h1>
          <Link href="/create" className="btn btn-primary mt-10 min-h-12 px-7">
            Create a payment link
          </Link>
          <HeroNetwork />
          <a href="#how" className="mt-10 text-mist/70 hover:text-snow" aria-label="How QuietPay works">
            <svg width="28" height="16" viewBox="0 0 28 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2 2l12 12L26 2" />
            </svg>
          </a>
        </div>
      </section>

      <section className="relative mx-auto max-w-3xl px-4 sm:px-6">
        <PrivacyStatement />
      </section>

      <section id="how" className="relative mx-auto mt-20 max-w-6xl scroll-mt-24 px-4 sm:px-6" aria-label="How QuietPay works">
        {/* Honeycomb on wide screens */}
        <div className="hidden flex-col items-center md:flex">
          <div className="flex gap-3">
            {TILES.slice(0, 3).map((t) => (
              <TileLink key={t.title} t={t} className={HEX_CLASS}>
                <TileBody t={t} />
              </TileLink>
            ))}
          </div>
          <div className="-mt-[69px] flex gap-3">
            {TILES.slice(3).map((t) => (
              <TileLink key={t.title} t={t} className={HEX_CLASS}>
                <TileBody t={t} />
              </TileLink>
            ))}
          </div>
        </div>
        {/* Stacked on phones */}
        <div className="grid gap-3 md:hidden">
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
    </>
  );
}
