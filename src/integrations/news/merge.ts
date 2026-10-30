import type { InjuryStatus } from "../../types";
import type { StatusReport } from "./types";

/** Higher = more severe. */
export const SEVERITY: Record<InjuryStatus, number> = { healthy: 0, "day-to-day": 1, out: 2, "out-for-season": 3 };
/** Tie-break priority between sources reporting the same day (lower index wins). */
export const SOURCE_PRIORITY = ["ESPN", "CBS", "RotoWire"];

const day = (r: StatusReport) => (r.reportedAt ? r.reportedAt.slice(0, 10) : "");
const prio = (s: string) => {
  const i = SOURCE_PRIORITY.indexOf(s);
  return i < 0 ? SOURCE_PRIORITY.length : i;
};

/**
 * Merges several reports about ONE player: most recent report (by day) wins; undated reports rank below dated ones;
 * same-day ties go to the more severe status, then source priority. Missing injury/return/comment are filled from other
 * reports with the same status. Returns the winner (a copy) or null for an empty list.
 */
export function mergeReports(reports: StatusReport[]): StatusReport | null {
  if (reports.length === 0) return null;
  const sorted = [...reports].sort(
    (a, b) => day(b).localeCompare(day(a)) || SEVERITY[b.status] - SEVERITY[a.status] || prio(a.source) - prio(b.source),
  );
  const win = { ...sorted[0] };
  for (const o of sorted.slice(1)) {
    if (o.status !== win.status) continue;
    win.estReturn ??= o.estReturn;
    win.injury ??= o.injury;
    win.comment ??= o.comment;
  }
  return win;
}

/** Groups reports by the id resolved by `resolve` (null = not one of our players -> dropped) and merges each group. */
export function mergeByPlayer(reports: StatusReport[], resolve: (r: StatusReport) => string | null): Map<string, StatusReport> {
  const groups = new Map<string, StatusReport[]>();
  for (const r of reports) {
    const id = resolve(r);
    if (id) (groups.get(id) ?? groups.set(id, []).get(id)!).push(r);
  }
  const out = new Map<string, StatusReport>();
  for (const [id, g] of groups) out.set(id, mergeReports(g)!);
  return out;
}
