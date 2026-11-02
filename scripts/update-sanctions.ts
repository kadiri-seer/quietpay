/**
 * Refreshes the bundled copy of OFAC-sanctioned EVM addresses (src/config/sanctioned-evm.json).
 * The approver fetches the live list at runtime; this copy is only the fallback when every live
 * source is unreachable. Run: npm run sanctions:update
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchLiveSanctions } from "../src/lib/screening/sanctions";

async function main() {
  const live = await fetchLiveSanctions();
  if (!live || live.addresses.length === 0) throw new Error("No live source answered; the bundled copy was not changed.");
  const out = { updatedAt: new Date().toISOString(), sources: live.sources, addresses: live.addresses };
  writeFileSync(join(__dirname, "..", "src", "config", "sanctioned-evm.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${live.addresses.length} addresses from ${live.sources.join(", ")}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
