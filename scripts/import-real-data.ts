import path from "node:path";
import { defaultCacheDir, runRealImport } from "../src/integrations/projections/real-data";

const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
}

if (arg("help")) {
  console.log(`pnpm data:import [options]
  --refresh              refetch everything (default: use data/cache/ when present)
  --offline              never use the network; cache and --*-file inputs only
  --season=2025-26       latest completed season (prior = previous one)
  --stats-source=auto|nba|bbref|file   auto = NBA.com, then Basketball-Reference
  --stats-file=<path>    NBA.com JSON or NBA.com-style CSV (implies file); --prior-stats-file=<path> for the prior season
  --adp-file=<path>      saved FantasyPros / Hashtag HTML, or CSV with name,adp[,team,pos]
  --limit=250            players kept (top N by ADP)
  --no-include-unranked  skip players that have NBA stats but no FantasyPros ADP (default: include them after the ADP list)
  --min-gp=10 --min-min=12   stats-only players need this many GP / MPG in the latest or prior season
  --timeout=30000 --retries=3
  --dry-run              parse and report, write nothing
  --data-dir=data`);
  process.exit(0);
}

async function main() {
  const log = (m: string) => console.log(m);
  const dataDir = path.resolve(process.cwd(), arg("data-dir") ?? "data");
  const season = arg("season") ?? "2025-26";
  const m = /^(\d{4})-(\d{2})$/.exec(season);
  if (!m) throw new Error("--season must look like 2025-26");
  const endYear = Number(m[1]) + 1;
  const statsSource = (arg("stats-source") ?? "auto") as "auto" | "nba" | "bbref" | "file";
  if (!["auto", "nba", "bbref", "file"].includes(statsSource)) throw new Error("--stats-source must be auto|nba|bbref|file");

  const s = await runRealImport({
    dataDir,
    cacheDir: defaultCacheDir(dataDir),
    endYear,
    statsSource,
    statsFile: arg("stats-file"),
    priorStatsFile: arg("prior-stats-file"),
    adpFile: arg("adp-file"),
    refresh: Boolean(arg("refresh")),
    offline: Boolean(arg("offline")),
    timeoutMs: Number(arg("timeout") ?? 30_000),
    retries: Number(arg("retries") ?? 3),
    limit: Number(arg("limit") ?? 250),
    dryRun: Boolean(arg("dry-run")),
    includeUnranked: !arg("no-include-unranked") && arg("include-unranked") !== "false",
    minGp: arg("min-gp") !== undefined ? Number(arg("min-gp")) : undefined,
    minMin: arg("min-min") !== undefined ? Number(arg("min-min")) : undefined,
    log,
  });
  const d = s.dataset;
  const c = d.counts;
  console.log(`\nStats provider: ${s.stats.provider} (latest ${s.stats.latest.length} rows, prior ${s.stats.prior.length} rows)`);
  console.log(`ADP source: ${s.adpSource}${s.adpUsedAverage ? ` (${s.adpUsedAverage} rows used the site average: no Yahoo value)` : ""}`);
  for (const n of [...s.stats.notes, ...s.adpNotes]) console.log(`  note: ${n}`);
  console.log(`Universe ${c.universe}, written ${d.projections.length}, skipped ${d.skipped.length}`);
  console.log(`  sources: blend ${c.nba_stats_blend}, latest ${c.nba_stats_latest}, prior ${c.nba_stats_prior}, existing_csv ${c.existing_csv}, adp_template ${c.adp_template}; ids reused ${c.reusedIds}`);
  console.log(`  stats-only (unranked) players added: ${c.unranked}${c.unrankedSkipped ? `, skipped for thin sample: ${c.unrankedSkipped}` : ""}`);
  console.log(`  positions from: ${Object.entries(c.positionsFrom).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const k of d.skipped) console.log(`  skipped: ${k.name} (${k.reason})`);
  console.log(`ADP players without latest-season stats (${d.adpUnmatched.length}):`);
  for (const u of d.adpUnmatched) console.log(`  ${u.name} (ADP ${u.adp}) -> ${u.resolvedAs}`);
  console.log(`Stats players (>=15 GP, >=15 MPG) not in ADP (${d.statsUnmatched.length}), top 25 by PPG:`);
  console.log("  " + d.statsUnmatched.slice(0, 25).map((x) => `${x.name} (${x.team ?? "?"}, ${x.pts.toFixed(1)})`).join("; "));
  console.log("Note: injury status is NOT live. current_status/injury history/major-injury/rest-risk are carried from the previous CSV (new players: healthy / 1 - availability / false / 0.1).");
  if (arg("dry-run")) console.log("Dry run: no files written.");
  else console.log(`${s.backupDir ? `Backed up previous CSVs to ${s.backupDir}\n` : ""}Wrote projections.csv, yahoo-adp.csv, injuries.csv, projection-sources.csv in ${dataDir}\nNext: pnpm db:seed`);
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
