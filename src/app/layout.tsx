import type { Metadata, Viewport } from "next";
import "@fontsource/montserrat/200.css";
import "@fontsource/montserrat/300.css";
import "@fontsource/montserrat/600.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = {
  title: "QuietPay | A fresh address for every payment",
  description:
    "One-time USDG payment links on Robinhood Chain. Each payment lands at its own ERC-5564 stealth address. Not full anonymity: the chain is public.",
  icons: { icon: "/icon.svg" },
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
