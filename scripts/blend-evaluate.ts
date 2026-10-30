/**
 * pnpm blend:evaluate [--draft=7] [--db=data/fantasy.sqlite] [--no-fp]: scores a recorded draft with the roto evaluator under every projection view
 * (Yahoo 2026-27 proj, 2025-26 averages, 2025-26 totals, fixed 0.6 blend, auto per-player blend) and runs a what-if: at each of the
 * user's picks the recommender is re-run on the recorded state under (a) the old global 0.6 mix (no disagreement handling) and (b) the
 * auto per-player mix with round-aware disagreement; the user then takes the recommended player (first DRAFT, else TAKE; players the
 * hypothetical roster already holds are skipped), everyone else's picks stay as recorded. The hypothetical rosters are scored under
 * the same views. Works on a read-only snapshot of the database; never writes to it.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../src/db/client";
import { getAllPlayerRecords, getDraft, undoToPick, updateDraftStrategy } from "../src/db/repository";
import { computeEvaluation, computeOutlook, type EvalView } from "../src/server/evaluation";
import { computeRecommendations } from "../src/server/recommendations";

function arg(name: string, def: string): string {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}

const draftId = Number(arg("draft", "7"));
const src = path.resolve(arg("db", "data/fantasy.sqlite"));
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "blend-eval-")), "copy.sqlite");
const live = new Database(src, { readonly: true, fileMustExist: true });
fs.writeFileSync(tmp, live.serialize());
live.close();
const db = createDb(tmp); // mutated by the what-if replay (undoToPick)
const tmp2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "blend-eval-")), "copy.sqlite");
fs.copyFileSync(tmp, tmp2);
const dbEval = createDb(tmp2); // pristine: every standings table is computed from the full recorded draft

const draft = getDraft(dbEval, draftId);
if (!draft) throw new Error(`draft ${draftId} not found`);
const useFp = !process.argv.includes("--no-fp");
const recs = getAllPlayerRecords(dbEval, Date.now(), { withComponents: true, fantasyPros: useFp });
const name = new Map(recs.map((r) => [r.player.id, r.player.name]));
console.log(`projection side: ${useFp ? "average(Yahoo, FantasyPros) where both exist" : "Yahoo only"}`);
const VIEWS: [EvalView, string, number?][] = [["proj", "Yahoo 2026-27 proj"], ["avg", "2025-26 averages"], ["total", "2025-26 totals"], ["blend", "fixed 0.6 blend", 0.6], ["auto", "auto per-player blend"]];

function row(label: string, roster?: string[]) {
  const cells = VIEWS.map(([v, , w]) => {
    const e = computeEvaluation(dbEval, draftId, { view: v, weight: w, records: recs, userRoster: roster })!;
    return `#${e.you!.rank} (${e.you!.total} pts)`.padEnd(15);
  });
  console.log(label.padEnd(34) + cells.join(" "));
}

console.log(`Draft ${draftId}: ${draft.teams} teams, user slot ${draft.userSlot}, ${draft.picks.length} picks\n`);
console.log("Recorded roster, your roto rank (points) by projection view".padEnd(34) + VIEWS.map(([, l]) => l.padEnd(16)).join(""));
row("recorded roster");
const outlook = computeOutlook(dbEval, draftId, { weight: 0.6, records: recs })!;
console.log("sweep (fixed weights): " + outlook.sweep.map((s) => `${Math.round(s.weight * 100)}%:#${s.rank}`).join("  ") + `   auto:#${outlook.views.auto?.rank}\n`);

// ---- what-if
const userPicks = draft.picks.filter((p) => p.teamSlot === draft.userSlot).map((p) => p.pick);
const strategies = {
  old: { projectionWeight: 0.6, projectionMode: "fixed" as const, robustnessMode: "never" as const },
  auto: { projectionMode: "auto" as const, robustnessMode: "auto" as const },
};
type Pick = { pick: number; round: number; actual: string; rec: Record<keyof typeof strategies, { first: string; draftList: string[] }> };
const turns: Pick[] = [];
for (const n of [...userPicks].reverse()) {
  undoToPick(db, draftId, n); // state with pick n on the clock (picks > n removed as we walk backwards)
  const actual = draft.picks.find((p) => p.pick === n)!.playerId;
  const rec = {} as Pick["rec"];
  for (const k of Object.keys(strategies) as (keyof typeof strategies)[]) {
    updateDraftStrategy(db, draftId, strategies[k]);
    const r = computeRecommendations(db, draftId, { limit: 40, fantasyPros: useFp })!;
    const draftList = r.top.filter((t) => t.state === "DRAFT").map((t) => t.playerId);
    const take = r.top.filter((t) => t.state === "TAKE").map((t) => t.playerId);
    const ordered = [...draftList, ...take, ...r.top.map((t) => t.playerId)];
    rec[k] = { first: ordered[0], draftList: [...new Set(ordered)] };
  }
  turns.unshift({ pick: n, round: draft.picks.find((p) => p.pick === n)!.round, actual, rec });
}
console.log("What-if: recommended player at each of your picks (first DRAFT, else TAKE) under the old global 0.6 vs auto");
console.log("pick".padEnd(6) + "actual".padEnd(24) + "old 0.6".padEnd(26) + "auto");
for (const t of turns) console.log(`${t.pick}`.padEnd(6) + (name.get(t.actual) ?? t.actual).padEnd(24) + (name.get(t.rec.old.first) ?? "").padEnd(26) + (name.get(t.rec.auto.first) ?? ""));

console.log("\nHypothetical rosters (you take the recommendation at every turn; conflicts skipped; others as recorded)");
console.log("".padEnd(34) + VIEWS.map(([, l]) => l.padEnd(16)).join(""));
row("actual roster", turns.map((t) => t.actual));
for (const k of Object.keys(strategies) as (keyof typeof strategies)[]) {
  const roster: string[] = [];
  for (const t of turns) {
    const pick = t.rec[k].draftList.find((id) => !roster.includes(id)) ?? t.actual;
    roster.push(pick);
  }
  row(k === "old" ? "old global 0.6 recommendations" : "auto per-player recommendations", roster);
  console.log("   " + roster.map((id) => name.get(id)).join(", "));
}
