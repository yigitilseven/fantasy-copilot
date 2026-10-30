import type { Position } from "@/types";
import { isRealPlayer, type AnalysisDraft, type AnalysisPlayer } from "./types";

export interface PositionalRun {
  position: Position;
  startPick: number;
  endPick: number;
  /** Picks inside [startPick, endPick] that carry the position. */
  count: number;
}

export interface RunStats {
  /** Windows of `window` consecutive picks examined. */
  windows: number;
  /** Windows in which >= `min` picks share a position. */
  flagged: number;
  byRound: { round: number; windows: number; flagged: number; rate: number }[];
  byPosition: Partial<Record<Position, number>>;
  runs: PositionalRun[];
}

/**
 * Positional runs: a window starting at pick i covers picks i..i+window-1; it is flagged when some position appears in
 * >= `min` of those picks (multi-position players count for each of their positions). Overlapping flagged windows of the
 * same position are merged into one run. Windows are attributed to the round of their first pick.
 */
export function positionalRuns(draft: AnalysisDraft, players: Map<string, AnalysisPlayer>, window = 5, min = 3): RunStats {
  const picks = draft.picks.slice().sort((a, b) => a.pick - b.pick);
  const pos = picks.map((k) => {
    const p = players.get(k.playerId);
    return isRealPlayer(p) ? p.positions : null;
  });
  const roundWin = new Map<number, { windows: number; flagged: number }>();
  const runs: PositionalRun[] = [];
  const byPosition: Partial<Record<Position, number>> = {};
  let windows = 0;
  let flagged = 0;
  for (let i = 0; i + window <= picks.length; i++) {
    const slice = pos.slice(i, i + window);
    if (slice.some((s) => s === null)) continue;
    windows++;
    const rw = roundWin.get(picks[i].round) ?? { windows: 0, flagged: 0 };
    rw.windows++;
    const counts = new Map<Position, number>();
    for (const s of slice) for (const q of s!) counts.set(q, (counts.get(q) ?? 0) + 1);
    const hit = [...counts].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (hit.length) {
      flagged++;
      rw.flagged++;
      const [position, count] = hit[0];
      byPosition[position] = (byPosition[position] ?? 0) + 1;
      const end = picks[i + window - 1].pick;
      const last = runs[runs.length - 1];
      if (last && last.position === position && picks[i].pick <= last.endPick) {
        last.endPick = end;
        last.count = Math.max(last.count, count);
      } else runs.push({ position, startPick: picks[i].pick, endPick: end, count });
    }
    roundWin.set(picks[i].round, rw);
  }
  // recount members of each merged run
  for (const r of runs) {
    r.count = picks.filter((k, idx) => k.pick >= r.startPick && k.pick <= r.endPick && pos[idx]?.includes(r.position)).length;
  }
  return {
    windows, flagged,
    byRound: [...roundWin].sort((a, b) => a[0] - b[0]).map(([round, v]) => ({ round, ...v, rate: v.windows ? v.flagged / v.windows : 0 })),
    byPosition, runs,
  };
}
