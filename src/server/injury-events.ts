import type { Db } from "@/db/client";
import { getLeague, getRosters, getState, setState } from "@/db/season";
import type { UpdateSummary } from "@/integrations/news/update";
import { detectRosterChanges, type InjuryEvent } from "@/ops/injury-watch";

const KEY = "injuryQueue";
const MAX_AGE_MS = 24 * 3_600_000;

interface Queue { events: InjuryEvent[] }

const load = (db: Db, leagueId: number): Queue => getState<Queue>(db, leagueId, KEY)?.value ?? { events: [] };

/** After a news refresh: queue the status changes of players on the user's roster (the scheduler container alerts from this queue). */
export function recordInjuryEvents(db: Db, summary: Pick<UpdateSummary, "statusChanges">, now = Date.now()): InjuryEvent[] {
  if (!summary.statusChanges.length) return [];
  const lg = getLeague(db);
  if (!lg) return [];
  const roster = new Set((getRosters(db, lg.id).get(lg.userSlot) ?? []).map((r) => r.playerId));
  const fresh = detectRosterChanges(summary.statusChanges, roster, new Date(now).toISOString());
  if (!fresh.length) return [];
  const q = load(db, lg.id);
  const keep = q.events.filter((e) => now - Date.parse(e.at) < MAX_AGE_MS);
  const dupe = (e: InjuryEvent) => keep.some((k) => k.playerId === e.playerId && k.after === e.after);
  const added = fresh.filter((e) => !dupe(e));
  setState(db, lg.id, KEY, { events: [...keep, ...added] });
  return added;
}

export function pendingInjuryEvents(db: Db, now = Date.now()): InjuryEvent[] {
  const lg = getLeague(db);
  return lg ? load(db, lg.id).events.filter((e) => now - Date.parse(e.at) < MAX_AGE_MS) : [];
}

export function ackInjuryEvents(db: Db, ids: readonly string[]): number {
  const lg = getLeague(db);
  if (!lg) return 0;
  const q = load(db, lg.id);
  const rest = q.events.filter((e) => !ids.includes(e.id));
  setState(db, lg.id, KEY, { events: rest });
  return q.events.length - rest.length;
}
