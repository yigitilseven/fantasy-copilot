import type { PlayerRecord, PlayerScore, PlayerValuation, Position, RecommendationState } from "@/types";
import type { SortKey } from "@/store/draft-store";

export interface Row {
  score: PlayerScore;
  record: PlayerRecord;
  valuation: PlayerValuation | undefined;
  /** Rank in the engine's default (risk-adjusted) ordering. */
  rank: number;
}

const STATE_ORDER: Record<RecommendationState, number> = {
  DRAFT: 0, TAKE: 1, WAIT: 2, "RISKY WAIT": 3, AVOID: 4,
};

function sortValue(r: Row, k: SortKey): number | string {
  switch (k) {
    case "rank": return r.rank;
    case "name": return r.record.player.name;
    case "team": return r.record.player.nbaTeam;
    case "pos": return r.record.player.positions.join("/");
    case "nineCat": return r.score.nineCat;
    case "fit": return r.score.rosterFit;
    case "vorp": return r.score.vorp;
    case "risk": return r.score.riskScore;
    case "riskAdjusted": return r.score.riskAdjusted;
    case "adp": return r.record.market.yahooAdp;
    case "surv": return r.score.survival ?? -1;
    case "state": return STATE_ORDER[r.score.recommendation];
  }
}

export function buildRows(
  scores: PlayerScore[],
  recordById: Record<string, PlayerRecord>,
  valuations: Record<string, PlayerValuation>,
  opts: { search: string; position: Position | null; sortKey: SortKey; sortDir: "asc" | "desc" },
): Row[] {
  const q = opts.search.trim().toLowerCase();
  const rows: Row[] = [];
  scores.forEach((score, i) => {
    const record = recordById[score.playerId];
    if (!record) return;
    if (opts.position && !record.player.positions.includes(opts.position)) return;
    if (q && !record.player.name.toLowerCase().includes(q) && !record.player.nbaTeam.toLowerCase().includes(q)) return;
    rows.push({ score, record, valuation: valuations[score.playerId], rank: i + 1 });
  });
  const dir = opts.sortDir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const x = sortValue(a, opts.sortKey);
    const y = sortValue(b, opts.sortKey);
    const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
    return c * dir || a.rank - b.rank;
  });
  return rows;
}
