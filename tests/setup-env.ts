/**
 * Tests never talk to the real Redis. Vercel exposes its Upstash credentials during the build, and
 * tests counting against shared keys would both write into production data and see counts left
 * over from earlier builds. Every test uses the in-memory stores instead.
 */
for (const k of Object.keys(process.env)) {
  if (/(^|_)(KV_REST_API_(URL|TOKEN|READ_ONLY_TOKEN)|KV_URL|REDIS_URL|UPSTASH_REDIS_REST_(URL|TOKEN))$/.test(k)) delete process.env[k];
}
