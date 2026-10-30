import { ROTO_CATEGORIES } from "../evaluation/standings";
import type { RotoAnalysis } from "./expected";
import { OPT_VIEWS, VIEW_LABELS, displayCat, type OptView } from "./lines";

/** UI/overlay-ready summary of a baseline finish (JSON-serializable; category keys use the app's names: 3PM, STL). */
export interface StandingsOutlook {
  kind: "h2h" | "roto";
  sims: number;
  userPicksLeft: number;
  views: Record<OptView, { rank: number; points: number; winProb: number; catsWon: number; beats: number; pTop5: number }>;
  weakest: OptView;
  h2h: {
    winProb: number;
    minWinProb: number;
    catsWon: number;
    beats: number;
    opponents: number;
    core: string[];
    punted: string[];
    /** Average P(win) per category (app names). */
    catP: Record<string, number>;
  };
  /** "Projected finish: Proj #4 · Total #3 · Avg #5" */
  finishLine: string;
  /** "Weekly outlook: wins ~6.1 cats · beats 9/13 teams" */
  weeklyLine: string;
}

export function outlookOf(a: RotoAnalysis, teams: number): StandingsOutlook {
  const views = {} as StandingsOutlook["views"];
  for (const v of OPT_VIEWS) {
    const x = a.baseline.views[v];
    views[v] = { rank: x.rankMedian, points: Math.round(x.points * 10) / 10, winProb: x.winProb, catsWon: x.catsWon, beats: x.beats, pTop5: x.pTop5 };
  }
  const h = a.baseline.h2h;
  const catP: Record<string, number> = {};
  for (const c of ROTO_CATEGORIES) catP[displayCat(c)] = Math.round(h.catP[c] * 1000) / 1000;
  const opponents = teams - 1;
  return {
    kind: a.objective.kind,
    sims: a.sims,
    userPicksLeft: a.userPicksLeft,
    views,
    weakest: a.baseline.weakest,
    h2h: { winProb: h.winProb, minWinProb: h.minWinProb, catsWon: h.catsWon, beats: h.beats, opponents, core: h.core.map(displayCat), punted: h.punted.map(displayCat), catP },
    finishLine: `Projected finish: ${OPT_VIEWS.map((v) => `${VIEW_LABELS[v]} #${views[v].rank}`).join(" · ")}`,
    weeklyLine: `Weekly outlook: wins ~${h.catsWon.toFixed(1)} cats · beats ${Math.round(h.beats)}/${opponents} teams`,
  };
}
