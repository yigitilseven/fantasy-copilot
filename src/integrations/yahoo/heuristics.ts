import type { InjuryStatus, Position } from "../../types";
import type { YahooPlayer } from "./normalize";

const POS: readonly Position[] = ["PG", "SG", "SF", "PF", "C"];

/** "Jaren Jackson Jr." → "jaren-jackson-jr"; "Luka Dončić" → "luka-doncic". Same scheme as the seed CSV ids. */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const TEAM_FIX: Record<string, string> = { GS: "GSW", NO: "NOP", NY: "NYK", SA: "SAS", PHO: "PHX", WSH: "WAS", UTAH: "UTA", BRK: "BKN", CHO: "CHA", NOR: "NOP" };

/** Yahoo abbreviations are mixed-case and sometimes 2 letters; the data set uses 3-letter caps. */
export function mapTeam(abbr: string | null): string | null {
  if (!abbr) return null;
  const up = abbr.trim().toUpperCase();
  return TEAM_FIX[up] ?? up;
}

/** eligible_positions filtered to PG/SG/SF/PF/C (drops G, F, Util, BN, IL…), original order, deduped. Falls back to display_position. */
export function mapPositions(p: Pick<YahooPlayer, "eligiblePositions" | "displayPosition">): Position[] {
  const pick = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toUpperCase()).filter((x): x is Position => (POS as readonly string[]).includes(x)))];
  const a = pick(p.eligiblePositions);
  if (a.length) return a;
  return pick((p.displayPosition ?? "").split(/[,/]/));
}

export function mapStatus(status: string | null, note: string | null): InjuryStatus {
  switch ((status ?? "").toUpperCase()) {
    case "":
    case "H":
      return "healthy";
    case "GTD":
    case "DTD":
      return "day-to-day";
    case "INJ":
      return /season|indefinite|acl|achilles/i.test(note ?? "") ? "out-for-season" : "out";
    case "O":
    case "NA":
    case "SUSP":
      return "out";
    default:
      return "healthy";
  }
}

/** Yahoo gives no variance. Assumption: spread grows with ADP, capped. */
export function adpStdDev(adp: number): number {
  return round(Math.min(22, 0.8 + 0.12 * adp), 2);
}

export function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

export interface AdpInput {
  key: string;
  /** Position in Yahoo's overall-rank (OR) order, 0-based. Tie-breaker + fallback driver. */
  orIndex: number;
  adp: number | null;
}
export interface AdpOutput {
  key: string;
  adp: number;
  stdDev: number;
  rank: number;
  fallback: boolean;
}

/**
 * Final ADP column.
 *  - players with "-" ADP are placed after the last drafted player: adp = maxAdp + 1.5 × k, k = 1,2,… in OR order
 *  - sorted by (adp, OR order); ties are separated by +0.01 so the sequence is strictly increasing
 *  - rank = 1-based position in that order
 */
export function assignAdp(inputs: AdpInput[]): AdpOutput[] {
  const present = inputs.filter((i) => i.adp !== null) as (AdpInput & { adp: number })[];
  const maxAdp = present.reduce((m, i) => Math.max(m, i.adp), 0);
  const missing = inputs.filter((i) => i.adp === null).sort((a, b) => a.orIndex - b.orIndex);
  const rows = [
    ...present.map((i) => ({ key: i.key, orIndex: i.orIndex, adp: i.adp, fallback: false })),
    ...missing.map((i, k) => ({ key: i.key, orIndex: i.orIndex, adp: maxAdp + 1.5 * (k + 1), fallback: true })),
  ].sort((a, b) => a.adp - b.adp || a.orIndex - b.orIndex);
  let prev = -Infinity;
  return rows.map((r, i) => {
    const adp = round(r.adp <= prev ? prev + 0.01 : r.adp, 2);
    prev = adp;
    return { key: r.key, adp, stdDev: adpStdDev(adp), rank: i + 1, fallback: r.fallback };
  });
}

export interface ExistingRisk {
  injuryHistoryScore: number;
  majorInjuryHistory: boolean;
  restRisk: number;
}

export interface RiskOutput {
  availabilityScore: number;
  projectedGames: number;
  currentStatus: InjuryStatus;
  injuryHistoryScore: number;
  majorInjuryHistory: boolean;
  restRisk: number;
}

const STATUS_GAMES_FACTOR: Record<InjuryStatus, number> = { healthy: 1, "day-to-day": 0.97, out: 0.8, "out-for-season": 0.2 };

/**
 * Heuristics (Yahoo has no injury history):
 *  availability = min(1, lastSeasonGP / 82)
 *  projected games = round(min(76, GP*0.6 + 70*0.4)), then × status factor (DTD .97, O/INJ/NA/SUSP .8, season-ending .2), min 10
 *  injury_history = 1 - availability, averaged with the existing CSV value when the player is already known
 *  major_injury_history / rest_risk: carried from the existing CSV, else false / 0.1
 */
export function deriveRisk(input: { lastSeasonGp: number; status: string | null; injuryNote: string | null; existing?: ExistingRisk | null }): RiskOutput {
  const availability = round(Math.min(1, Math.max(0, input.lastSeasonGp / 82)), 2);
  const currentStatus = mapStatus(input.status, input.injuryNote);
  const base = Math.min(76, input.lastSeasonGp * 0.6 + 70 * 0.4);
  const projectedGames = Math.max(10, Math.round(base * STATUS_GAMES_FACTOR[currentStatus]));
  const hist = 1 - availability;
  const ex = input.existing;
  return {
    availabilityScore: availability,
    projectedGames,
    currentStatus,
    injuryHistoryScore: round(Math.min(1, Math.max(0, ex ? (hist + ex.injuryHistoryScore) / 2 : hist)), 2),
    majorInjuryHistory: ex?.majorInjuryHistory ?? false,
    restRisk: ex?.restRisk ?? 0.1,
  };
}

/** Yahoo's NBA 9-cat stats carry no minutes; rough estimate from scoring so the (low-impact) column is populated. */
export function estimateMinutes(pts: number): number {
  return round(Math.min(38, Math.max(12, 14 + 0.7 * pts)), 1);
}
