import type { Db } from "@/db/client";
import { addsUsed, getAdds, getRosters, lastYahooSyncByTeam } from "@/db/season";
import { buildSeasonReport, type SeasonReport } from "@/engine/season/report";
import { weekStartOf } from "@/engine/season/schedule";
import { loadSeasonState, type StateOptions } from "./season";

/** The league analysis for the current state of the database (rosters = draft + transactions + synced pages). Null without a league. */
export function computeSeasonReport(db: Db, opts: StateOptions & { moveLimit?: number } = {}): SeasonReport | null {
  const s = loadSeasonState(db, opts);
  if (!s) return null;
  const { league } = s;
  const rosters = getRosters(db, league.id);
  const used = addsUsed(getAdds(db, league.id, weekStartOf(s.today)));
  const sources = new Map<string, number>();
  for (const list of rosters.values()) for (const r of list) sources.set(r.source, (sources.get(r.source) ?? 0) + 1);
  const synced = lastYahooSyncByTeam(db, league.id).size;
  const notes = [
    `Rosters: ${[...sources.entries()].map(([k, v]) => `${v} ${k}`).join(", ")} entries; ${synced}/${s.teams.length} teams have been read from their Yahoo page (the rest = draft baseline + Yahoo transactions).`,
    ...(s.preview ? [`Season has not started: weeks are modeled from ${s.today}.`] : []),
    ...(s.faUnscored.length ? [`${s.faUnscored.length} Yahoo free agent(s) are not scored (no projection and no NBA stats): ${s.faUnscored.slice(0, 12).join(", ")}${s.faUnscored.length > 12 ? ", ..." : ""}.`] : []),
  ];
  return buildSeasonReport({
    ctx: s.ctx,
    players: s.players,
    teams: s.teams.map((t) => ({ slot: t.slot, name: t.name, isUser: t.isUser, entries: (rosters.get(t.slot) ?? []).map((r) => ({ playerId: r.playerId, slot: r.lineupSlot, status: r.status })) })),
    freeAgentIds: s.faIds,
    pctOwned: s.faPct,
    faSource: s.faSource,
    matchup: s.matchup,
    schedule: s.scheduleData ? { lastDate: s.scheduleData.lastDate } : null,
    addsRemaining: Math.max(0, league.settings.weeklyAddLimit - used),
    addsLimit: league.settings.weeklyAddLimit,
    dataNotes: notes,
    moveLimit: opts.moveLimit,
  });
}
