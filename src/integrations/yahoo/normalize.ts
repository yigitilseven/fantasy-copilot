/**
 * Yahoo Fantasy JSON is an XML-to-JSON artifact:
 *  - collections are objects keyed "0","1",… plus "count"
 *  - a resource is often an array of single-key objects (sometimes nested arrays, sometimes empty arrays)
 *  - sub-resources (draft_analysis, stats…) are appended as extra array elements
 * These helpers turn that into plain typed objects. Everything is defensive: unknown shapes yield null/[].
 */
import { YahooError } from "./errors";

type Obj = Record<string, unknown>;

export function isObj(x: unknown): x is Obj {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Values of a Yahoo collection ({"0":…,"1":…,"count":2}) or a plain array. */
export function listOf(node: unknown): unknown[] {
  if (Array.isArray(node)) return node;
  if (!isObj(node)) return [];
  return Object.keys(node)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => node[k]);
}

/** Merges an array of single-key objects (possibly nested arrays / empty arrays) into one object. Objects pass through. */
export function mergeParts(node: unknown): Obj {
  if (isObj(node)) return node;
  const out: Obj = {};
  if (!Array.isArray(node)) return out;
  for (const part of node) {
    if (Array.isArray(part)) Object.assign(out, mergeParts(part));
    else if (isObj(part)) Object.assign(out, part);
  }
  return out;
}

/** Depth-first search for the first value stored under `key`. */
export function findFirst(node: unknown, key: string): unknown {
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findFirst(n, key);
      if (r !== undefined) return r;
    }
  } else if (isObj(node)) {
    if (key in node) return node[key];
    for (const v of Object.values(node)) {
      const r = findFirst(v, key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

/**
 * All resources stored under `key` as elements of a collection ({"0":{key: …}}), anywhere in the tree.
 * Does not descend into a matched resource.
 */
export function findAll(node: unknown, key: string): unknown[] {
  const out: unknown[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (isObj(n)) {
      for (const [k, v] of Object.entries(n)) {
        if (k === key) out.push(v);
        else walk(v);
      }
    }
  };
  walk(node);
  return out;
}

export function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Numeric parse that treats "-", "", "N/A", null as missing. Accepts ".563", "1,234". */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/,/g, "");
  if (t === "" || t === "-" || /^n\/?a$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ game

export interface YahooGame {
  gameKey: string;
  season: number;
  code: string;
}

export function normalizeGame(json: unknown): YahooGame {
  const raw = findFirst(json, "game");
  const g = mergeParts(Array.isArray(raw) ? raw : [raw]);
  const gameKey = str(g.game_key);
  const season = num(g.season);
  if (!gameKey || season === null) throw new YahooError("PARSE", "Could not read game_key/season from Yahoo game response");
  return { gameKey, season, code: str(g.code) ?? "nba" };
}

// ------------------------------------------------------------------ players

export interface YahooPlayer {
  playerKey: string;
  playerId: string;
  name: string;
  /** Raw (not normalized) team abbreviation as Yahoo returns it, e.g. "Den", "GS". */
  teamAbbr: string | null;
  displayPosition: string | null;
  /** Raw eligible_positions, e.g. ["PG","SG","G","Util"]. */
  eligiblePositions: string[];
  status: string | null;
  injuryNote: string | null;
  /** From the draft_analysis sub-resource; null = "-" or absent. */
  averagePick: number | null;
  averageRound: number | null;
  percentDrafted: number | null;
  /** From percent_owned; 0–100. */
  percentOwned: number | null;
  /** True when the draft_analysis sub-resource was present (even if values were "-"). */
  hasDraftAnalysis: boolean;
  /** stat_id → raw value string, from a stats sub-resource. */
  stats: Record<string, string> | null;
  statsMeta: { coverageType: string | null; season: string | null } | null;
}

export function normalizeStats(playerStats: unknown): { stats: Record<string, string>; meta: { coverageType: string | null; season: string | null } } | null {
  const ps = mergeParts(playerStats);
  if (!("stats" in ps)) return null;
  const stats: Record<string, string> = {};
  for (const item of listOf(ps.stats)) {
    const s = mergeParts(isObj(item) && "stat" in item ? item.stat : item);
    const id = str(s.stat_id);
    const value = typeof s.value === "number" ? String(s.value) : typeof s.value === "string" ? s.value : null;
    if (id && value !== null) stats[id] = value;
  }
  return { stats, meta: { coverageType: str(ps.coverage_type), season: str(ps.season) } };
}

/** Normalizes one `player` node: [[{…info},{…}], {draft_analysis…}, {player_stats…}] (or an already-merged object). */
export function normalizePlayer(node: unknown): YahooPlayer | null {
  const p = mergeParts(node);
  const playerKey = str(p.player_key);
  if (!playerKey) return null;
  const nameObj = mergeParts(p.name);
  const name = str(nameObj.full) ?? ([str(nameObj.first), str(nameObj.last)].filter(Boolean).join(" ") || (typeof p.name === "string" ? p.name : ""));
  if (!name) return null;

  const eligible = listOf(p.eligible_positions)
    .map((e) => (isObj(e) ? str(e.position) : str(e)))
    .filter((x): x is string => !!x);

  const da = "draft_analysis" in p ? mergeParts(p.draft_analysis) : null;
  const po = "percent_owned" in p ? mergeParts(p.percent_owned) : null;
  const st = "player_stats" in p ? normalizeStats(p.player_stats) : null;

  return {
    playerKey,
    playerId: str(p.player_id) ?? playerKey.split(".p.")[1] ?? playerKey,
    name,
    teamAbbr: str(p.editorial_team_abbr),
    displayPosition: str(p.display_position),
    eligiblePositions: eligible,
    status: str(p.status),
    injuryNote: str(p.injury_note) ?? str(p.status_full),
    averagePick: da ? num(da.average_pick) : null,
    averageRound: da ? num(da.average_round) : null,
    percentDrafted: da ? num(da.percent_drafted) : null,
    percentOwned: po ? num(po.value) : null,
    hasDraftAnalysis: da !== null,
    stats: st?.stats ?? null,
    statsMeta: st?.meta ?? null,
  };
}

/** Players from any response containing a `players` collection (game/…/players, league/…/players). */
export function normalizePlayers(json: unknown): YahooPlayer[] {
  const coll = findFirst(json, "players");
  if (coll === undefined) return [];
  const out: YahooPlayer[] = [];
  for (const item of listOf(coll)) {
    const p = normalizePlayer(isObj(item) && "player" in item ? item.player : item);
    if (p) out.push(p);
  }
  return out;
}

/** Single-player response (`player/{key}/…`). */
export function normalizeSinglePlayer(json: unknown): YahooPlayer | null {
  const node = findFirst(json, "player");
  return node === undefined ? null : normalizePlayer(node);
}

/** Merges sub-resource data (adp/ownership/stats) from `extra` into `base` without clobbering known values. */
export function mergePlayer(base: YahooPlayer, extra: YahooPlayer | null): YahooPlayer {
  if (!extra) return base;
  return {
    ...base,
    averagePick: base.averagePick ?? extra.averagePick,
    averageRound: base.averageRound ?? extra.averageRound,
    percentDrafted: base.percentDrafted ?? extra.percentDrafted,
    percentOwned: base.percentOwned ?? extra.percentOwned,
    hasDraftAnalysis: base.hasDraftAnalysis || extra.hasDraftAnalysis,
    stats: base.stats ?? extra.stats,
    statsMeta: base.statsMeta ?? extra.statsMeta,
  };
}

// ------------------------------------------------------------------ leagues / teams / settings / draft

export interface YahooLeague {
  leagueKey: string;
  name: string;
  season: number | null;
  numTeams: number | null;
  draftStatus: string | null;
  scoringType: string | null;
}

export function normalizeLeagues(json: unknown): YahooLeague[] {
  const out: YahooLeague[] = [];
  const seen = new Set<string>();
  for (const coll of findAll(json, "leagues")) {
    for (const item of listOf(coll)) {
      const l = mergeParts(isObj(item) && "league" in item ? item.league : item);
      const leagueKey = str(l.league_key);
      if (!leagueKey || seen.has(leagueKey)) continue;
      seen.add(leagueKey);
      out.push({
        leagueKey,
        name: str(l.name) ?? leagueKey,
        season: num(l.season),
        numTeams: num(l.num_teams),
        draftStatus: str(l.draft_status),
        scoringType: str(l.scoring_type),
      });
    }
  }
  return out;
}

export interface YahooTeam {
  teamKey: string;
  leagueKey: string;
  name: string;
  isOwnedByCurrentLogin: boolean;
  draftPosition: number | null;
}

export function leagueKeyOfTeam(teamKey: string): string {
  return teamKey.replace(/\.t\.\d+$/, "");
}

export function normalizeTeams(json: unknown): YahooTeam[] {
  const out: YahooTeam[] = [];
  const seen = new Set<string>();
  for (const coll of findAll(json, "teams")) {
    for (const item of listOf(coll)) {
      const t = mergeParts(isObj(item) && "team" in item ? item.team : item);
      const teamKey = str(t.team_key);
      if (!teamKey || seen.has(teamKey)) continue;
      seen.add(teamKey);
      out.push({
        teamKey,
        leagueKey: leagueKeyOfTeam(teamKey),
        name: str(t.name) ?? teamKey,
        isOwnedByCurrentLogin: num(t.is_owned_by_current_login) === 1,
        draftPosition: num(t.draft_position),
      });
    }
  }
  return out;
}

export interface YahooLeagueSettings {
  leagueKey: string | null;
  numTeams: number | null;
  draftType: string | null;
  draftStatus: string | null;
  isAuctionDraft: boolean;
  scoringType: string | null;
  /** Sum of non-IL roster slots, i.e. the number of snake rounds. */
  rounds: number | null;
}

export function normalizeSettings(json: unknown): YahooLeagueSettings {
  const raw = findFirst(json, "league");
  if (raw === undefined) throw new YahooError("PARSE", "No league object in Yahoo settings response");
  const l = mergeParts(raw);
  const s = mergeParts(l.settings);
  let rounds: number | null = null;
  const rp = findFirst(s, "roster_positions");
  if (rp !== undefined) {
    let total = 0;
    for (const item of listOf(rp)) {
      const pos = mergeParts(isObj(item) && "roster_position" in item ? item.roster_position : item);
      const code = str(pos.position) ?? "";
      const count = num(pos.count) ?? 0;
      if (!/^IL/i.test(code)) total += count;
    }
    rounds = total > 0 ? total : null;
  }
  return {
    leagueKey: str(l.league_key),
    numTeams: num(l.num_teams),
    draftType: str(s.draft_type),
    draftStatus: str(l.draft_status),
    isAuctionDraft: num(s.is_auction_draft) === 1,
    scoringType: str(l.scoring_type),
    rounds,
  };
}

export interface YahooDraftResult {
  pick: number;
  round: number;
  teamKey: string;
  /** null when the pick slot exists but no player has been selected yet. */
  yahooPlayerKey: string | null;
}

export function normalizeDraftResults(json: unknown): YahooDraftResult[] {
  const coll = findFirst(json, "draft_results");
  if (coll === undefined) return [];
  const out: YahooDraftResult[] = [];
  for (const item of listOf(coll)) {
    const r = mergeParts(isObj(item) && "draft_result" in item ? item.draft_result : item);
    const pick = num(r.pick);
    if (pick === null) continue;
    out.push({ pick, round: num(r.round) ?? 0, teamKey: str(r.team_key) ?? "", yahooPlayerKey: str(r.player_key) });
  }
  return out.sort((a, b) => a.pick - b.pick);
}
