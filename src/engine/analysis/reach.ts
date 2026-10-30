import { mean, sd } from "./stats";
import { isRealPlayer, teamLabel, type AnalysisDraft, type AnalysisPlayer } from "./types";

export interface PickDeviation {
  draftId: number;
  pick: number;
  round: number;
  teamSlot: number;
  teamName: string;
  playerId: string;
  name: string;
  adp: number;
  sigma: number;
  /** pick - ADP: negative = reach (taken earlier than ADP), positive = fall / steal. */
  deviation: number;
  /** deviation / sigma. */
  z: number;
}

/** Deviation of every pick from ADP (ADP at pick time if recorded, else the current ADP). Placeholders are skipped. */
export function pickDeviations(drafts: AnalysisDraft[], players: Map<string, AnalysisPlayer>): PickDeviation[] {
  const out: PickDeviation[] = [];
  for (const d of drafts) {
    for (const k of d.picks) {
      const p = players.get(k.playerId);
      if (!isRealPlayer(p)) continue;
      const adp = k.adpAtPick != null && k.adpAtPick < 900 ? k.adpAtPick : p.adp;
      const sigma = Math.max(0.5, p.adpStdDev);
      out.push({
        draftId: d.id, pick: k.pick, round: k.round, teamSlot: k.teamSlot, teamName: teamLabel(d, k.teamSlot),
        playerId: p.id, name: p.name, adp, sigma, deviation: k.pick - adp, z: (k.pick - adp) / sigma,
      });
    }
  }
  return out;
}

export interface RoundDeviation {
  round: number;
  n: number;
  mean: number;
  sd: number;
  /** Share of picks with |pick - ADP| <= k * sigma(player). A calibrated model gives ~0.68. */
  withinSigma: number;
}

/** Per-round distribution of the deviation; `k` scales the model sigma (1 = the app's current model). */
export function deviationByRound(devs: PickDeviation[], k = 1): RoundDeviation[] {
  const rounds = [...new Set(devs.map((d) => d.round))].sort((a, b) => a - b);
  return rounds.map((round) => {
    const xs = devs.filter((d) => d.round === round);
    return {
      round,
      n: xs.length,
      mean: mean(xs.map((x) => x.deviation)),
      sd: sd(xs.map((x) => x.deviation)),
      withinSigma: xs.filter((x) => Math.abs(x.deviation) <= k * x.sigma).length / xs.length,
    };
  });
}

export function overallWithinSigma(devs: PickDeviation[], k = 1): number {
  return devs.length ? devs.filter((x) => Math.abs(x.deviation) <= k * x.sigma).length / devs.length : 0;
}

/** Biggest reaches (most negative deviation) and steals (most positive), by raw pick distance. */
export function biggestReachesSteals(devs: PickDeviation[], n = 10): { reaches: PickDeviation[]; steals: PickDeviation[] } {
  const sorted = devs.slice().sort((a, b) => a.deviation - b.deviation);
  return { reaches: sorted.slice(0, n), steals: sorted.slice(-n).reverse() };
}
