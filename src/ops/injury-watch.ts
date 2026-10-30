import type { StatusChange } from "../integrations/news/update";

/** Pure injury-change logic for the user's roster (healthy <-> day-to-day / out / out-for-season). */
export type Status = StatusChange["before"]["status"];

export interface InjuryEvent {
  id: string;
  at: string;
  playerId: string;
  name: string;
  before: Status;
  after: Status;
  injury?: string;
  estReturn?: string;
  source?: string;
  direction: "worse" | "better";
}

const RANK: Record<Status, number> = { healthy: 0, "day-to-day": 1, out: 2, "out-for-season": 3 };

/** Only changes of the status itself count (a moved return date alone is not an event). */
export function detectRosterChanges(changes: readonly StatusChange[], rosterIds: ReadonlySet<string>, at = new Date().toISOString()): InjuryEvent[] {
  const out: InjuryEvent[] = [];
  for (const c of changes) {
    if (!rosterIds.has(c.playerId) || c.before.status === c.after.status) continue;
    out.push({
      id: `${c.playerId}:${c.before.status}>${c.after.status}:${at}`,
      at, playerId: c.playerId, name: c.name, before: c.before.status, after: c.after.status,
      injury: c.after.injury, estReturn: c.after.estReturn, source: c.after.source,
      direction: RANK[c.after.status] > RANK[c.before.status] ? "worse" : "better",
    });
  }
  return out;
}

const LABEL: Record<Status, string> = { healthy: "healthy", "day-to-day": "day-to-day", out: "OUT", "out-for-season": "OUT FOR SEASON" };

export function formatInjuryEvent(e: InjuryEvent): string {
  const bits = [e.injury, e.estReturn ? `return ${e.estReturn}` : "", e.source].filter(Boolean).join("; ");
  return `${e.direction === "worse" ? "-" : "+"} ${e.name}: ${LABEL[e.before]} -> ${LABEL[e.after]}${bits ? ` (${bits})` : ""}`;
}

export function formatInjuryAlert(events: readonly InjuryEvent[]): { title: string; body: string } {
  const worse = events.filter((e) => e.direction === "worse").length;
  const title = events.length === 1 ? `${events[0].name} is now ${LABEL[events[0].after]}` : `${events.length} status changes on your roster${worse ? ` (${worse} worse)` : ""}`;
  return { title, body: events.map(formatInjuryEvent).join("\n") };
}

export interface LimiterState {
  /** "playerId:after" -> last alerted ms */
  seen: Record<string, number>;
  /** timestamps of alert messages sent */
  sent: number[];
  /** timestamps of Claude takes */
  takes: number[];
}
export interface LimiterCfg { cooldownMs: number; maxAlertsPerHour: number; maxTakesPerDay: number; minTakeGapMs: number }
export const DEFAULT_LIMITS: LimiterCfg = { cooldownMs: 6 * 3_600_000, maxAlertsPerHour: 6, maxTakesPerDay: 6, minTakeGapMs: 20 * 60_000 };

/** Drops events alerted recently for the same player+status. Returns what may be sent and whether the hourly alert cap is reached. */
export function applyLimits(events: readonly InjuryEvent[], st: LimiterState, now: number, cfg: LimiterCfg = DEFAULT_LIMITS): { send: InjuryEvent[]; suppressed: InjuryEvent[]; capped: boolean } {
  const capped = st.sent.filter((t) => now - t < 3_600_000).length >= cfg.maxAlertsPerHour;
  const send: InjuryEvent[] = [];
  const suppressed: InjuryEvent[] = [];
  for (const e of events) {
    const last = st.seen[`${e.playerId}:${e.after}`];
    (last !== undefined && now - last < cfg.cooldownMs ? suppressed : send).push(e);
  }
  return capped ? { send: [], suppressed: [...suppressed, ...send], capped } : { send, suppressed, capped };
}

export function takeAllowed(st: LimiterState, now: number, cfg: LimiterCfg = DEFAULT_LIMITS): boolean {
  const today = st.takes.filter((t) => now - t < 86_400_000);
  const last = today[today.length - 1];
  return today.length < cfg.maxTakesPerDay && (last === undefined || now - last >= cfg.minTakeGapMs);
}

export function recordSent(st: LimiterState, sent: readonly InjuryEvent[], now: number, withTake: boolean): LimiterState {
  const seen = { ...st.seen };
  for (const e of sent) seen[`${e.playerId}:${e.after}`] = now;
  for (const k of Object.keys(seen)) if (now - seen[k] > 3 * 86_400_000) delete seen[k];
  return { seen, sent: [...st.sent.filter((t) => now - t < 86_400_000), now], takes: [...st.takes.filter((t) => now - t < 86_400_000), ...(withTake ? [now] : [])] };
}
