import type { CategoryScores, Position } from "@/types";

/**
 * Season mode (daily start/sit + add/drop). Everything under engine/season is pure: no DB, no network, no Next.js.
 * Stats travel as 11-number vectors in the order of standings-opt/lines.ts (fgm, fga, ftm, fta, 3pm, pts, reb, ast, stl, blk, tov).
 */
export type StatVec = number[];

/** Category order of the weekly H2H model (same as standings-opt: FG%, FT%, 3PM, PTS, REB, AST, STL, BLK, TO). */
export const SEASON_CATS = ["FG%", "FT%", "3PM", "PTS", "REB", "AST", "STL", "BLK", "TO"] as const;
export type SeasonCat = (typeof SEASON_CATS)[number];

export type LineupSlotName = "PG" | "SG" | "G" | "SF" | "PF" | "F" | "C" | "UTIL" | "BN" | "IL";
export const ACTIVE_SLOT_NAMES = ["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL"] as const;

export interface SeasonSettings {
  /** Active (starting) slots in Yahoo order. */
  rosterSlots: string[];
  benchSlots: number;
  ilSlots: number;
  /** Yahoo's weekly add limit (adds + waiver claims). */
  weeklyAddLimit: number;
  lineupLock: "daily" | "weekly";
  /** Number of playoff weeks at the end of the schedule (display / planning only). */
  playoffWeeks: number;
  /** IANA zone whose midnight rolls the "game day" over (Yahoo rolls at midnight Pacific). */
  timezone: string;
  /** Fetch the next pages of Yahoo's free-agent list with same-origin GETs (userscript toggle default; see extension README). */
  fetchFreeAgentPages: boolean;
}

export const DEFAULT_SEASON_SETTINGS: SeasonSettings = {
  rosterSlots: ["PG", "SG", "G", "SF", "PF", "F", "C", "C", "UTIL", "UTIL"],
  benchSlots: 3,
  ilSlots: 2,
  weeklyAddLimit: 4,
  lineupLock: "daily",
  playoffWeeks: 3,
  timezone: "America/Los_Angeles",
  fetchFreeAgentPages: true,
};

/** Availability as Yahoo / the news feed describes it. */
export type InjuryFlag = "healthy" | "gtd" | "out" | "ofs";

export interface InjuryInfo {
  flag: InjuryFlag;
  /** "Right ankle sprain". */
  injury?: string;
  /** First day he can play again (YYYY-MM-DD), when known. */
  estReturn?: string;
  /** Yahoo tag when it came from the roster page (O, INJ, DTD, GTD, IL, ...). */
  tag?: string;
  /** Short latest headline. */
  headline?: string;
}

/** Everything the season engines need about one player. Built by the server from PlayerRecord + news + roster tags. */
export interface SeasonPlayer {
  id: string;
  name: string;
  /** Canonical NBA team code (GSW, NOP, ...). */
  team: string;
  positions: Position[];
  /** Per-game line (blended "auto" projection). */
  line: StatVec;
  minutes: number;
  /** Fraction of scheduled games he plays when healthy (projected GP / 82, capped at 1). */
  avail: number;
  /** Per-game z-scores in the app's category order (TO inverted); nineCat = sum. */
  z: CategoryScores;
  nineCat: number;
  injury: InjuryInfo;
  /** Temporary usage bump (teammate out): multiplies the whole line until `until` (exclusive; null = 14 days from `from`). */
  boost?: { factor: number; until: string | null; reason: string };
}

export interface RosterEntry {
  playerId: string;
  /** Slot as Yahoo shows it (null = unknown). */
  slot: string | null;
  status: "active" | "bench" | "il";
}

export interface LineupContext {
  settings: SeasonSettings;
  /** team -> sorted YYYY-MM-DD game dates. Null = schedule unknown (3.5 games/week assumed). */
  schedule: Record<string, string[]> | null;
  /** The game day the lineup is for (YYYY-MM-DD). */
  today: string;
}
