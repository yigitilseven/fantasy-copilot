import path from "node:path";
import { createYahooGet } from "../src/integrations/yahoo/client";
import { loadEnvLocal } from "../src/integrations/yahoo/config";
import { isYahooError } from "../src/integrations/yahoo/errors";
import { probeProjections, runImport, type SourceFlag } from "../src/integrations/yahoo/import";

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
}

async function main() {
  loadEnvLocal();
  const get = createYahooGet();
  const log = (m: string) => console.log(m);

  if (arg("probe")) {
    const { game, results } = await probeProjections(get, 3, log);
    console.log(`game_key=${game.gameKey} season=${game.season}`);
    for (const r of results) {
      console.log(`\n${r.name} (${r.playerKey}) usable=${r.usable}${r.error ? ` error=${r.error}` : ""}`);
      if (r.rawStats) for (const [id, v] of Object.entries(r.rawStats)) console.log(`  stat ${id}: ${v}`);
      else console.log("  (no stats returned)");
    }
    const ok = results.filter((r) => r.usable).length;
    console.log(`\nprojected_season usable for ${ok}/${results.length} -> auto mode would use ${ok >= 2 ? "yahoo_projected" : "last_season"}`);
    return;
  }

  const source = (arg("source") ?? "auto") as SourceFlag;
  if (!["projected", "last_season", "auto"].includes(source)) throw new Error("--source must be projected|last_season|auto");
  const limit = Number(arg("limit") ?? 300);
  const dryRun = Boolean(arg("dry-run"));
  const dataDir = path.resolve(process.cwd(), arg("data-dir") ?? "data");

  const s = await runImport({ get, dataDir, source, limit, dryRun, log });
  const d = s.dataset;
  console.log(`\nStat source: ${s.sourceUsed === "projected" ? "yahoo_projected" : "last_season"} (scales: ${s.statScales.join(", ") || "n/a"})`);
  console.log(`Players fetched ${s.counts.fetched}, written ${s.counts.written}, skipped ${d.skipped.length}`);
  console.log(`  projected-sourced ${d.stats.fromProjected}, last-season-sourced ${d.stats.fromLastSeason}, existing-csv-sourced ${d.stats.fromExistingCsv}, adp-template-sourced ${d.stats.fromAdpTemplate}, ADP fallback ${d.stats.adpFallback}, ids reused ${d.stats.reusedIds}, age defaulted ${d.stats.ageDefaulted}`);
  for (const k of d.skipped.slice(0, 40)) console.log(`  skipped: ${k.name} (${k.reason})`);
  if (dryRun) console.log("Dry run: no files written.");
  else console.log(`${s.backupDir ? `Backed up previous CSVs to ${s.backupDir}\n` : ""}Wrote projections.csv, yahoo-adp.csv, injuries.csv, projection-sources.csv in ${dataDir}\nNext: pnpm db:seed`);
}

main().catch((e) => {
  console.error(isYahooError(e) ? `[${e.code}] ${e.message}` : `Error: ${(e as Error).message}`);
  process.exit(1);
});
