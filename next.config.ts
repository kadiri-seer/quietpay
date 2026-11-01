import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

function origin(url: string | undefined, fallback: string) {
  try {
    return new URL(url || fallback).origin;
  } catch {
    return new URL(fallback).origin;
  }
}

// The browser talks directly to these RPCs; nothing else is allowed for fetch/XHR/WebSocket.
const rpcOrigins = [
  origin(process.env.NEXT_PUBLIC_TESTNET_RPC_URL, "https://rpc.testnet.chain.robinhood.com"),
  ...(process.env.NEXT_PUBLIC_ENABLE_MAINNET === "true"
    ? [origin(process.env.NEXT_PUBLIC_MAINNET_RPC_URL, "https://rpc.mainnet.chain.robinhood.com")]
    : []),
];

// WalletConnect (Reown) relay, wallet registry images and verify frame. Only allowed when a
// project ID is configured, so the default build talks to nothing but the RPC.
const wc = !!process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const wcConnect = wc
  ? " https://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.com wss://*.walletconnect.org https://*.reown.com wss://*.reown.com https://*.web3modal.org https://*.web3modal.com"
  : "";
const wcImg = wc ? " https://*.walletconnect.com https://*.walletconnect.org https://*.reown.com" : "";
const wcFrame = wc ? "https://verify.walletconnect.com https://verify.walletconnect.org https://secure.walletconnect.org https://*.reown.com" : "";
const wcFont = wc ? " https://fonts.reown.com" : "";

// Next.js App Router needs 'unsafe-inline' for its bootstrap scripts without a nonce setup.
// No third-party scripts are loaded. See SECURITY.md.
const csp = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' lets the pool's proof generator compile its WebAssembly; it does not allow eval().
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${wcImg}`,
  `font-src 'self'${wcFont}`,
  `connect-src 'self' ${rpcOrigins.join(" ")}${wcConnect}${isDev ? " ws: http://127.0.0.1:* http://localhost:*" : ""}`,
  wc ? `frame-src ${wcFrame}` : "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
