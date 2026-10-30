import type { Db } from "@/db/client";
import { getAllPlayerRecords } from "@/db/repository";
import { getState } from "@/db/season";
import { computeValuations } from "@/engine/valuation/value";
import { canonTeamCode } from "@/engine/season/schedule";
import type { InjuryFlag, InjuryInfo, SeasonPlayer } from "@/engine/season/types";
import type { PlayerNewsItem, PlayerRecord } from "@/types";

/** Yahoo status tags (roster / players pages) -> availability. P (probable) counts as healthy. */
export function flagOfTag(tag: string | null | undefined): InjuryFlag | null {
  const t = (tag ?? "").trim().toUpperCase();
  if (!t) return null;
  if (/^(O|OUT|INJ|IL\+?|NA|SUSP)$/.test(t)) return "out";
  if (/^(DTD|GTD|Q|D)$/.test(t)) return "gtd";
  if (t === "P") return "healthy";
  return null;
}

/** Tags read from Yahoo pages stay authoritative for this long (state key "tags": playerId -> { tag | null, at }). */
export const TAG_MAX_AGE_MS = 36 * 3_600_000;
export type TagMap = Record<string, { tag: string | null; at: string }>;

const NEWS_HEADLINE_MAX_AGE_MS = 4 * 86_400_000;

function injuryOf(r: PlayerRecord, now: number): InjuryInfo {
  const k = r.risk;
  const flag: InjuryFlag = k.currentStatus === "out-for-season" ? "ofs" : k.currentStatus === "out" ? "out" : k.currentStatus === "day-to-day" ? "gtd" : "healthy";
  const inj: InjuryInfo = { flag };
  if (flag !== "healthy") {
    if (k.injuryNote) inj.injury = k.injuryNote;
    if (k.estReturn) inj.estReturn = k.estReturn;
  }
  const n = k.latestNews?.[0];
  if (n && now - Date.parse(n.publishedAt) < NEWS_HEADLINE_MAX_AGE_MS) inj.headline = n.title.slice(0, 160);
  return inj;
}

export interface SeasonPlayers {
  players: Map<string, SeasonPlayer>;
  news: Map<string, PlayerNewsItem[]>;
}

const TTL_MS = 30_000;
const cache = new WeakMap<Db, { at: number; now: number; data: SeasonPlayers }>();
export function resetSeasonPlayerCache(db?: Db): void {
  if (db) cache.delete(db);
}

const toVec = (r: PlayerRecord): number[] => {
  const p = r.projection;
  return [p.fgm, p.fga, p.ftm, p.fta, p.threePm, p.pts, p.reb, p.ast, p.stl, p.blk, p.tov];
};

/**
 * Every player as the season engines see him: the per-player "auto" blend of Yahoo 2026-27 and real stats as a per-game line, 9-cat
 * z-scores, availability and injury (news feed, overridden by the status tags last read from Yahoo pages).
 */
export function loadSeasonPlayers(db: Db, leagueId: number | null, now = Date.now()): SeasonPlayers {
  const hit = cache.get(db);
  let base: SeasonPlayers;
  if (hit && Date.now() - hit.at < TTL_MS && Math.abs(hit.now - now) < TTL_MS) base = hit.data;
  else {
    const records = getAllPlayerRecords(db, now, { projectionWeight: "auto" });
    const { valuations } = computeValuations(records);
    const players = new Map<string, SeasonPlayer>();
    const news = new Map<string, PlayerNewsItem[]>();
    for (const r of records) {
      const v = valuations[r.player.id];
      if (!v) continue;
      players.set(r.player.id, {
        id: r.player.id, name: r.player.name, team: canonTeamCode(r.player.nbaTeam), positions: r.player.positions,
        line: toVec(r), minutes: r.projection.minutes, avail: Math.max(0.2, Math.min(1, r.projection.games / 82)),
        z: v.z, nineCat: v.nineCat, injury: injuryOf(r, now),
      });
      if (r.risk.latestNews?.length) news.set(r.player.id, r.risk.latestNews);
    }
    base = { players, news };
    cache.set(db, { at: Date.now(), now, data: base });
  }
  const tags = leagueId == null ? null : getState<TagMap>(db, leagueId, "tags")?.value;
  if (!tags) return base;
  // Overlay page tags on copies (the cached base stays untouched).
  const players = new Map(base.players);
  for (const [id, t] of Object.entries(tags)) {
    const p = players.get(id);
    if (!p || now - Date.parse(t.at) > TAG_MAX_AGE_MS) continue;
    const flag = t.tag ? flagOfTag(t.tag) : "healthy";
    if (!flag) continue;
    const injury: InjuryInfo = flag === "healthy" ? { flag, ...(p.injury.headline ? { headline: p.injury.headline } : {}) } : { ...p.injury, flag, ...(t.tag ? { tag: t.tag } : {}) };
    // The page says out but the feed says healthy/day-to-day: keep the flag, drop the (unrelated) estimated return.
    if (flag === "out" && p.injury.flag !== "out" && p.injury.flag !== "ofs") delete injury.estReturn;
    if (flag === "out" && p.injury.flag === "ofs") injury.flag = "ofs";
    players.set(id, { ...p, injury });
  }
  return { players, news: base.news };
}
