import { isNotNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { players } from "../../db/schema";
import type { DraftState } from "../../types";
import type { DraftProvider } from "../providers";
import type { YahooGet } from "./client";
import { yahooGet } from "./client";
import { YahooError } from "./errors";
import {

  normalizeDraftResults,
  normalizeLeagues,
  normalizeSettings,
  normalizeSinglePlayer,
  normalizeTeams,
  type YahooDraftResult,
  type YahooLeague,
  type YahooTeam,
} from "./normalize";

export type { YahooDraftResult, YahooLeague } from "./normalize";

export interface YahooDraftConfig {
  leagueKey: string;
  numTeams: number | null;
  /** "live" | "offline" | "self" (Yahoo values), null if unknown. */
  draftType: string | null;
  draftStatus: string | null;
  isAuctionDraft: boolean;
  rounds: number | null;
  userTeamKey: string | null;
  /** The user's draft position (1-based), null when Yahoo has not assigned draft order yet. */
  userSlot: number | null;
}

export interface YahooLeagueWithTeam extends YahooLeague {
  userTeamKey: string | null;
  userSlot: number | null;
}

const NAME_CACHE = new Map<string, string>();

/** "466.p.6014" → "p.6014" so game-key prefixes can differ between seasons. */
export function playerKeySuffix(key: string): string {
  const m = /(p\.\d+)$/.exec(key);
  return m ? m[1] : key;
}

/** yahoo_player_key → internal id lookup built from the players table. */
export function buildKeyMapper(db: Db): (yahooKey: string) => string | null {
  const m = new Map<string, string>();
  for (const r of db.select({ id: players.id, key: players.yahooPlayerKey }).from(players).where(isNotNull(players.yahooPlayerKey)).all())
    if (r.key) m.set(playerKeySuffix(r.key), r.id);
  return (k) => m.get(playerKeySuffix(k)) ?? null;
}

export function inferUserTeam(teams: YahooTeam[], leagueKey?: string): YahooTeam | null {
  const mine = teams.filter((t) => t.isOwnedByCurrentLogin && (!leagueKey || t.leagueKey === leagueKey));
  return mine[0] ?? null;
}

/** The only place that talks to Yahoo for drafts. Everything it returns is already normalized/internal-shaped. */
export class YahooDraftProvider implements DraftProvider {
  constructor(
    private readonly get: YahooGet = yahooGet,
    private readonly opts: { leagueKey?: string; mapKey?: (yahooKey: string) => string | null; draftId?: number } = {},
  ) {}

  async fetchDraftResults(leagueKey: string): Promise<YahooDraftResult[]> {
    const rows = normalizeDraftResults(await this.get(`league/${leagueKey}/draftresults`));
    return rows.filter((r) => r.yahooPlayerKey !== null);
  }

  /** Display name for a Yahoo player key (cached; null when Yahoo cannot resolve it). */
  async fetchPlayerName(playerKey: string): Promise<string | null> {
    if (NAME_CACHE.has(playerKey)) return NAME_CACHE.get(playerKey)!;
    try {
      const name = normalizeSinglePlayer(await this.get(`player/${playerKey}`))?.name ?? null;
      if (name) NAME_CACHE.set(playerKey, name);
      return name;
    } catch {
      return null;
    }
  }

  /** The user's NBA leagues for the current season, each annotated with the user's team / draft slot. */
  async fetchLeagues(): Promise<YahooLeagueWithTeam[]> {
    const leagues = normalizeLeagues(await this.get("users;use_login=1/games;game_keys=nba/leagues"));
    let teams: YahooTeam[] = [];
    try {
      teams = normalizeTeams(await this.get("users;use_login=1/games;game_keys=nba/teams"));
    } catch (e) {
      if (!(e instanceof YahooError) || (e.code !== "NOT_FOUND" && e.code !== "PARSE")) throw e;
    }
    return leagues.map((l) => {
      const t = inferUserTeam(teams, l.leagueKey);
      return { ...l, userTeamKey: t?.teamKey ?? null, userSlot: t?.draftPosition ?? null };
    });
  }

  async fetchConfig(leagueKey: string): Promise<YahooDraftConfig> {
    const s = normalizeSettings(await this.get(`league/${leagueKey}/settings`));
    let team = null as YahooTeam | null;
    try {
      team = inferUserTeam(normalizeTeams(await this.get(`users;use_login=1/games;game_keys=nba/teams`)), leagueKey);
      if (!team) team = inferUserTeam(normalizeTeams(await this.get(`league/${leagueKey}/teams`)), leagueKey);
    } catch (e) {
      if (!(e instanceof YahooError) || (e.code !== "NOT_FOUND" && e.code !== "PARSE")) throw e;
    }
    return {
      leagueKey,
      numTeams: s.numTeams,
      draftType: s.draftType,
      draftStatus: s.draftStatus,
      isAuctionDraft: s.isAuctionDraft,
      rounds: s.rounds,
      userTeamKey: team?.teamKey ?? null,
      userSlot: team?.draftPosition ?? null,
    };
  }

  /** DraftProvider contract: a DraftState built purely from Yahoo (picks mapped to internal ids). Throws on unmapped players. */
  async getDraftState(): Promise<DraftState> {
    const { leagueKey, mapKey } = this.opts;
    if (!leagueKey || !mapKey) throw new YahooError("NOT_FOUND", "YahooDraftProvider.getDraftState needs leagueKey and mapKey options");
    const [cfg, results, teams] = await Promise.all([this.fetchConfig(leagueKey), this.fetchDraftResults(leagueKey), this.get(`league/${leagueKey}/teams`).then(normalizeTeams)]);
    const slotOf = new Map(teams.map((t) => [t.teamKey, t.draftPosition ?? 0]));
    const teamsN = cfg.numTeams ?? teams.length;
    const rounds = cfg.rounds ?? 0;
    const picks = results.map((r) => {
      const playerId = mapKey(r.yahooPlayerKey!);
      if (!playerId) throw new YahooError("PARSE", `Unmapped Yahoo player ${r.yahooPlayerKey} at pick ${r.pick}`);
      return { pick: r.pick, round: r.round, teamSlot: slotOf.get(r.teamKey) ?? 0, playerId, source: "yahoo" as const, timestamp: new Date().toISOString() };
    });
    const currentPick = picks.length + 1;
    return {
      id: this.opts.draftId ?? 0,
      teams: teamsN,
      userSlot: cfg.userSlot ?? 0,
      rounds,
      currentPick,
      status: rounds > 0 && currentPick > teamsN * rounds ? "complete" : "active",
      picks,
    };
  }
}

