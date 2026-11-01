import type { Metadata, Viewport } from "next";
import "@fontsource/montserrat/200.css";
import "@fontsource/montserrat/300.css";
import "@fontsource/montserrat/600.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = {
  title: "QuietPay | A fresh address for every payment",
  description:
    "One-time USDG payment links on Robinhood Chain. Each payment lands at its own ERC-5564 stealth address. Not full anonymity: the chain is public.",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  referrer: "no-referrer",
};

export const viewport: Viewport = { themeColor: "#061a23", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <Providers>
          <SiteHeader />
          <main className="relative flex-1">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
