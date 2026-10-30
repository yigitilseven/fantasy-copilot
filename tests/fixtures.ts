import type { PlayerRecord, Position } from "@/types";

type Partial3 = {
  id?: string;
  name?: string;
  positions?: Position[];
  age?: number;
  projection?: Partial<PlayerRecord["projection"]>;
  market?: Partial<PlayerRecord["market"]>;
  risk?: Partial<PlayerRecord["risk"]>;
};

let counter = 0;

/** Reusable PlayerRecord factory; sensible average-ish defaults, deep-merged per section. */
export function makeRecord(partial: Partial3 = {}): PlayerRecord {
  const id = partial.id ?? `p${++counter}`;
  return {
    player: {
      id,
      yahooPlayerKey: null,
      name: partial.name ?? id,
      nbaTeam: "TST",
      positions: partial.positions ?? ["SF"],
      age: partial.age ?? 26,
    },
    projection: {
      playerId: id, games: 75, minutes: 30, pts: 15, fgm: 5.5, fga: 12, ftm: 3, fta: 4,
      threePm: 1.5, reb: 5, ast: 3, stl: 1, blk: 0.5, tov: 2, ...partial.projection,
    },
    market: { playerId: id, yahooAdp: 50, adpStdDev: 5, rank: 50, ...partial.market },
    risk: {
      playerId: id, projectedGames: 75, currentStatus: "healthy", injuryHistoryScore: 0.1,
      restRisk: 0.1, availabilityScore: 0.9, majorInjuryHistory: false,
      updatedAt: "2026-10-01T00:00:00Z", ...partial.risk,
    },
  };
}
