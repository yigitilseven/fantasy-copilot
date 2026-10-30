import { CATEGORIES, type Category, type CategoryScores, type DraftPick, type PlayerValuation } from "@/types";

export interface H2HResult {
  slot: number;
  won: number;
  lost: number;
  tied: number;
}

export interface StandingsEstimate {
  /** Sum of per-player z-scores per category, per team slot (TO already inverted: higher = better). */
  totals: Record<number, CategoryScores>;
  /** Our rank (1 = best) in each category among all teams. */
  ranks: Record<Category, number>;
  /** Categories won/lost/tied vs every other team (9 categories each). */
  h2h: H2HResult[];
  /** Projected H2H category win rate: (won + tied/2) / (9 * opponents). */
  winRate: number;
}

const EPS = 1e-9;

/** Rough league standings from draft picks and 9-cat z-scores (category totals; no schedule). */
export function estimateStandings(
  picks: DraftPick[],
  teams: number,
  userSlot: number,
  valuations: Record<string, PlayerValuation>,
): StandingsEstimate {
  const totals: Record<number, CategoryScores> = {};
  for (let t = 1; t <= teams; t++) {
    totals[t] = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as CategoryScores;
  }
  for (const p of picks) {
    const v = valuations[p.playerId];
    const row = totals[p.teamSlot];
    if (!v || !row) continue;
    for (const c of CATEGORIES) row[c] += v.z[c];
  }
  const mine = totals[userSlot];
  const ranks = {} as Record<Category, number>;
  for (const c of CATEGORIES) {
    let better = 0;
    for (let t = 1; t <= teams; t++) if (t !== userSlot && totals[t][c] > mine[c] + EPS) better++;
    ranks[c] = better + 1;
  }
  const h2h: H2HResult[] = [];
  let score = 0;
  for (let t = 1; t <= teams; t++) {
    if (t === userSlot) continue;
    const r: H2HResult = { slot: t, won: 0, lost: 0, tied: 0 };
    for (const c of CATEGORIES) {
      const d = mine[c] - totals[t][c];
      if (Math.abs(d) <= EPS) r.tied++;
      else if (d > 0) r.won++;
      else r.lost++;
    }
    score += r.won + r.tied / 2;
    h2h.push(r);
  }
  const opp = Math.max(1, teams - 1);
  return { totals, ranks, h2h, winRate: score / (CATEGORIES.length * opp) };
}
