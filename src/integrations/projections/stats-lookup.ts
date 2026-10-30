/**
 * Fast, never-throwing lookup of a single player in the cached NBA.com season stats (data/cache/nba-stats-<season>.json).
 * Used by the live Yahoo draft sync so a player we have no row for still gets a real per-game projection.
 * Parsed files are memoised in-process by (path, mtime); the cache directory is injectable for tests.
 */
import fs from "node:fs";
import path from "node:path";
import type { Position } from "../../types";
import { deriveRisk, estimateMinutes, mapTeam } from "../yahoo/heuristics";
import type { PerGameLine } from "../yahoo/stats";
import { nameKey } from "./names";
import { blendStats, effectiveGp, mapNbaPosition, parseNbaLeagueStats, parseNbaPlayerIndex, parseNbaPlayerIndexMeta, type PlayerIndexMeta, type StatsRow } from "./stats-sources";

export interface FoundStats {
  name: string;
  /** Latest-season (else prior) NBA.com team, 3-letter. */
  team: string | null;
  age: number;
  positions: Position[];
  /** Blended per-game line (0.7 latest / 0.3 prior when both qualify; whichever season exists otherwise). */
  line: PerGameLine;
  /** Projected games for the projection row (same heuristic as the importer). */
  games: number;
  minutes: number;
}

export interface StatsLookupQuery {
  playerName: string;
  nbaTeam?: string | null;
}

interface Loaded {
  latest: Indexed;
  prior: Indexed;
  positions: Map<string, string>;
}
interface Indexed {
  full: Map<string, StatsRow[]>;
  initial: Map<string, StatsRow[]>;
}

const fileCache = new Map<string, { mtimeMs: number; value: unknown }>();
const emptyIndexed = (): Indexed => ({ full: new Map(), initial: new Map() });

function memoFile<T>(file: string, parse: (text: string) => T): T | null {
  try {
    const st = fs.statSync(file);
    const hit = fileCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.value as T;
    const value = parse(fs.readFileSync(file, "utf8"));
    fileCache.set(file, { mtimeMs: st.mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

function initialKey(name: string): string {
  const t = nameKey(name).split(" ").filter(Boolean);
  return t.length < 2 ? "" : `${t[0][0]}|${t[t.length - 1]}`;
}

function index(rows: StatsRow[]): Indexed {
  const ix = emptyIndexed();
  for (const r of rows) {
    const push = (m: Map<string, StatsRow[]>, k: string) => { if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(r); };
    push(ix.full, nameKey(r.name));
    push(ix.initial, initialKey(r.name));
  }
  return ix;
}

/** Season labels ("2025-26") with a cached stats file, newest first. */
function seasons(dir: string): string[] {
  try {
    return fs.readdirSync(dir).map((f) => /^nba-stats-(\d{4}-\d{2})\.json$/.exec(f)?.[1]).filter((s): s is string => !!s).sort().reverse();
  } catch {
    return [];
  }
}

function load(dir: string): Loaded | null {
  const [cur, prev] = seasons(dir);
  if (!cur) return null;
  const read = (s: string | undefined): Indexed => {
    if (!s) return emptyIndexed();
    return memoFile(path.join(dir, `nba-stats-${s}.json`), (t) => index(parseNbaLeagueStats(JSON.parse(t)))) ?? emptyIndexed();
  };
  const positions = memoFile(path.join(dir, `nba-playerindex-${cur}.json`), (t) => parseNbaPlayerIndex(JSON.parse(t))) ?? new Map<string, string>();
  return { latest: read(cur), prior: read(prev), positions };
}

export function defaultStatsCacheDir(): string {
  // STATS_CACHE_DIR: tests point this at a small fixture folder so results never depend on the machine's own data/cache
  return process.env.STATS_CACHE_DIR || path.join(process.cwd(), "data", "cache");
}

/** Clears the in-process parse cache (tests). */
export function resetStatsLookupCache(): void {
  fileCache.clear();
}

function pickRow(ix: Indexed, q: StatsLookupQuery): StatsRow | null {
  let cands = ix.full.get(nameKey(q.playerName)) ?? [];
  if (!cands.length) cands = ix.initial.get(initialKey(q.playerName)) ?? [];
  if (cands.length > 1 && q.nbaTeam) {
    const t = mapTeam(q.nbaTeam);
    const byTeam = cands.filter((c) => mapTeam(c.team) === t);
    if (byTeam.length) cands = byTeam;
  }
  // Several namesakes ("J. Williams") and no way to tell them apart: do not guess.
  return cands.length === 1 ? cands[0] : null;
}

/**
 * Finds "Caris LeVert" / "C. LeVert" (+ optional Yahoo team) in the cached stats. Initial+last-name matching is used
 * when the full name does not match; ambiguous namesakes return null. Never throws.
 */
export function lookupCachedStats(q: StatsLookupQuery, cacheDir: string = defaultStatsCacheDir()): FoundStats | null {
  try {
    const d = load(cacheDir);
    if (!d) return null;
    let latest = pickRow(d.latest, q);
    // The prior row is the same person: match it by the latest row's full name when we have one.
    const prior = pickRow(d.prior, latest ? { playerName: latest.name, nbaTeam: null } : q);
    if (!latest && !prior) return null;
    latest ??= null;
    const base = latest ?? prior!;
    const blend = blendStats(latest?.line ?? null, prior?.line ?? null);
    // Thin samples (a handful of games) still beat zeros: use whatever line exists.
    const line = blend?.line ?? (latest && prior ? (latest.line.gp >= prior.line.gp ? latest.line : prior.line) : base.line);
    const latestGp = latest ? latest.line.gp : prior ? 0 : null;
    const gp = effectiveGp(latestGp, prior?.line.gp ?? null) ?? 65;
    const risk = deriveRisk({ lastSeasonGp: gp, status: "", injuryNote: null, existing: null });
    const ageRaw = latest?.age ?? (prior?.age != null ? prior.age + 1 : null);
    let positions = mapNbaPosition(d.positions.get(nameKey(base.name)));
    if (!positions.length) positions = mapNbaPosition(base.pos);
    return {
      name: base.name,
      team: mapTeam(base.team),
      age: ageRaw != null ? Math.round(ageRaw) : 27,
      positions,
      line,
      games: risk.projectedGames,
      minutes: line.minutes ?? estimateMinutes(line.pts),
    };
  } catch {
    return null;
  }
}

/** A single season's NBA.com per-game stats, indexed for name lookups (null when that season's cache file is absent/unreadable). */
export interface SeasonStats {
  season: string;
  find: (q: StatsLookupQuery) => StatsRow | null;
}

/** Loads data/cache/nba-stats-<season>.json on its own (no blending with other seasons). Never throws. */
export function loadSeasonStats(season: string, cacheDir: string = defaultStatsCacheDir()): SeasonStats | null {
  const ix = memoFile(path.join(cacheDir, `nba-stats-${season}.json`), (t) => index(parseNbaLeagueStats(JSON.parse(t))));
  if (!ix) return null;
  return { season, find: (q) => pickRow(ix, q) };
}

/** First-season / draft-year facts from the newest cached NBA.com playerindex (null when absent). Memoised by mtime. */
export function loadPlayerIndexMeta(cacheDir: string = defaultStatsCacheDir()): Map<string, PlayerIndexMeta> | null {
  try {
    const f = fs.readdirSync(cacheDir).filter((x) => /^nba-playerindex-\d{4}-\d{2}\.json$/.test(x)).sort().pop();
    return f ? memoFile(path.join(cacheDir, f), (t) => parseNbaPlayerIndexMeta(JSON.parse(t))) : null;
  } catch {
    return null;
  }
}
