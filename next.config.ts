import type { NextConfig } from "next";
import { LOCKED_DOWN_CSP } from "./src/lib/csp";

// Pages get a per-request Content Security Policy with a script nonce from src/proxy.ts.
// API routes get a policy that lets nothing run.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The vault message is bound to quietpay.sbs (see src/lib/vault-crypto.ts), so wallets warn on
  // any other host. Send the old vercel.app address there instead of letting people sign on it.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "quietpay-gules.vercel.app" }],
        destination: "https://quietpay.sbs/:path*",
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Content-Security-Policy", value: LOCKED_DOWN_CSP }],
      },
      {
        // Always fetch the latest service worker so installed apps pick up updates.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
