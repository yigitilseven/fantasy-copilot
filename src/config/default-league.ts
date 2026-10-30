import type { Category, RosterSlot } from "@/types";

export const leagueConfig = {
  teams: 14,
  rounds: 13,
  userSlot: 13,

  categories: ["PTS", "3PM", "REB", "AST", "STL", "BLK", "FG%", "FT%", "TO"] as Category[],

  /** Yahoo default 13-man roster. */
  rosterSlots: ["PG", "SG", "G", "SF", "PF", "F", "C", "C", "UTIL", "UTIL", "BN", "BN", "BN"] as RosterSlot[],

  /** Injured-list slots (Yahoo NBA default-ish). Match your league: players currently out can be stashed here in late rounds. */
  ilSlots: 2,

  /** 0 = ignore injury risk, 1 = maximally risk-averse. 0.30 = conservative. */
  riskTolerance: 0.3,

  simulations: 25_000,

  /** Draft Score weights (sum of positives = 1). */
  weights: {
    nineCat: 0.3,
    rosterFit: 0.25,
    vorp: 0.15,
    scarcity: 0.1,
    adpValue: 0.1,
    flexibility: 0.1,
  },

  /** Need-weight bounds: category weights stay within [min, max]. */
  needWeightBounds: { min: 0.6, max: 1.4 },

  /** Recommendation thresholds. */
  thresholds: {
    /** Survival below this → must act now. */
    draftNowSurvival: 0.35,
    /** Survival above this → safe to wait. */
    safeWaitSurvival: 0.7,
    /** Risk score ≥ this → AVOID candidate under conservative profile. */
    avoidRisk: 70,
    /** How many top candidates are eligible for DRAFT/TAKE. */
    topCandidates: 8,
  },
} as const;

export type LeagueConfig = typeof leagueConfig;
