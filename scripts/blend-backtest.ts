/**
 * pnpm blend:backtest: how well does last season's production predict the next season's (NBA.com 2024-25 -> 2025-26, both
 * cached in data/cache), per player group, rates (per-36) vs volume (games, MPG)? Prints the evidence table and the Yahoo
 * weights the engine's DEFAULT_BLEND_WEIGHTS were calibrated from (src/engine/projection/blend.ts).
 *
 *   pnpm blend:backtest [--prev=2024-25] [--next=2025-26] [--min-gp=20] [--anchor=0.6] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { calibrate, formatBacktest, kappaForAnchor, runBacktest, type SeasonRow } from "../src/engine/projection/backtest";
import { DEFAULT_BLEND_WEIGHTS } from "../src/engine/projection/blend";
import { mapTeam } from "../src/integrations/yahoo/heuristics";

function arg(name: string, def: string): string {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}

export function readSeasonRows(file: string): SeasonRow[] {
  const rs = JSON.parse(fs.readFileSync(file, "utf8")).resultSets[0] as { headers: string[]; rowSet: unknown[][] };
  const ix = new Map(rs.headers.map((h, i) => [h, i]));
  const out: SeasonRow[] = [];
  for (const r of rs.rowSet) {
    const g = (k: string) => Number(r[ix.get(k) ?? -1]);
    const line = { games: g("GP"), minutes: g("MIN"), pts: g("PTS"), fgm: g("FGM"), fga: g("FGA"), ftm: g("FTM"), fta: g("FTA"), threePm: g("FG3M"), reb: g("REB"), ast: g("AST"), stl: g("STL"), blk: g("BLK"), tov: g("TOV") };
    if (Object.values(line).some((x) => !Number.isFinite(x)) || line.fga <= 0) continue;
    out.push({ id: String(r[ix.get("PLAYER_ID")!]), name: String(r[ix.get("PLAYER_NAME")!]), team: mapTeam(String(r[ix.get("TEAM_ABBREVIATION")!] ?? "")), age: Number.isFinite(g("AGE")) ? g("AGE") : null, line });
  }
  return out;
}

function main() {
  const dir = path.join(process.cwd(), "data", "cache");
  const prevS = arg("prev", "2024-25");
  const nextS = arg("next", "2025-26");
  const prev = readSeasonRows(path.join(dir, `nba-stats-${prevS}.json`));
  const next = readSeasonRows(path.join(dir, `nba-stats-${nextS}.json`));
  const res = runBacktest(prev, next, { minGp: Number(arg("min-gp", "20")) });
  const anchor = Number(arg("anchor", "0.6"));
  const opts = { kappa: kappaForAnchor(anchor), min: 0.3, max: 0.9 };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...res, calibration: calibrate(res, opts), opts }, null, 1));
    return;
  }
  console.log(`Backtest ${prevS} -> ${nextS}\n`);
  console.log(formatBacktest(res, opts));
  console.log(`\nCalibration: Yahoo error = kappa x pooled-regression error with kappa = ${opts.kappa.toFixed(3)} (anchored so the pooled group gets Yahoo weight ${anchor}); weights clamped to [${opts.min}, ${opts.max}].`);
  // Evidence (volume anchored at the agreed 0.80: volume is mostly role/health information that last season's numbers lack).
  const ev = new Map(calibrate(res, opts).map((x) => [x.id, x]));
  const evVol = new Map(calibrate(res, { ...opts, kappa: kappaForAnchor(0.8) }).map((x) => [x.id, x]));
  const D = DEFAULT_BLEND_WEIGHTS;
  const rows: [string, number, string, number | null][] = [
    ["young / rookie / 2nd-year", 0.85, "young", D.young], ["team or role change", 0.8, "team", D.change], ["injury return (wRate)", 0.8, "injury", D.injury],
    ["age 32+", 0.7, "age32", D.age32], ["stable veteran", 0.4, "stable", D.vet], ["everyone else", 0.6, "other", D.base],
  ];
  console.log("\nAdopted Yahoo weights = round-to-0.05(0.5 x agreed prior + 0.5 x evidence), clamped to [0.3, 0.9]:");
  console.log("rule".padEnd(28) + "prior".padStart(7) + "evidence".padStart(10) + "mix".padStart(7) + "in engine".padStart(11));
  for (const [label, prior, g, adopted] of rows) {
    const e = ev.get(g)!.wRate;
    console.log(label.padEnd(28) + prior.toFixed(2).padStart(7) + e.toFixed(2).padStart(10) + (0.5 * prior + 0.5 * e).toFixed(3).padStart(7) + String(adopted).padStart(11));
  }
  for (const [label, prior, g, adopted] of [["volume (everyone else)", 0.8, "all", D.vol], ["volume, injury return", 0.9, "injury", D.injuryVol]] as [string, number, string, number][]) {
    const e = evVol.get(g)!.wVol;
    console.log(label.padEnd(28) + prior.toFixed(2).padStart(7) + e.toFixed(2).padStart(10) + (0.5 * prior + 0.5 * e).toFixed(3).padStart(7) + String(adopted).padStart(11));
  }
  console.log("Yahoo's own historical accuracy cannot be measured offline: the evidence fixes only how groups differ from each other.");
  for (const k of [0.5, 1, 1.5]) {
    const w = calibrate(res, { ...opts, kappa: k });
    console.log(`  sensitivity kappa=${k}: ` + w.map((x) => `${x.id} ${x.wRate.toFixed(2)}/${x.wVol.toFixed(2)}`).join("  "));
  }
}
main();
