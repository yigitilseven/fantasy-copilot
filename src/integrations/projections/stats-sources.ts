/**
 * Season per-game stats for the real-data importer. Providers:
 *  - NBA.com leaguedashplayerstats (+ playerindex for POSITION)   [primary, needs browser-like headers]
 *  - Basketball-Reference per-game table                          [live fallback, HTML]
 *  - user-supplied file (NBA.com JSON or an NBA.com-style CSV)    [manual fallback]
 * Everything here is pure parsing; fetching lives in fetch-cache.ts.
 */
import { parseCsv } from "./csv";
import { nameKey } from "./names";
import type { Position } from "../../types";
import type { PerGameLine } from "../yahoo/stats";

export interface StatsRow {
  name: string;
  team: string | null;
  age: number | null;
  /** Position as the provider spells it ("G-F", "C", "PG"). */
  pos: string | null;
  line: PerGameLine;
}

const num = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return NaN;
  return Number(v);
};

export function nbaSeasonLabel(endYear: number): string {
  return `${endYear - 1}-${String(endYear % 100).padStart(2, "0")}`;
}

export function nbaStatsUrl(season: string): string {
  const q = new URLSearchParams({
    College: "", Conference: "", Country: "", DateFrom: "", DateTo: "", Division: "", DraftPick: "", DraftYear: "", GameScope: "", GameSegment: "",
    Height: "", ISTRound: "", LastNGames: "0", LeagueID: "00", Location: "", MeasureType: "Base", Month: "0", OpponentTeamID: "0", Outcome: "", PORound: "0",
    PaceAdjust: "N", PerMode: "PerGame", Period: "0", PlayerExperience: "", PlayerPosition: "", PlusMinus: "N", Rank: "N", Season: season,
    SeasonSegment: "", SeasonType: "Regular Season", ShotClockRange: "", StarterBench: "", TeamID: "0", VsConference: "", VsDivision: "", Weight: "",
  });
  return `https://stats.nba.com/stats/leaguedashplayerstats?${q.toString().replace(/\+/g, "%20")}`;
}

export const nbaPlayerIndexUrl = (season: string) => `https://stats.nba.com/stats/playerindex?LeagueID=00&Season=${season}&Historical=0&Active=1`;

export const NBA_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://www.nba.com/",
  Origin: "https://www.nba.com",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
};

function resultSet(json: unknown): { headers: string[]; rows: unknown[][] } {
  const j = json as { resultSets?: { headers: string[]; rowSet: unknown[][] }[]; resultSet?: { headers: string[]; rowSet: unknown[][] } };
  const rs = j?.resultSets?.[0] ?? j?.resultSet;
  if (!rs || !Array.isArray(rs.headers) || !Array.isArray(rs.rowSet)) throw new Error("not an NBA.com stats response (no resultSets)");
  return { headers: rs.headers, rows: rs.rowSet };
}

function toLine(get: (k: string) => number): PerGameLine | null {
  const line: PerGameLine = {
    gp: get("GP"), minutes: get("MIN"), pts: get("PTS"), fgm: get("FGM"), fga: get("FGA"), ftm: get("FTM"), fta: get("FTA"),
    threePm: get("FG3M"), reb: get("REB"), ast: get("AST"), stl: get("STL"), blk: get("BLK"), tov: get("TOV"),
  };
  // minutes may be missing; everything else must be a number and attempts must be positive.
  const { minutes, ...rest } = line;
  if (Object.values(rest).some((x) => !Number.isFinite(x)) || line.fga <= 0 || line.fta < 0 || line.gp <= 0) return null;
  return { ...line, minutes: Number.isFinite(minutes as number) ? minutes : null };
}

/** NBA.com leaguedashplayerstats JSON → rows. */
export function parseNbaLeagueStats(json: unknown): StatsRow[] {
  const { headers, rows } = resultSet(json);
  const ix = new Map(headers.map((h, i) => [h, i]));
  for (const h of ["PLAYER_NAME", "GP", "PTS", "FGM", "FGA"]) if (!ix.has(h)) throw new Error(`NBA.com response missing column ${h}`);
  const out: StatsRow[] = [];
  for (const r of rows) {
    const line = toLine((k) => num(r[ix.get(k) ?? -1]));
    if (!line) continue;
    const age = num(r[ix.get("AGE") ?? -1]);
    out.push({
      name: String(r[ix.get("PLAYER_NAME")!]),
      team: ix.has("TEAM_ABBREVIATION") ? String(r[ix.get("TEAM_ABBREVIATION")!] ?? "") || null : null,
      age: Number.isFinite(age) ? age : null,
      pos: null,
      line,
    });
  }
  return out;
}

/** NBA.com playerindex JSON → name key → POSITION ("G-F"). */
export function parseNbaPlayerIndex(json: unknown): Map<string, string> {
  const { headers, rows } = resultSet(json);
  const ix = new Map(headers.map((h, i) => [h, i]));
  const out = new Map<string, string>();
  for (const r of rows) {
    const name = ix.has("PLAYER_NAME") ? String(r[ix.get("PLAYER_NAME")!]) : `${r[ix.get("PLAYER_FIRST_NAME") ?? -1] ?? ""} ${r[ix.get("PLAYER_LAST_NAME") ?? -1] ?? ""}`.trim();
    const pos = r[ix.get("POSITION") ?? -1];
    if (name && typeof pos === "string" && pos) out.set(nameKey(name), pos);
  }
  return out;
}

export interface PlayerIndexMeta {
  /** First NBA season, start year (2025 = rookie in 2025-26). */
  fromYear: number | null;
  draftYear: number | null;
}

/** NBA.com playerindex JSON -> name key -> first season / draft year (for the "<= 2nd season" weight rule). */
export function parseNbaPlayerIndexMeta(json: unknown): Map<string, PlayerIndexMeta> {
  const { headers, rows } = resultSet(json);
  const ix = new Map(headers.map((h, i) => [h, i]));
  const out = new Map<string, PlayerIndexMeta>();
  const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  for (const r of rows) {
    const name = ix.has("PLAYER_NAME") ? String(r[ix.get("PLAYER_NAME")!]) : `${r[ix.get("PLAYER_FIRST_NAME") ?? -1] ?? ""} ${r[ix.get("PLAYER_LAST_NAME") ?? -1] ?? ""}`.trim();
    if (name) out.set(nameKey(name), { fromYear: n(r[ix.get("FROM_YEAR") ?? -1]), draftYear: n(r[ix.get("DRAFT_YEAR") ?? -1]) });
  }
  return out;
}

const POS_MAP: Record<string, Position[]> = {
  G: ["PG", "SG"],
  F: ["SF", "PF"],
  C: ["C"],
  "G-F": ["SG", "SF"],
  "F-G": ["SF", "SG"],
  "F-C": ["PF", "C"],
  "C-F": ["C", "PF"],
  "G-C": ["SG", "C"],
  "C-G": ["C", "SG"],
  PG: ["PG"],
  SG: ["SG"],
  SF: ["SF"],
  PF: ["PF"],
};

/** NBA.com / Basketball-Reference position string → Yahoo-ish eligibility. Unknown → []. */
export function mapNbaPosition(pos: string | null | undefined): Position[] {
  if (!pos) return [];
  const key = pos.trim().toUpperCase().replace(/\s+/g, "");
  if (POS_MAP[key]) return POS_MAP[key];
  // "PG-SG", "SF-PF", "SG-SF" (Basketball-Reference multi-position)
  const parts = key.split(/[-/,]/).filter(Boolean);
  const out: Position[] = [];
  for (const p of parts) for (const m of POS_MAP[p] ?? []) if (!out.includes(m)) out.push(m);
  return parts.length > 1 ? out : (POS_MAP[parts[0]] ?? []);
}

// ------------------------------------------------------------------ Basketball-Reference

const stripTags = (s: string) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();

/** Basketball-Reference "NBA_<year>_per_game.html". Multi-team players: the TOT row's stats, last team's abbreviation. */
export function parseBbrefPerGame(html: string): StatsRow[] {
  const byId = new Map<string, { row: StatsRow; lastTeam: string | null }>();
  const order: string[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  const cellRe = /<(?:td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html))) {
    const cells = new Map<string, string>();
    const attrs = new Map<string, string>();
    let c: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((c = cellRe.exec(m[1]))) {
      const stat = /data-stat="([^"]+)"/.exec(c[1])?.[1];
      if (!stat) continue;
      cells.set(stat, stripTags(c[2]));
      const csk = /\bcsk="([^"]+)"/.exec(c[1])?.[1];
      if (csk) attrs.set(stat, csk);
      const id = /data-append-csv="([^"]+)"/.exec(c[1])?.[1];
      if (id) attrs.set("__id", id);
    }
    const name = cells.get("name_display") ?? cells.get("player");
    if (!name || !cells.has("pts_per_g")) continue;
    const val = (k: string) => {
      const csk = attrs.get(k);
      const n = csk !== undefined && /^-?\d+(\.\d+)?$/.test(csk) ? Number(csk) : num(cells.get(k));
      return n;
    };
    const id = attrs.get("__id") ?? name;
    const team = (cells.get("team_name_abbr") ?? cells.get("team_id") ?? "").trim();
    const multi = /^\d+TM$|^TOT$/.test(team);
    const existing = byId.get(id);
    if (existing) {
      if (!multi) existing.lastTeam = team;
      continue;
    }
    const line = toLine((k) => {
      switch (k) {
        case "GP": return val("games");
        case "MIN": return val("mp_per_g");
        case "PTS": return val("pts_per_g");
        case "FGM": return val("fg_per_g");
        case "FGA": return val("fga_per_g");
        case "FG3M": return val("fg3_per_g");
        case "FTM": return val("ft_per_g");
        case "FTA": return val("fta_per_g");
        case "REB": return val("trb_per_g");
        case "AST": return val("ast_per_g");
        case "STL": return val("stl_per_g");
        case "BLK": return val("blk_per_g");
        default: return val("tov_per_g");
      }
    });
    if (!line) continue;
    const age = num(cells.get("age"));
    byId.set(id, { row: { name, team: multi ? null : team, age: Number.isFinite(age) ? age : null, pos: cells.get("pos") || null, line }, lastTeam: multi ? null : team });
    order.push(id);
  }
  return order.map((id) => {
    const e = byId.get(id)!;
    return { ...e.row, team: e.lastTeam ?? e.row.team };
  });
}

export const bbrefUrl = (endYear: number) => `https://www.basketball-reference.com/leagues/NBA_${endYear}_per_game.html`;

// ------------------------------------------------------------------ user-supplied file

const CSV_ALIASES: Record<string, string> = {
  PLAYER: "PLAYER_NAME", NAME: "PLAYER_NAME", TEAM: "TEAM_ABBREVIATION", "3PM": "FG3M", "3P": "FG3M", "3PTM": "FG3M", POSITION: "POS", MPG: "MIN",
};

/** NBA.com-style CSV (as exported from stats.nba.com/players/traditional, or a hand-made file). Headers are case-insensitive. */
export function parseStatsCsv(text: string): StatsRow[] {
  const raw = parseCsv(text);
  const out: StatsRow[] = [];
  for (const r0 of raw) {
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(r0)) {
      const up = k.trim().toUpperCase();
      r[CSV_ALIASES[up] ?? up] = v;
    }
    if (!r.PLAYER_NAME) continue;
    const line = toLine((k) => num(r[k]));
    if (!line) continue;
    const age = num(r.AGE);
    out.push({ name: r.PLAYER_NAME, team: r.TEAM_ABBREVIATION || null, age: Number.isFinite(age) ? age : null, pos: r.POS || null, line });
  }
  return out;
}

/** Detects NBA.com JSON vs CSV by content. */
export function parseStatsFile(text: string): StatsRow[] {
  const t = text.trimStart();
  return t.startsWith("{") ? parseNbaLeagueStats(JSON.parse(t)) : parseStatsCsv(text);
}

// ------------------------------------------------------------------ blending

export const LATEST_WEIGHT = 0.7;
export const PRIOR_WEIGHT = 0.3;
export const MIN_LATEST_GP = 15;
export const MIN_PRIOR_GP = 20;

export type StatsSource = "nba_stats_blend" | "nba_stats_latest" | "nba_stats_prior";

const KEYS = ["pts", "fgm", "fga", "ftm", "fta", "threePm", "reb", "ast", "stl", "blk", "tov"] as const;

/**
 * 0.7 × latest + 0.3 × prior per-game when both seasons have enough games (prior GP ≥ 20);
 * latest alone when prior is missing/short; prior alone when the latest sample is tiny (< 15 GP, e.g. long injury).
 * The blended line's `gp` is the latest-season GP (prior-only: prior GP).
 */
export function blendStats(latest: PerGameLine | null, prior: PerGameLine | null): { line: PerGameLine; source: StatsSource } | null {
  const latestOk = latest !== null && latest.gp >= MIN_LATEST_GP;
  const priorOk = prior !== null && prior.gp >= MIN_PRIOR_GP;
  if (latestOk && priorOk) {
    const mix = (a: number, b: number) => LATEST_WEIGHT * a + PRIOR_WEIGHT * b;
    const line = { ...latest } as PerGameLine;
    for (const k of KEYS) line[k] = mix(latest[k], prior[k]);
    line.minutes = latest.minutes !== null && prior.minutes !== null ? mix(latest.minutes, prior.minutes) : latest.minutes;
    return { line, source: "nba_stats_blend" };
  }
  if (latestOk) return { line: latest, source: "nba_stats_latest" };
  if (priorOk) return { line: prior, source: "nba_stats_prior" };
  return null;
}

/** Games-played signal for the availability heuristic: 0.6 latest + 0.4 prior when both seasons exist, else whichever exists. */
export function effectiveGp(latestGp: number | null, priorGp: number | null): number | null {
  if (latestGp !== null && priorGp !== null) return 0.6 * latestGp + 0.4 * priorGp;
  return latestGp ?? priorGp;
}
