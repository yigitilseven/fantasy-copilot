import { getDb } from "../src/db/client";
import { ensureDraftMeta, listDraftSummaries, setOpponentModelEnabled } from "../src/db/history";
import { bestKWithin } from "../src/engine/analysis";
import { runHistoryAnalysis, refitAndSave, loadAnalysisInputs, loadCleanDrafts, calibrationReport } from "../src/server/history-analysis";

/**
 * pnpm history:report [--draft=7,6] [--fit] [--enable] [--sims=25000]
 *   Prints per-round deviation, autopick share by team, positional runs, calibration (reliability + Brier) and, with --fit,
 *   fits + stores the opponent model (k, autopickShare); --enable also turns it on for the simulator.
 */
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const flag = (n: string) => process.argv.includes(`--${n}`);
const f = (x: number, d = 2) => x.toFixed(d);

const db = getDb();
for (const s of listDraftSummaries(db)) ensureDraftMeta(db, s.id); // classify every draft (kind) and fill draft_meta
console.log("Drafts:");
for (const s of listDraftSummaries(db)) {
  const ranks = Object.entries(s.ranks).map(([v, r]) => `${v}: #${r.rank} (${r.total})`).join(", ");
  console.log(`  #${s.id} ${s.createdAt.slice(0, 10)} ${s.kind.padEnd(10)} ${String(s.picks).padStart(3)}/${s.teams * s.rounds} slot ${s.userSlot}${ranks ? "  " + ranks : ""}`);
}
const ids = arg("draft")?.split(",").map(Number);
const sims = arg("sims") ? Number(arg("sims")) : undefined;
const a = runHistoryAnalysis(db, { ids, simulations: sims });
console.log(`\nClean yahoo-live drafts analysed: ${a.draftIds.join(", ")}  (${a.reach.n} real picks)`);

console.log("\nPer-round deviation (pick - ADP; negative = reach), % within 1 sigma of the model:");
console.log("  round    n    mean     sd   within1sigma");
for (const r of a.reach.byRound) console.log(`  ${String(r.round).padStart(5)} ${String(r.n).padStart(4)} ${f(r.mean).padStart(7)} ${f(r.sd).padStart(6)}   ${f(r.withinSigma * 100, 0)}%`);
console.log(`  overall within 1 sigma: ${f(a.reach.withinSigma * 100, 1)}%  (a calibrated model gives ~68%)`);
console.log("\nBiggest reaches: " + a.reach.reaches.slice(0, 6).map((d) => `${d.name} #${d.pick} (ADP ${f(d.adp, 1)}, ${f(d.deviation, 0)}) by ${d.teamName}`).join("; "));
console.log("Biggest steals:  " + a.reach.steals.slice(0, 6).map((d) => `${d.name} #${d.pick} (ADP ${f(d.adp, 1)}, +${f(d.deviation, 0)}) by ${d.teamName}`).join("; "));

console.log("\nAutopick-like share by team (pick == best available by ADP), flagged >= 60%:");
for (const d of a.autopick) {
  console.log(`  draft ${d.draftId}: ` + d.byTeam.map((t) => `${t.teamName}${t.isUser ? "*" : ""} ${f(t.share * 100, 0)}%${t.flagged ? "!" : ""}`).join(" | "));
}
console.log("\nPositional runs (>=3 of 5 consecutive picks share a position):");
for (const r of a.runs) console.log(`  draft ${r.draftId}: ${r.flagged}/${r.windows} windows; by position ${JSON.stringify(r.byPosition)}; rounds ` + r.byRound.filter((x) => x.flagged).map((x) => `${x.round}:${f(x.rate * 100, 0)}%`).join(" "));

const c = a.calibration;
console.log(`\nSurvival calibration (P(available at my next pick) for the top 30 available at each of my picks), n=${c.n}, Brier=${f(c.brier, 4)}`);
for (const d of c.perDraft) console.log(`  draft ${d.draftId}: n=${d.n} Brier=${f(d.brier, 4)}`);
console.log("  bucket       n   meanPred  observed");
for (const b of c.reliability) console.log(`  ${f(b.lo * 100, 0).padStart(3)}-${f(b.hi * 100, 0).padEnd(3)}% ${String(b.n).padStart(6)}   ${f(b.meanPredicted * 100, 1).padStart(6)}%  ${f(b.observedRate * 100, 1).padStart(6)}%`);

if (flag("fit")) {
  const fit = refitAndSave(db, { ids });
  console.log(`\nFitted opponent model on ${fit.n} opponent picks (drafts ${fit.draftIds.join(", ")}): k=${f(fit.k, 2)} autopickShare=${f(fit.autopickShare, 2)}  logLik ${f(fit.logLik, 1)} vs default ${f(fit.logLikDefault, 1)}`);
  const w = bestKWithin(fit);
  console.log(`  best k restricted to [0.5, 2.0]: ${f(w.k, 1)} (logLik ${f(w.logLik, 1)})`);
  console.log("  k:     " + fit.surface.map((s) => f(s.k, 1)).join(" "));
  console.log("  ll(a=0)" + fit.surface.map((s) => f(s.logLikNoAuto - fit.logLikDefault, 0)).join(" ") + "  (relative to default)");
  const { pool } = loadAnalysisInputs(db);
  const drafts = loadCleanDrafts(db, ids);
  const after = calibrationReport(drafts, pool, { simulations: sims, model: { k: fit.k, autopickShare: fit.autopickShare } });
  console.log(`  Brier with fitted model: ${f(after.brier, 4)} (default ${f(c.brier, 4)})`);
  if (flag("enable")) {
    setOpponentModelEnabled(db, true);
    console.log("  fitted model ENABLED for the simulator");
  }
}
