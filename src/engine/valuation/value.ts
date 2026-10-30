import type { Category, CategoryScores, PlayerRecord, PlayerValuation, ValuationContext } from "@/types";
import { CATEGORIES } from "@/types";
import { leagueConfig } from "@/config/default-league";
import { fgImpact, ftImpact, leagueRates } from "./percentages";
import { mean, stdDev, zScore } from "./zscore";

/** Raw per-game stat (or impact) for a category, before standardization. */
function rawStat(r: PlayerRecord, cat: Category, fgPct: number, ftPct: number): number {
  const p = r.projection;
  switch (cat) {
    case "PTS": return p.pts;
    case "3PM": return p.threePm;
    case "REB": return p.reb;
    case "AST": return p.ast;
    case "STL": return p.stl;
    case "BLK": return p.blk;
    case "TO": return p.tov;
    case "FG%": return fgImpact(p, fgPct);
    case "FT%": return ftImpact(p, ftPct);
  }
}

/**
 * Usage-neutral turnovers. The plain TO z (inverted) rewards low-usage players: turnovers grow with the ball-handling load, so a
 * low-usage big looks "good" in TO simply because he rarely has the ball, which pads his 9-cat sum and hides his weakness in PTS/AST.
 * With `usageAdjustTO` the TO z is computed on the RESIDUAL of an OLS fit tov ~ a + b·(pts + ast) over the valuation pool (expected TO
 * given the player's scoring + passing volume), standardized by the residual sd, inverted (fewer TO than expected = positive) and scaled by
 * `toEmphasis` (default 0.6): z_TO = -toEmphasis · (tov - (a + b·(pts+ast))) / sd_resid. Roto/H2H still count raw TO fully; this only
 * corrects the per-player z layer (nineCat / roster fit), where the standings objective takes over the exact accounting.
 */
export const TO_EMPHASIS = 0.6;
export interface ValuationOptions {
  poolSize?: number;
  usageAdjustTO?: boolean;
  toEmphasis?: number;
}

export function computeValuations(
  records: PlayerRecord[],
  opts: ValuationOptions = {},
): { valuations: Record<string, PlayerValuation>; context: ValuationContext } {
  const poolSize = opts.poolSize ?? leagueConfig.teams * leagueConfig.rounds;
  const pool = [...records].sort((a, b) => a.market.rank - b.market.rank).slice(0, poolSize);
  const { fgPct, ftPct } = leagueRates(pool.map((r) => r.projection));

  const means: Record<string, number> = {};
  const stdDevs: Record<string, number> = {};
  for (const cat of CATEGORIES) {
    const xs = pool.map((r) => rawStat(r, cat, fgPct, ftPct));
    means[cat] = mean(xs);
    stdDevs[cat] = stdDev(xs, means[cat]);
  }

  // usage-neutral TO: tov ~ a + b (pts + ast)
  let toFit: { a: number; b: number; sd: number } | null = null;
  if (opts.usageAdjustTO && pool.length > 2) {
    const xs = pool.map((r) => r.projection.pts + r.projection.ast);
    const ys = pool.map((r) => r.projection.tov);
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
    }
    const b = sxx > 0 ? sxy / sxx : 0;
    const a = my - b * mx;
    const sd = stdDev(xs.map((x, i) => ys[i] - (a + b * x)), 0);
    toFit = { a, b, sd };
  }
  const toEmphasis = opts.toEmphasis ?? TO_EMPHASIS;

  const valuations: Record<string, PlayerValuation> = {};
  for (const r of records) {
    const z = {} as CategoryScores;
    let total = 0;
    for (const cat of CATEGORIES) {
      let v = zScore(rawStat(r, cat, fgPct, ftPct), means[cat], stdDevs[cat]);
      if (cat === "TO") {
        v = toFit ? -toEmphasis * zScore(r.projection.tov, toFit.a + toFit.b * (r.projection.pts + r.projection.ast), toFit.sd) : -v;
      }
      if (v === 0) v = 0; // normalize -0
      z[cat] = v;
      total += v;
    }
    valuations[r.player.id] = { playerId: r.player.id, z, nineCat: total };
  }

  return {
    valuations,
    context: {
      poolIds: pool.map((r) => r.player.id),
      means,
      stdDevs,
      leagueFgPct: fgPct,
      leagueFtPct: ftPct,
    },
  };
}
