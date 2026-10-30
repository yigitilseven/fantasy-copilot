import type { Db } from "@/db/client";
import { getLeague, getRosters, getState, setState } from "@/db/season";
import { gameDayOf } from "@/engine/season/schedule";

/** The full text of today's Claude-written brief (or the plain engine text when Claude was unavailable), shown on Today. */
export interface StoredClaudeBrief {
  day: string; text: string; usedClaude: boolean; note?: string; at: string;
  /** Your roster when it was written (sorted player ids); a different roster now = the advice is outdated. */
  rosterKey?: string;
  /** "weekly-plan" | "daily-brief" */
  kind?: string;
}

/** Fingerprint of your current roster (who is on it; IL included). */
export function userRosterKey(db: Db): string | null {
  const lg = getLeague(db);
  if (!lg) return null;
  return (getRosters(db, lg.id).get(lg.userSlot) ?? []).map((r) => r.playerId).sort().join(",");
}
const key = (day: string) => `claudeBrief:${day}`;

export function saveClaudeBrief(db: Db, input: { text: string; usedClaude: boolean; note?: string; kind?: string }, now = Date.now()): StoredClaudeBrief | null {
  const lg = getLeague(db);
  if (!lg) return null;
  const day = gameDayOf(now, lg.settings.timezone);
  const v: StoredClaudeBrief = { day, text: input.text.slice(0, 8000), usedClaude: input.usedClaude, note: input.note, at: new Date(now).toISOString(), rosterKey: userRosterKey(db) ?? undefined, ...(input.kind ? { kind: input.kind } : {}) };
  setState(db, lg.id, key(day), v);
  return v;
}

export function loadClaudeBrief(db: Db, now = Date.now()): StoredClaudeBrief | null {
  const lg = getLeague(db);
  if (!lg) return null;
  return getState<StoredClaudeBrief>(db, lg.id, key(gameDayOf(now, lg.settings.timezone)))?.value ?? null;
}

/** The stored brief plus whether your roster changed since it was written (then it recommends moves you may already have made). */
export function loadClaudeBriefStatus(db: Db, now = Date.now()): { brief: StoredClaudeBrief | null; outdated: boolean } {
  const brief = loadClaudeBrief(db, now);
  const cur = userRosterKey(db);
  return { brief, outdated: !!brief?.rosterKey && cur != null && brief.rosterKey !== cur };
}
