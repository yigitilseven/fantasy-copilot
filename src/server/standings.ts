import type { Db } from "@/db/client";
import { getAllPlayerRecords, getDraft } from "@/db/repository";
import { h2hTable } from "@/engine/standings-opt/h2h";
import { NF, OPT_VIEWS, VIEW_COUNT, VIEW_LABELS, displayCat, viewLinesOf, type OptView } from "@/engine/standings-opt/lines";
import { ROTO_CATEGORIES } from "@/engine/evaluation/standings";

export interface H2hTeamRow {
  slot: number;
  label: string;
  isUser: boolean;
  /** Means over the three views. */
  winProb: number;
  catsWon: number;
  beats: number;
  rank: number;
  /** Per view. */
  views: Record<OptView, { winProb: number; catsWon: number; beats: number; rank: number }>;
  /** Categories with average P(win) >= 0.6 (app names). */
  core: string[];
}
export interface H2hTableResponse {
  draftId: number;
  picks: number;
  teams: number;
  userSlot: number;
  viewLabels: Record<OptView, string>;
  rows: H2hTeamRow[];
}

/** Round-robin weekly H2H table of the CURRENT rosters (finished or not). Null when the draft does not exist. */
export function computeH2hTable(db: Db, draftId: number): H2hTableResponse | null {
  const d = getDraft(db, draftId);
  if (!d) return null;
  const records = new Map(getAllPlayerRecords(db, Date.now(), { withComponents: true }).map((r) => [r.player.id, r]));
  const stride = VIEW_COUNT * NF;
  const T = new Float64Array(d.teams * stride);
  for (const p of d.picks) {
    const r = records.get(p.playerId);
    if (!r) continue;
    const l = viewLinesOf(r);
    for (let k = 0; k < stride; k++) T[(p.teamSlot - 1) * stride + k] += l[k];
  }
  const tables = OPT_VIEWS.map((_, v) => h2hTable(T, d.teams, v));
  const mean = (f: (v: number) => number) => OPT_VIEWS.reduce((a, _, v) => a + f(v), 0) / VIEW_COUNT;
  const rows: H2hTeamRow[] = Array.from({ length: d.teams }, (_, t) => {
    const views = {} as H2hTeamRow["views"];
    OPT_VIEWS.forEach((view, v) => {
      const x = tables[v][t];
      views[view] = { winProb: x.winProb, catsWon: x.catsWon, beats: x.beats, rank: x.rank };
    });
    const core = ROTO_CATEGORIES.map((c, i) => ({ c, p: mean((v) => tables[v][t].catP[i]) })).filter((x) => x.p >= 0.6).map((x) => displayCat(x.c));
    return { slot: t + 1, label: t + 1 === d.userSlot ? "Your Team" : `Team ${t + 1}`, isUser: t + 1 === d.userSlot, winProb: mean((v) => tables[v][t].winProb), catsWon: mean((v) => tables[v][t].catsWon), beats: mean((v) => tables[v][t].beats), rank: 0, views, core };
  });
  for (const r of rows) r.rank = 1 + rows.filter((o) => o.winProb > r.winProb + 1e-12).length;
  return { draftId, picks: d.picks.length, teams: d.teams, userSlot: d.userSlot, viewLabels: VIEW_LABELS, rows };
}
