import type { ProjectionLine } from "@/types";

/**
 * Yahoo-style roto standings for a set of rosters (pure; no DB).
 *
 * Categories (Yahoo order): FG%, FT%, 3PTM, PTS, REB, AST, ST, BLK, TO. Counting stats are summed over the roster, FG%/FT% are
 * Σmakes/Σattempts (never an average of percentages) and TO is "lower is better". With N teams the best team in a category gets N
 * points, the worst 1; tied teams share the average of the points they span (two teams tied for 1st of 14: 14 and 13 -> 13.5 each),
 * which is how Yahoo produces 3.5 / 8.5 style totals. A team's total is the sum over the nine categories; overall rank is by total
 * (descending, competition ranking: 1, 2, 2, 4).
 *
 * Values are compared after rounding to the precision Yahoo displays (`decimals`), because Yahoo ties on the displayed value. The
 * default precision is 3 for percentages and 0 for totals; pass 1 for per-game "average" tables.
 */
export const ROTO_CATEGORIES = ["FG%", "FT%", "3PTM", "PTS", "REB", "AST", "ST", "BLK", "TO"] as const;
export type RotoCategory = (typeof ROTO_CATEGORIES)[number];
export type RotoStats = Record<RotoCategory, number>;

/** Season totals (or per-game values summed, for the "average" view) of one player. */
export interface TotalsLine {
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  threePm: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
}

export const EMPTY_TOTALS: TotalsLine = { fgm: 0, fga: 0, ftm: 0, fta: 0, threePm: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 };

/** "total": per-game x games (season totals). "avg": per-game values as they are (Yahoo's "Average Stats" view sums them). */
export function totalsOf(line: ProjectionLine, mode: "total" | "avg" = "total"): TotalsLine {
  const g = mode === "total" ? line.games : 1;
  return { fgm: line.fgm * g, fga: line.fga * g, ftm: line.ftm * g, fta: line.fta * g, threePm: line.threePm * g, pts: line.pts * g, reb: line.reb * g, ast: line.ast * g, stl: line.stl * g, blk: line.blk * g, tov: line.tov * g };
}

export function sumTotals(lines: Iterable<TotalsLine>): TotalsLine {
  const t = { ...EMPTY_TOTALS };
  for (const l of lines) for (const k of Object.keys(t) as (keyof TotalsLine)[]) t[k] += l[k];
  return t;
}

export function rotoStats(t: TotalsLine): RotoStats {
  return {
    "FG%": t.fga > 0 ? t.fgm / t.fga : 0,
    "FT%": t.fta > 0 ? t.ftm / t.fta : 0,
    "3PTM": t.threePm, PTS: t.pts, REB: t.reb, AST: t.ast, ST: t.stl, BLK: t.blk, TO: t.tov,
  };
}

export interface StandingsTeam {
  id: string | number;
  label?: string;
  playerIds: string[];
}

export interface TeamStanding {
  id: string | number;
  label: string;
  /** Roster players that contributed a line (the rest had no data in this view). */
  players: number;
  rosterSize: number;
  stats: RotoStats;
  /** Rank points per category (N = best ... 1 = worst, ties averaged). */
  points: RotoStats;
  total: number;
  /** Overall rank by total (1 = best, competition ranking). */
  rank: number;
}

export interface StandingsOptions {
  /** Display decimals per category used for tie detection (default: 3 for FG%/FT%, 0 otherwise). */
  decimals?: Partial<Record<RotoCategory, number>>;
}

const defaultDecimals = (c: RotoCategory) => (c === "FG%" || c === "FT%" ? 3 : 0);

/** Rank points for one category: higher value is better unless `lowerIsBetter`; ties share the average of their points. */
export function rankPoints(values: number[], lowerIsBetter = false): number[] {
  const n = values.length;
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => (lowerIsBetter ? b.v - a.v : a.v - b.v)); // worst first
  const pts = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1].v === order[i].v) j++;
    const avg = (i + 1 + (j + 1)) / 2; // points span i+1..j+1
    for (let k = i; k <= j; k++) pts[order[k].i] = avg;
    i = j + 1;
  }
  return pts;
}

const roundTo = (x: number, d: number) => Math.round((x + Number.EPSILON) * 10 ** d) / 10 ** d;

/** Standings from per-team stats (already summed). Exposed so a stored Yahoo table can be re-ranked directly. */
export function standingsFromStats(
  teams: { id: string | number; label?: string; players?: number; rosterSize?: number; stats: RotoStats }[],
  opts: StandingsOptions = {},
): TeamStanding[] {
  const points = teams.map(() => ({}) as RotoStats);
  for (const c of ROTO_CATEGORIES) {
    const d = opts.decimals?.[c] ?? defaultDecimals(c);
    const p = rankPoints(teams.map((t) => roundTo(t.stats[c], d)), c === "TO");
    p.forEach((v, i) => (points[i][c] = v));
  }
  const rows: TeamStanding[] = teams.map((t, i) => ({
    id: t.id,
    label: t.label ?? String(t.id),
    players: t.players ?? 0,
    rosterSize: t.rosterSize ?? 0,
    stats: t.stats,
    points: points[i],
    total: ROTO_CATEGORIES.reduce((s, c) => s + points[i][c], 0),
    rank: 0,
  }));
  for (const r of rows) r.rank = 1 + rows.filter((o) => o.total > r.total + 1e-9).length;
  return rows;
}

/**
 * Standings for rosters. `lineOf` returns a player's totals for the view being evaluated (null = no data: contributes nothing,
 * exactly like a player Yahoo shows no stats for). Rosters may have different sizes (an incomplete draft).
 */
export function computeStandings(teams: StandingsTeam[], lineOf: (playerId: string) => TotalsLine | null, opts: StandingsOptions = {}): TeamStanding[] {
  return standingsFromStats(
    teams.map((t) => {
      const lines = t.playerIds.map(lineOf).filter((l): l is TotalsLine => l !== null);
      return { id: t.id, label: t.label, players: lines.length, rosterSize: t.playerIds.length, stats: rotoStats(sumTotals(lines)) };
    }),
    opts,
  );
}
