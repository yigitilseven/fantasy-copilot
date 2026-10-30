/** pnpm news:update: fetch injuries + news, update the SQLite DB (DB_FILE_NAME or data/fantasy.sqlite) and print a summary. */
import { getDb } from "../src/db/client";
import { runNewsUpdate } from "../src/integrations/news/update";

async function main() {
  const db = getDb();
  const s = await runNewsUpdate(db, { log: (m) => console.log(m) });
  console.log("\nSources");
  for (const x of s.sources) console.log(`  ${x.ok ? "ok  " : "FAIL"} ${x.id.padEnd(18)} ${x.ok ? `${x.items} ${x.kind === "injuries" ? "injury rows" : "headlines"}` : x.error}`);
  console.log(`\nStatus changes: ${s.statusChanges.length} players (${s.statusRowsInserted} rows written, ${s.cleared} cleared; ${s.unmatchedInjuryRows} injury rows not in our DB)`);
  for (const c of s.statusChanges) {
    const f = (x: { status: string; estReturn?: string }) => `${x.status}${x.estReturn ? ` (return ${x.estReturn})` : ""}`;
    console.log(`  ADP ${c.adp.toFixed(1).padStart(5)}  ${c.name.padEnd(26)} ${f(c.before)} -> ${f(c.after)}${c.after.source ? `  [${c.after.source}${c.after.injury ? `, ${c.after.injury}` : ""}]` : ""}`);
  }
  console.log(`\nNews: ${s.newsInserted} new item(s) attached to ${s.newsPlayers} player(s)`);
  if (!s.sources.some((x) => x.ok)) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
