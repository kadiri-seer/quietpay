import type { MetadataRoute } from "next";

/** Makes QuietPay installable from the browser: own icon, own window, no app store. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "QuietPay",
    short_name: "QuietPay",
    description: "One-time USDG payment links on Robinhood Chain, with a fresh receiving address for every payment.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    categories: ["finance", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Create a link", url: "/create", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Receive", url: "/receive", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Pool", url: "/pool", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
