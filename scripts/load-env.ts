/**
 * Loads the committed public defaults (.env.production) and a local .env.local into
 * process.env without overriding anything already set. Import this first in scripts, before
 * anything that reads NEXT_PUBLIC_* at import time.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
for (const f of [".env.local", ".env.production"]) {
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
