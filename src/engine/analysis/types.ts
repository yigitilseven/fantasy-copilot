import type { Position } from "@/types";

/** Everything the analytics need about a player (no DB / Yahoo types). */
export interface AnalysisPlayer {
  id: string;
  name: string;
  positions: Position[];
  /** Current Yahoo ADP / sigma / rank from player_market. */
  adp: number;
  adpStdDev: number;
  rank: number;
  /** 9-cat value (tiny tiebreak in the opponent model). */
  value: number;
}

export interface AnalysisPick {
  pick: number;
  round: number;
  teamSlot: number;
  playerId: string;
  /** ADP recorded when the pick was ingested (draft_pick_context); absent for older drafts. */
  adpAtPick?: number | null;
}

export interface AnalysisDraft {
  id: number;
  teams: number;
  rounds: number;
  userSlot: number;
  picks: AnalysisPick[];
  /** Yahoo team name by team slot (1-based). */
  teamNames: Record<number, string>;
}

/**
 * ADP above this is not a market signal: stats-only fillers get a synthetic ADP (max + k) and Yahoo placeholders sit at 999.
 * Picks of such players are excluded from the behaviour statistics and the model fit (a truncation; reported in the UI).
 */
export const MAX_BEHAVIOR_ADP = 300;

export const isRealPlayer = (p: AnalysisPlayer | undefined): p is AnalysisPlayer => !!p && p.adp <= MAX_BEHAVIOR_ADP && !p.id.startsWith("yahoo-unknown");

export const teamLabel = (d: AnalysisDraft, slot: number): string => d.teamNames[slot] ?? `Team ${slot}`;

export const PLAYER_MAP = (players: AnalysisPlayer[]): Map<string, AnalysisPlayer> => new Map(players.map((p) => [p.id, p]));
