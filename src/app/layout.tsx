import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/montserrat/300.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { ServiceWorker } from "@/components/ServiceWorker";
import { DeliveryRunner } from "@/components/DeliveryRunner";

export const metadata: Metadata = {
  title: "QuietPay | A fresh address for every payment",
  description:
    "One-time USDG payment links on Robinhood Chain. Each payment lands at its own ERC-5564 stealth address. Not full anonymity: the chain is public.",
  applicationName: "QuietPay",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  appleWebApp: { capable: true, title: "QuietPay", statusBarStyle: "black-translucent" },
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
    { media: "(prefers-color-scheme: light)", color: "#f5f5f4" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Applies the saved theme (or the device setting) before the first paint, so pages never flash
 * the wrong colours. Kept tiny and inline; it reads one localStorage key and nothing else.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("quietpay:theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="dark"}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Per-request nonce from src/proxy.ts; the page's CSP only runs scripts that carry it.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <Providers>
          <SiteHeader />
          <main className="relative flex-1">{children}</main>
          <SiteFooter />
          <DeliveryRunner />
        </Providers>
        <ServiceWorker />
      </body>
    </html>
  );
}
