/*
 * QuietPay service worker. Its only jobs are making the site installable and showing a clear
 * message when the device is offline. It caches nothing: every request goes to the network, so
 * an installed app always runs the latest code and never serves stale balances.
 */
const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline | QuietPay</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#d4d4d4;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}
@media (prefers-color-scheme:light){body{background:#f5f5f4;color:#2b2b2b}}h1{font-size:22px;margin:0 0 8px}button{margin-top:16px;min-height:44px;padding:0 20px;border-radius:10px;border:1px solid currentColor;background:none;color:inherit;font:inherit;font-weight:600}</style>
</head><body><main><h1>You're offline</h1><p>QuietPay needs a connection to read the chain. Nothing was sent.</p><button onclick="location.reload()">Try again</button></main></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return; // everything else: browser default
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE_HTML, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }),
    ),
  );
});
