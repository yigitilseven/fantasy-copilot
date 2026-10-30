/**
 * pnpm standings:backtest [--drafts=7,9] [--variants=classic,h2h,...] [--sims=120] [--survival=3000] [--db=data/fantasy.sqlite] [--verbose]
 *
 * Replays recorded drafts (everyone else's picks fixed as recorded; see engine/standings-opt/replay.ts for the conflict rule): at each of
 * the user's picks the engine recommends from the replayed state (DRAFT player of the full recommendation pipeline: classic scores +
 * standings dimension + survival) and the user takes it. The final team is then judged against the 13 real opponents with
 *   - the Yahoo roto evaluator per view (proj 2026-27 / total 2025-26 / avg 2025-26) -> rank,
 *   - the weekly H2H model (engine/standings-opt/h2h.ts): average matchup win probability, expected categories won per week, rank among
 *     the 14 teams by round-robin win probability, core categories.
 * Works on a read-only snapshot of the database and never writes to it.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../src/db/client";
import { activeOpponentModel } from "../src/db/history";
import { getAllPlayerRecords, getDraft } from "../src/db/repository";
import { buildSimPlayers, buildSurvivalInput, simulateSurvival } from "../src/engine";
import { applyProjectionBlend } from "../src/engine/projection/blend";
import { sourceZ } from "../src/engine/projection/disagreement";
import { scoreWithRoto } from "../src/engine/recommendation/with-roto";
import { makeStrategy, valuationOptionsOf } from "../src/engine/recommendation/strategy";
import { computeValuations } from "../src/engine/valuation/value";
import { H2H_PARAMS, MAX_TOTAL_PARAMS, ROBUST_PARAMS, type ObjectiveMode, type ObjectiveParams } from "../src/engine/standings-opt/objective";
import { displayCat, viewLinesOf } from "../src/engine/standings-opt/lines";
import { evaluateRosters, replayDraft, type TeamReport } from "../src/engine/standings-opt/replay";
import { simSeed } from "../src/store/derived";

function arg(name: string, def: string): string {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}
const flag = (n: string) => process.argv.includes(`--${n}`);

export interface Variant {
  name: string;
  mode: ObjectiveMode;
  objective?: ObjectiveParams;
  rotoWeight?: number;
  /** Plain z for turnovers (no usage-neutral residual / 0.6 emphasis) even though the objective is a standings one. */
  noToFix?: boolean;
}
const VARIANTS: Variant[] = [
  { name: "classic", mode: "classic" },
  { name: "max-total", mode: "max-total" },
  { name: "robust", mode: "robust" },
  { name: "h2h", mode: "h2h" },
  { name: "h2h w=.7", mode: "h2h", rotoWeight: 0.7 },
  { name: "h2h w=.3", mode: "h2h", rotoWeight: 0.3 },
  { name: "h2h mu0", mode: "h2h", objective: { ...H2H_PARAMS, mu: 0 } },
  { name: "h2h mu1", mode: "h2h", objective: { ...H2H_PARAMS, mu: 1 } },
  { name: "h2h nu0", mode: "h2h", objective: { ...H2H_PARAMS, nu: 0 } },
  { name: "h2h nu1.5", mode: "h2h", objective: { ...H2H_PARAMS, nu: 1.5 } },
  { name: "robust w=.7", mode: "robust", rotoWeight: 0.7 },
  { name: "robust mu0 nu3", mode: "robust", objective: { ...ROBUST_PARAMS, mu: 0, nu: 3 } },
  { name: "max-total w=.7", mode: "max-total", rotoWeight: 0.7 },
  { name: "h2h w=.2", mode: "h2h", rotoWeight: 0.2 },
  { name: "h2h w=.6", mode: "h2h", rotoWeight: 0.6 },
  { name: "h2h w=.85", mode: "h2h", rotoWeight: 0.85 },
  { name: "h2h w=1", mode: "h2h", rotoWeight: 1 },
  { name: "h2h noTOfix", mode: "h2h", noToFix: true },
  { name: "h2h mu0 nu0", mode: "h2h", objective: { ...H2H_PARAMS, mu: 0, nu: 0 } },
  { name: "h2h mu.25", mode: "h2h", objective: { ...H2H_PARAMS, mu: 0.25 } },
  { name: "h2h nu2", mode: "h2h", objective: { ...H2H_PARAMS, nu: 2 } },
];
void MAX_TOTAL_PARAMS;

const src = path.resolve(arg("db", "data/fantasy.sqlite"));
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "standings-bt-")), "copy.sqlite");
const live = new Database(src, { readonly: true, fileMustExist: true });
fs.writeFileSync(tmp, live.serialize());
live.close();
const db = createDb(tmp);

const sims = Number(arg("sims", "120"));
const survSims = Number(arg("survival", "3000"));
const draftIds = arg("drafts", "7,9").split(",").map(Number);
const wanted = arg("variants", "");
const variants = wanted ? VARIANTS.filter((v) => wanted.split(",").includes(v.name)) : VARIANTS;
const verbose = flag("verbose");
const seedOffset = Number(arg("seed", "0"));

const raw = getAllPlayerRecords(db, Date.now(), { withComponents: true });
const rawById = new Map(raw.map((r) => [r.player.id, r]));
const name = new Map(raw.map((r) => [r.player.id, r.player.name]));
const lineCache = new Map<string, Float64Array>();
const lineOf = (id: string) => {
  let l = lineCache.get(id);
  if (!l) {
    const r = rawById.get(id);
    if (!r) return null;
    l = viewLinesOf(r);
    lineCache.set(id, l);
  }
  return l;
};
const model = activeOpponentModel(db);
const sources = sourceZ(raw);

function runVariant(draftId: number, v: Variant): { report: TeamReport; picks: string[]; ms: number } {
  const d = getDraft(db, draftId)!;
  const strategy = makeStrategy("balanced", undefined, undefined, { objective: v.mode });
  const records = applyProjectionBlend(raw, "auto");
  const valuations = computeValuations(records, v.noToFix ? {} : valuationOptionsOf(strategy)).valuations;
  const t0 = Date.now();
  const res = replayDraft({
    teams: d.teams, rounds: d.rounds, userSlot: d.userSlot, picks: d.picks,
    universe: raw.map((r) => r.player.id), adpOf: (id) => rawById.get(id)?.market.yahooAdp ?? 999,
    choose: (st) => {
      const drafted = new Set(st.draftedIds);
      const players = buildSimPlayers(records.filter((r) => !drafted.has(r.player.id)).map((r) => ({
        id: r.player.id, adp: r.market.yahooAdp, adpStdDev: r.market.adpStdDev, value: valuations[r.player.id]?.nineCat ?? 0, positions: r.player.positions,
      })));
      const built = buildSurvivalInput({ currentPick: st.currentPick, teams: d.teams, userSlot: d.userSlot, rounds: d.rounds, players, simulations: survSims, seed: simSeed(draftId, st.currentPick), model });
      const survival = built ? simulateSurvival(built.input).survival : null;
      const out = scoreWithRoto(
        {
          records, valuations, draftedIds: st.draftedIds, userRosterIds: st.userRosterIds, currentPick: st.currentPick,
          config: { teams: d.teams, ...(v.rotoWeight !== undefined ? { rotoWeight: v.rotoWeight } : {}) }, rounds: d.rounds,
          userNextPick: built?.targetPick ?? null, isUserOnClock: true, survival, strategy, sources,
        },
        { teams: d.teams, rounds: d.rounds, userSlot: d.userSlot, rosters: st.rosters, model, seed: simSeed(draftId, st.currentPick) + seedOffset, sims, objective: v.objective },
        v.mode,
      );
      const pick = out.scores.find((s) => s.recommendation === "DRAFT") ?? out.scores[0];
      return pick.playerId;
    },
  });
  return { report: evaluateRosters(res.rosters, d.userSlot - 1, lineOf), picks: res.userPicks, ms: Date.now() - t0 };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
function row(label: string, r: TeamReport, extra = "") {
  const rk = (v: "proj" | "total" | "avg") => `#${r.roto[v].rank}`.padEnd(4);
  console.log(
    `| ${label.padEnd(16)} | ${rk("proj")} | ${rk("total")} | ${rk("avg")} | ${String(r.worstRotoRank).padEnd(2)} ${r.allTop5 ? "Y" : " "} | ${pct(r.winProb).padEnd(6)} | ${r.catsWon.toFixed(2)} | #${String(r.h2hRank).padEnd(4)} | ${r.core.map(displayCat).join(" ").padEnd(26)} |${extra}`,
  );
}

const summary = new Map<string, { win: number; cats: number; n: number; top5: number; worst: number; h2hRank: number }>();
const note = (label: string, r: TeamReport) => {
  const x = summary.get(label) ?? { win: 0, cats: 0, n: 0, top5: 0, worst: 0, h2hRank: 0 };
  x.win += r.winProb; x.cats += r.catsWon; x.n++; x.top5 += r.allTop5 ? 1 : 0; x.worst += r.worstRotoRank; x.h2hRank += r.h2hRank;
  summary.set(label, x);
};

for (const id of draftIds) {
  const d = getDraft(db, id);
  if (!d) throw new Error(`draft ${id} not found`);
  console.log(`\n### Draft ${id} (${d.teams} teams, slot ${d.userSlot}, ${d.picks.length} picks recorded)`);
  console.log("| variant          | proj | total | avg | worst top5 | H2H win | cats/wk | H2H rk | core cats |");
  console.log("|------------------|------|-------|-----|------------|---------|---------|--------|-----------|");
  const actual = replayDraft({
    teams: d.teams, rounds: d.rounds, userSlot: d.userSlot, picks: d.picks, universe: raw.map((r) => r.player.id), adpOf: () => 0,
    choose: (st) => d.picks.find((p) => p.pick === st.currentPick)!.playerId,
  });
  const actualReport = evaluateRosters(actual.rosters, d.userSlot - 1, lineOf);
  row("ACTUAL (drafted)", actualReport);
  note("ACTUAL (drafted)", actualReport);
  if (verbose) console.log("   " + actual.userPicks.map((p) => name.get(p)).join(", "));
  for (const v of variants) {
    const { report, picks, ms } = runVariant(id, v);
    row(v.name, report, verbose ? ` ${(ms / 1000).toFixed(0)}s` : "");
    note(v.name, report);
    if (verbose) console.log("   " + picks.map((p) => name.get(p)).join(", "));
  }
}

console.log(`\n### Summary over drafts ${draftIds.join(",")} (seed offset ${seedOffset}, ${sims} completions)`);
console.log("| variant          | mean H2H win | cats/wk | all-top5 drafts | mean worst roto rank | mean H2H rank |");
console.log("|------------------|--------------|---------|-----------------|----------------------|---------------|");
for (const [label, x] of summary) console.log(`| ${label.padEnd(16)} | ${pct(x.win / x.n).padEnd(12)} | ${(x.cats / x.n).toFixed(2)}    | ${x.top5}/${x.n}             | ${(x.worst / x.n).toFixed(2).padEnd(20)} | ${(x.h2hRank / x.n).toFixed(2)}          |`);
