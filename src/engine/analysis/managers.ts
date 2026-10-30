import type { Position } from "@/types";
import { detectAutopicks } from "./autopick";
import { pickDeviations } from "./reach";
import { mean, sd } from "./stats";
import { isRealPlayer, teamLabel, type AnalysisDraft, type AnalysisPlayer } from "./types";

export interface ManagerStats {
  name: string;
  drafts: number;
  picks: number;
  avgDeviation: number;
  sdDeviation: number;
  autopickShare: number;
  /** Share of this manager's picks carrying each position (multi-position players count once per position). */
  positions: Record<Position, number>;
  topPosition: Position | null;
}

const POS: Position[] = ["PG", "SG", "SF", "PF", "C"];

/** Per Yahoo team name across the given (clean) drafts. The user's own team is included (name from the Board header). */
export function managerStats(drafts: AnalysisDraft[], players: Map<string, AnalysisPlayer>): ManagerStats[] {
  const devs = pickDeviations(drafts, players);
  const acc = new Map<string, { drafts: Set<number>; devs: number[]; auto: number; autoN: number; pos: Record<Position, number>; n: number }>();
  const get = (name: string) => {
    let a = acc.get(name);
    if (!a) acc.set(name, (a = { drafts: new Set(), devs: [], auto: 0, autoN: 0, pos: { PG: 0, SG: 0, SF: 0, PF: 0, C: 0 }, n: 0 }));
    return a;
  };
  for (const d of drafts) {
    const ap = detectAutopicks(d, players);
    for (const k of d.picks) {
      const p = players.get(k.playerId);
      if (!isRealPlayer(p)) continue;
      const a = get(teamLabel(d, k.teamSlot));
      a.drafts.add(d.id);
      a.n++;
      for (const q of p.positions) a.pos[q]++;
    }
    for (const t of ap.byTeam) {
      const a = get(t.teamName);
      a.auto += t.adpTop;
      a.autoN += t.picks;
    }
  }
  for (const dv of devs) get(dv.teamName).devs.push(dv.deviation);
  return [...acc].map(([name, a]) => {
    const positions = Object.fromEntries(POS.map((q) => [q, a.n ? a.pos[q] / a.n : 0])) as Record<Position, number>;
    const top = POS.slice().sort((x, y) => positions[y] - positions[x])[0];
    return {
      name, drafts: a.drafts.size, picks: a.n, avgDeviation: mean(a.devs), sdDeviation: sd(a.devs),
      autopickShare: a.autoN ? a.auto / a.autoN : 0, positions, topPosition: a.n ? top : null,
    };
  }).sort((x, y) => y.picks - x.picks || x.name.localeCompare(y.name));
}
