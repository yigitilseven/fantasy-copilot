import { num } from "./normalize";

/** Yahoo NBA stat ids (standard 9-cat league). */
export const STAT = {
  GP: "0",
  MIN: "2",
  FG_PCT: "5",
  FT_PCT: "8",
  THREE_PM: "10",
  PTS: "12",
  REB: "15",
  AST: "16",
  STL: "17",
  BLK: "18",
  TOV: "19",
  FGM_FGA: "9004003",
  FTM_FTA: "9007006",
} as const;

export interface PerGameLine {
  /** Games played in the sample the stats came from. */
  gp: number;
  /** null when Yahoo gave no minutes. */
  minutes: number | null;
  pts: number;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  threePm: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
}

/** "11.1/19.5" or "812/1431" → [made, attempted]. Returns null for "-" / malformed. */
export function parseMadeAtt(v: string | undefined): [number, number] | null {
  if (!v) return null;
  const m = /^\s*([\d.,]+)\s*\/\s*([\d.,]+)\s*$/.exec(v);
  if (!m) return null;
  const made = num(m[1]);
  const att = num(m[2]);
  return made === null || att === null ? null : [made, att];
}

export type StatScale = "totals" | "per_game";

/**
 * Season stats from Yahoo are expected to be totals, but the scale is not documented for NBA, so detect:
 * if total points per game would be implausibly small (< 1.5) for a player with >= 10 GP and < 45 pts,
 * the values are already per-game.
 */
export function detectScale(raw: Record<string, string>): StatScale {
  const gp = num(raw[STAT.GP]);
  const pts = num(raw[STAT.PTS]);
  if (gp !== null && pts !== null && gp >= 10 && pts < 45 && pts / gp < 1.5) return "per_game";
  return "totals";
}

export interface ConvertResult {
  line: PerGameLine | null;
  scale: StatScale;
  /** Why no line was produced. */
  reason?: string;
}

export const MIN_GP = 5;

/**
 * Raw stat-id map → per-game line.
 * totals ÷ GP when scale is "totals". "-" counting stats count as 0 (player had no such events) provided
 * points, shooting splits and GP are present; missing shooting splits or GP make the line unusable.
 */
export function statsToPerGame(raw: Record<string, string> | null | undefined, scale?: StatScale): ConvertResult {
  if (!raw) return { line: null, scale: "totals", reason: "no stats" };
  const sc = scale ?? detectScale(raw);
  const gp = num(raw[STAT.GP]);
  if (gp === null || gp < MIN_GP) return { line: null, scale: sc, reason: gp === null ? "no games played" : `only ${gp} GP` };
  const fg = parseMadeAtt(raw[STAT.FGM_FGA]);
  const ft = parseMadeAtt(raw[STAT.FTM_FTA]);
  const pts = num(raw[STAT.PTS]);
  if (!fg || !ft || pts === null) return { line: null, scale: sc, reason: "missing PTS/FG/FT" };
  if (fg[1] <= 0 || ft[1] <= 0) return { line: null, scale: sc, reason: "zero FGA/FTA" };
  const d = sc === "totals" ? gp : 1;
  const c = (id: string) => (num(raw[id]) ?? 0) / d;
  const min = num(raw[STAT.MIN]);
  return {
    scale: sc,
    line: {
      gp,
      minutes: min === null ? null : min / d,
      pts: pts / d,
      fgm: fg[0] / d,
      fga: fg[1] / d,
      ftm: ft[0] / d,
      fta: ft[1] / d,
      threePm: c(STAT.THREE_PM),
      reb: c(STAT.REB),
      ast: c(STAT.AST),
      stl: c(STAT.STL),
      blk: c(STAT.BLK),
      tov: c(STAT.TOV),
    },
  };
}

/** True when a projected_season response carries enough to build a line (used by --probe / auto). */
export function projectionUsable(raw: Record<string, string> | null | undefined): boolean {
  if (!raw) return false;
  const pts = num(raw[STAT.PTS]);
  const fg = parseMadeAtt(raw[STAT.FGM_FGA]);
  const ft = parseMadeAtt(raw[STAT.FTM_FTA]);
  return pts !== null && pts > 0 && !!fg && !!ft && num(raw[STAT.REB]) !== null;
}
