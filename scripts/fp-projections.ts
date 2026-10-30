/** pnpm data:fp-projections: fetches FantasyPros consensus 2026-27 season projections into data/cache (used by the projection blend). */
import path from "node:path";
import { fetchFantasyProsProjections, FP_PROJECTIONS_CACHE } from "../src/integrations/projections/fantasypros-projections";

async function main() {
  const refresh = !process.argv.includes("--cached");
  const { rows, fromCache } = await fetchFantasyProsProjections({ cacheDir: path.join(process.cwd(), "data", "cache"), refresh, offline: process.argv.includes("--offline"), log: (m) => console.log(m), retries: 2 });
  console.log(`${fromCache ? "cache" : "fetched"}: ${rows.length} players -> data/cache/${FP_PROJECTIONS_CACHE}`);
  for (const r of rows.slice(0, 5)) console.log(`  ${r.name.padEnd(26)} ${String(r.team).padEnd(4)} GP ${r.gp} MIN ${r.min} PTS ${r.pts} REB ${r.reb} AST ${r.ast}`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
