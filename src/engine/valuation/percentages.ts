import type { Projection } from "@/types";

type Shooting = Pick<Projection, "fgm" | "fga" | "ftm" | "fta">;

/** Volume-weighted league shooting rates (sum made / sum attempted). */
export function leagueRates(projections: Projection[]): { fgPct: number; ftPct: number } {
  let fgm = 0, fga = 0, ftm = 0, fta = 0;
  for (const p of projections) {
    fgm += p.fgm; fga += p.fga; ftm += p.ftm; fta += p.fta;
  }
  return { fgPct: fga > 0 ? fgm / fga : 0, ftPct: fta > 0 ? ftm / fta : 0 };
}

/** (FG% - leagueFG%) * FGA, i.e. made-shot surplus over league baseline. */
export function fgImpact(p: Shooting, leagueFgPct: number): number {
  return p.fga > 0 ? (p.fgm / p.fga - leagueFgPct) * p.fga : 0;
}

/** (FT% - leagueFT%) * FTA. */
export function ftImpact(p: Shooting, leagueFtPct: number): number {
  return p.fta > 0 ? (p.ftm / p.fta - leagueFtPct) * p.fta : 0;
}
