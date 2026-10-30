import type { Db } from "@/db/client";
import { getAllPlayerRecords, getDraft } from "@/db/repository";
import { DEFAULT_PROJECTION_WEIGHT, blendedLineOf, normalizeProjectionWeight } from "@/engine/projection/blend";
import { computeStandings, totalsOf, type StandingsTeam, type TeamStanding, type TotalsLine } from "@/engine/evaluation/standings";
import type { PlayerRecord } from "@/types";

/**
 * Which projection set the rosters are scored on:
 *  proj  = Yahoo 2026-27 projected season totals ("2026-27 Proj Stats")
 *  total = real 2025-26 season totals ("2025-26 Total Stats")
 *  avg   = real 2025-26 per-game averages, summed over the roster ("2025-26 Average Stats")
 *  blend = w x Yahoo + (1 - w) x 2025-26, as season totals (games blended too)
 *  auto  = the per-player rate/volume blend (engine/projection/blend.ts v2), as season totals
 * ("Yahoo" in proj/blend is the projection side: Yahoo; average(Yahoo, FantasyPros) only when opted in.)
 */
export const EVAL_VIEWS = ["proj", "total", "avg", "blend", "auto"] as const;
export type EvalView = (typeof EVAL_VIEWS)[number];
export const SWEEP_WEIGHTS = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;

export interface EvaluationResponse {
  draftId: number;
  view: EvalView;
  /** Yahoo weight of the blend view (echoed for every view). */
  weight: number;
  teams: number;
  userSlot: number;
  picks: number;
  standings: TeamStanding[];
  /** Standings row of the user's team. */
  you: TeamStanding | null;
}

export interface OutlookResponse {
  draftId: number;
  userSlot: number;
  /** The draft's projection mix: "auto" (per-player rate/volume blend) or "fixed" at `weight`. */
  mode: "auto" | "fixed";
  weight: number;
  /** The user's rank / rank-points total under each view. */
  views: Record<EvalView, { rank: number; total: number } | null>;
  /** Blended rank for w = 0, 0.2, ... 1 (fixed weights; the auto blend is views.auto). */
  sweep: { weight: number; rank: number; total: number }[];
  teams: number;
}

function lineFor(r: PlayerRecord | undefined, view: EvalView, w: number): TotalsLine | null {
  const c = r?.projection.components;
  if (!c) return null;
  switch (view) {
    case "proj": return c.yahoo ? totalsOf(c.yahoo, "total") : null;
    case "total": return c.actual ? totalsOf(c.actual, "total") : null;
    case "avg": return c.actual ? totalsOf(c.actual, "avg") : null;
    case "blend": {
      const b = blendedLineOf(r, w);
      return b ? totalsOf(b.line, "total") : null;
    }
    case "auto": {
      const b = blendedLineOf(r, "auto");
      return b ? totalsOf(b.line, "total") : null;
    }
  }
}

export function rostersOf(db: Db, draftId: number): { teams: StandingsTeam[]; userSlot: number; picks: number } | null {
  const d = getDraft(db, draftId);
  if (!d) return null;
  const teams: StandingsTeam[] = Array.from({ length: d.teams }, (_, i) => ({
    id: i + 1,
    label: i + 1 === d.userSlot ? "Your Team" : `Team ${i + 1}`,
    playerIds: [],
  }));
  for (const p of d.picks) teams[p.teamSlot - 1]?.playerIds.push(p.playerId);
  return { teams, userSlot: d.userSlot, picks: d.picks.length };
}

/** Null when the draft does not exist. */
export function computeEvaluation(
  db: Db,
  draftId: number,
  opts: { view?: EvalView; weight?: number; records?: PlayerRecord[]; /** What-if: score this player-id list as the user's roster instead of the recorded one. */ userRoster?: string[] } = {},
): EvaluationResponse | null {
  const ro = rostersOf(db, draftId);
  if (!ro) return null;
  if (opts.userRoster) ro.teams[ro.userSlot - 1].playerIds = [...opts.userRoster];
  const view = opts.view ?? "blend";
  const weight = normalizeProjectionWeight(opts.weight ?? DEFAULT_PROJECTION_WEIGHT);
  const byId = new Map((opts.records ?? getAllPlayerRecords(db, Date.now(), { withComponents: true })).map((r) => [r.player.id, r]));
  const standings = computeStandings(ro.teams, (id) => lineFor(byId.get(id), view, weight), { decimals: view === "avg" ? { "3PTM": 1, PTS: 1, REB: 1, AST: 1, ST: 1, BLK: 1, TO: 1 } : undefined });
  return {
    draftId, view, weight, teams: ro.teams.length, userSlot: ro.userSlot, picks: ro.picks, standings,
    you: standings.find((s) => s.id === ro.userSlot) ?? null,
  };
}

/** The user's rank under each view plus the blended rank for w = 0, 0.2 ... 1. Null when the draft does not exist. */
export function computeOutlook(db: Db, draftId: number, opts: { weight?: number; mode?: "auto" | "fixed"; records?: PlayerRecord[] } = {}): OutlookResponse | null {
  const records = opts.records ?? getAllPlayerRecords(db, Date.now(), { withComponents: true });
  const weight = normalizeProjectionWeight(opts.weight ?? DEFAULT_PROJECTION_WEIGHT);
  const one = (view: EvalView, w = weight) => computeEvaluation(db, draftId, { view, weight: w, records });
  const first = one("proj");
  if (!first) return null;
  const pick = (e: EvaluationResponse | null) => (e?.you ? { rank: e.you.rank, total: e.you.total } : null);
  return {
    draftId,
    userSlot: first.userSlot,
    mode: opts.mode ?? "auto",
    weight,
    teams: first.teams,
    views: { proj: pick(first), total: pick(one("total")), avg: pick(one("avg")), blend: pick(one("blend")), auto: pick(one("auto")) },
    sweep: SWEEP_WEIGHTS.map((w) => {
      const y = pick(one("blend", w));
      return { weight: w, rank: y?.rank ?? first.teams, total: y?.total ?? 0 };
    }),
  };
}
