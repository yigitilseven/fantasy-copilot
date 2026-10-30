import type { Market, Projection } from "../../types";

/**
 * Pure math for overlaying Yahoo's 2026-27 projections (captured from the draft room's Players tab) on a PlayerRecord.
 * No DB, no Yahoo access. Yahoo gives season TOTALS (GP, PTS, REB, ...) plus FG% and FT%, but no attempts. 9-cat FG%/FT% impact
 * needs per-game FGA/FTA, so they are derived:
 *
 *   points identity:  PTS = 2·FGM + 3PM + FTM      (a three is worth one extra point on top of the 2·FGM it already counts in)
 *   FGM = FGA·FG%,   FTM = FTA·FT%,   FTA = r·FGA   with r = last season's FTA/FGA (our NBA.com line), else LEAGUE_FTA_PER_FGA
 *   =>  FGA = (PTS - 3PM) / (2·FG% + r·FT%),   FTA = r·FGA,   FGM = FGA·FG%,   FTM = FTA·FT%
 *
 * so a player Yahoo projects to score more simply takes more shots at the shooting percentages Yahoo shows. If the identity gives an
 * implausible volume (FGA outside 0.4–1.4 per point, e.g. bad/zero percentages) the attempts-per-point ratio of our existing line
 * (else LEAGUE_FGA_PER_PT) is used instead.
 */
export const LEAGUE_FTA_PER_FGA = 0.3;
export const LEAGUE_FGA_PER_PT = 0.8;
const R_MIN = 0.05;
const R_MAX = 0.8;
const FGA_PER_PT_MIN = 0.4;
const FGA_PER_PT_MAX = 1.4;

export interface YahooProjectionStats {
  gp: number | null;
  fgPct: number | null;
  ftPct: number | null;
  threePm: number | null;
  pts: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  tov: number | null;
}

const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** A row can drive a projection only when GP > 0 and all nine category inputs are known. */
export function isUsableYahooProjection(y: YahooProjectionStats): boolean {
  return num(y.gp) && y.gp > 0 && num(y.fgPct) && num(y.ftPct) && num(y.threePm) && num(y.pts) && num(y.reb) && num(y.ast) && num(y.stl) && num(y.blk) && num(y.tov);
}

export interface DerivedAttempts {
  fga: number;
  fgm: number;
  fta: number;
  ftm: number;
  method: "identity" | "per-point";
}

/** Per-game attempts from per-game PTS/3PM and the shooting percentages (see the module doc). */
export function deriveAttempts(input: { ptsPg: number; threePmPg: number; fgPct: number; ftPct: number; base?: Pick<Projection, "pts" | "fga" | "fta"> | null }): DerivedAttempts {
  const { ptsPg, threePmPg, fgPct, ftPct, base } = input;
  const rBase = base && base.fga > 0 && base.fta >= 0 ? base.fta / base.fga : LEAGUE_FTA_PER_FGA;
  const r = Math.min(R_MAX, Math.max(R_MIN, rBase));
  const denom = 2 * fgPct + r * ftPct;
  let fga = denom > 0 && ptsPg > threePmPg ? (ptsPg - threePmPg) / denom : NaN;
  let method: DerivedAttempts["method"] = "identity";
  if (!(fga >= FGA_PER_PT_MIN * ptsPg && fga <= FGA_PER_PT_MAX * ptsPg) || !(fga > 0)) {
    const perPt = base && base.pts > 0 && base.fga > 0 ? base.fga / base.pts : LEAGUE_FGA_PER_PT;
    fga = ptsPg * Math.min(FGA_PER_PT_MAX, Math.max(FGA_PER_PT_MIN, perPt));
    method = "per-point";
  }
  const fta = r * fga;
  return { fga, fgm: fga * fgPct, fta, ftm: fta * ftPct, method };
}

/** Yahoo totals -> a per-game Projection (games = GP). `base` is our existing line, used for minutes and the FTA/FGA ratio. */
export function mergeYahooProjection(base: Projection, y: YahooProjectionStats): Projection | null {
  if (!isUsableYahooProjection(y)) return null;
  const g = y.gp!;
  const pg = (v: number | null) => v! / g;
  const att = deriveAttempts({ ptsPg: pg(y.pts), threePmPg: pg(y.threePm), fgPct: y.fgPct!, ftPct: y.ftPct!, base });
  return {
    playerId: base.playerId,
    games: g,
    minutes: base.minutes,
    pts: pg(y.pts),
    fgm: att.fgm,
    fga: att.fga,
    ftm: att.ftm,
    fta: att.fta,
    threePm: pg(y.threePm),
    reb: pg(y.reb),
    ast: pg(y.ast),
    stl: pg(y.stl),
    blk: pg(y.blk),
    tov: pg(y.tov),
    projectionSource: "yahoo-2026-27",
  };
}

/** True for rows that were created from a Yahoo sighting rather than a real ADP list. */
export function isPlaceholderMarket(playerId: string, m: Pick<Market, "yahooAdp">): boolean {
  return playerId.startsWith("yahoo-") || !(m.yahooAdp > 0) || m.yahooAdp >= 999;
}

/**
 * Yahoo's own draft-room ADP (captured from the Players table) always wins: the user drafts on Yahoo, and the imported
 * list (FantasyPros) disagreed badly on real drafts (e.g. Nesmith 41 vs Yahoo 112), which broke survival calibration.
 */
export function mergeYahooMarket(playerId: string, base: Market, yahooAdp: number | null | undefined): Market {
  if (!num(yahooAdp) || yahooAdp <= 0) return base;
  return { playerId: base.playerId, yahooAdp, adpStdDev: Math.min(22, 0.8 + 0.12 * yahooAdp), rank: Math.max(1, Math.round(yahooAdp)) };
}
