/**
 * Content Security Policy, built per request by src/proxy.ts with a fresh nonce.
 *
 * Scripts run only if they carry the request's nonce (Next.js adds it to its own scripts) or are
 * loaded by a script that does ('strict-dynamic'). There is no 'unsafe-inline' for scripts, so an
 * injected <script> or inline event handler does not run. This matters most when the user chooses
 * to stay signed in: the vault key is usable by any script running in the page.
 */
function origin(url: string | undefined, fallback: string) {
  try {
    return new URL(url || fallback).origin;
  } catch {
    return new URL(fallback).origin;
  }
}

export function buildCsp(nonce: string, isDev: boolean): string {
  // The browser talks directly to these RPCs; nothing else is allowed for fetch/XHR/WebSocket.
  const rpcOrigins = [
    origin(process.env.NEXT_PUBLIC_TESTNET_RPC_URL, "https://rpc.testnet.chain.robinhood.com"),
    ...(process.env.NEXT_PUBLIC_ENABLE_MAINNET === "true"
      ? [origin(process.env.NEXT_PUBLIC_MAINNET_RPC_URL, "https://rpc.mainnet.chain.robinhood.com")]
      : []),
  ];
  // WalletConnect (Reown) relay, wallet registry images and verify frame, only when configured.
  const wc = !!process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  const wcConnect = wc
    ? " https://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.com wss://*.walletconnect.org https://*.reown.com wss://*.reown.com https://*.web3modal.org https://*.web3modal.com"
    : "";
  const wcImg = wc ? " https://*.walletconnect.com https://*.walletconnect.org https://*.reown.com" : "";
  const wcFrame = wc ? "https://verify.walletconnect.com https://verify.walletconnect.org https://secure.walletconnect.org https://*.reown.com" : "";
  const wcFont = wc ? " https://fonts.reown.com" : "";

  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets the pool's proof generator compile WebAssembly; it does not allow eval().
    // 'self' is a fallback for browsers without 'strict-dynamic'; modern browsers ignore it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    "worker-src 'self' blob:",
    // Inline styles stay allowed: the wallet modal sets them, and styles can't run code.
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
}

/** For responses the proxy doesn't handle (API routes, static files): nothing may run. */
export const LOCKED_DOWN_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
