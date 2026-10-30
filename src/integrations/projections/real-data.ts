/**
 * Non-Yahoo real-data importer: NBA.com / Basketball-Reference per-game stats + FantasyPros / Hashtag Yahoo ADP
 * → data/projections.csv, yahoo-adp.csv, injuries.csv, projection-sources.csv.
 * Pure dataset building (buildRealDataset) is separated from fetching (loadStats / loadAdp) for offline tests.
 */
import fs from "node:fs";
import path from "node:path";
import type { InjuryStatus, Position } from "../../types";
import { assignAdp, deriveRisk, estimateMinutes, mapTeam, slugify, type ExistingRisk } from "../yahoo/heuristics";
import type { PerGameLine } from "../yahoo/stats";
import { parseAdpFile, parseFantasyProsAdp, parseHashtagAdp, FANTASYPROS_URL, HASHTAG_URL, type AdpEntry, type AdpSourceName } from "./adp-sources";
import { cachedText, type FetchOptions } from "./fetch-cache";
import { nameKey } from "./names";
import {
  NBA_HEADERS, bbrefUrl, blendStats, effectiveGp, mapNbaPosition, nbaPlayerIndexUrl, nbaSeasonLabel, nbaStatsUrl,
  parseBbrefPerGame, parseNbaLeagueStats, parseNbaPlayerIndex, parseStatsFile, type StatsRow, type StatsSource,
} from "./stats-sources";
import { adpTemplateLine, lineFromProjectionRow, readExisting, writeDatasetFiles, type DatasetRows, type ExistingData } from "./shared";

export type Log = (m: string) => void;
export type RealSource = StatsSource | "existing_csv" | "adp_template";

const DEFAULT_AGE = 27;
const FALLBACK_GP = 65; // rookies / template rows: no games-played signal
const POS_VALID = new Set(["PG", "SG", "SF", "PF", "C"]);
const f = (x: number, d: number) => x.toFixed(d);
const STATUS_CODE: Record<InjuryStatus, string> = { healthy: "", "day-to-day": "DTD", out: "O", "out-for-season": "INJ" };

// ------------------------------------------------------------------ dataset

export interface BuildInput {
  adp: AdpEntry[];
  latest: StatsRow[];
  prior: StatsRow[];
  /** normalized name → NBA.com POSITION, when the player index was available. */
  nbaIndex?: Map<string, string> | null;
  existing: ExistingData;
  nowIso: string;
  limit?: number;
  /** Append players that have NBA stats but no ADP entry (default true). */
  includeUnranked?: boolean;
  /** Stats-only players need >= this many GP in the latest or the prior season (default 10). */
  minGp?: number;
  /** ...and >= this many MPG in that same season (default 12). */
  minMin?: number;
}

export const DEFAULT_UNRANKED_MIN_GP = 10;
export const DEFAULT_UNRANKED_MIN_MIN = 12;
/** Stats-only players get ADP = max(universe ADP) + k × this. */
export const UNRANKED_ADP_STEP = 1.0;

/**
 * Per-game 9-category z-sum of every line against the pool (mean/std per category over the pool).
 * FG%/FT% enter as volume-weighted impact (made - pool% × attempts); turnovers count negatively.
 * Only used to order stats-only players among themselves.
 */
export function nineCatZSum(lines: PerGameLine[]): number[] {
  if (!lines.length) return [];
  const sum = (g: (l: PerGameLine) => number) => lines.reduce((a, l) => a + g(l), 0);
  const fgPct = sum((l) => l.fgm) / Math.max(1e-9, sum((l) => l.fga));
  const ftPct = sum((l) => l.ftm) / Math.max(1e-9, sum((l) => l.fta));
  const cats: ((l: PerGameLine) => number)[] = [
    (l) => l.pts, (l) => l.threePm, (l) => l.reb, (l) => l.ast, (l) => l.stl, (l) => l.blk, (l) => -l.tov,
    (l) => l.fgm - fgPct * l.fga, (l) => l.ftm - ftPct * l.fta,
  ];
  const z = new Array<number>(lines.length).fill(0);
  for (const g of cats) {
    const vals = lines.map(g);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    vals.forEach((v, i) => { z[i] += (v - mean) / sd; });
  }
  return z;
}

export interface RealDataset extends DatasetRows {
  skipped: { name: string; reason: string }[];
  /** ADP-universe players with no stats row in the latest season, and what they became. */
  adpUnmatched: { name: string; adp: number; resolvedAs: RealSource | "skipped" }[];
  /** Stats rows (≥15 GP, ≥15 MPG) that no ADP entry matched. */
  statsUnmatched: { name: string; team: string | null; pts: number }[];
  counts: Record<RealSource, number> & { universe: number; reusedIds: number; positionsFrom: Record<string, number>; unranked: number; unrankedSkipped: number };
}

function indexStats(rows: StatsRow[]): Map<string, StatsRow[]> {
  const m = new Map<string, StatsRow[]>();
  for (const r of rows) {
    const k = nameKey(r.name);
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return m;
}

function pick(cands: StatsRow[] | undefined, team: string | null): StatsRow | null {
  if (!cands?.length) return null;
  const t = mapTeam(team);
  const hit = t ? cands.find((c) => mapTeam(c.team) === t) : undefined;
  return hit ?? [...cands].sort((a, b) => b.line.gp * (b.line.minutes ?? 0) - a.line.gp * (a.line.minutes ?? 0))[0];
}

function existingPositions(ex: Record<string, string> | undefined): Position[] {
  const ps = (ex?.positions ?? "").split("/").map((p) => p.trim().toUpperCase()).filter((p) => POS_VALID.has(p));
  return ps as Position[];
}

export function buildRealDataset(input: BuildInput): RealDataset {
  const { existing } = input;
  const limit = input.limit ?? 250;
  const skipped: RealDataset["skipped"] = [];
  const latestIx = indexStats(input.latest);
  const priorIx = indexStats(input.prior);
  const exByKey = new Map<string, Record<string, string>>();
  for (const r of existing.projections.values()) exByKey.set(nameKey(r.name), r);

  // ADP universe: ascending ADP, de-duplicated by name key, top `limit`.
  const seen = new Set<string>();
  const universe = [...input.adp]
    .sort((a, b) => a.adp - b.adp || a.order - b.order)
    .filter((e) => {
      const k = nameKey(e.name);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);

  type Cand = { e: AdpEntry; key: string; latest: StatsRow | null; prior: StatsRow | null; blend: ReturnType<typeof blendStats>; ex: Record<string, string> | undefined; unranked?: boolean };
  const cands: Cand[] = universe.map((e) => {
    const key = nameKey(e.name);
    const latest = pick(latestIx.get(key), e.team);
    const prior = pick(priorIx.get(key), e.team);
    return { e, key, latest, prior, blend: blendStats(latest?.line ?? null, prior?.line ?? null), ex: exByKey.get(key) };
  });

  const pool = cands.filter((c) => c.blend).map((c) => ({ adp: c.e.adp, line: c.blend!.line }));
  const counts: RealDataset["counts"] = { nba_stats_blend: 0, nba_stats_latest: 0, nba_stats_prior: 0, existing_csv: 0, adp_template: 0, universe: universe.length, reusedIds: 0, positionsFrom: { existing: 0, adp_site: 0, nba_index: 0, stats_pos: 0 }, unranked: 0, unrankedSkipped: 0 };

  // Stats-only players (no ADP entry): qualifying GP/MPG in the latest or prior season, same blend as everyone else.
  // Ordered by the 9-cat z-sum of the blended line over the combined pool and placed after the last ADP player, 1.0 apart.
  const includedKeys = new Set(universe.map((e) => nameKey(e.name)));
  if (input.includeUnranked !== false) {
    const minGp = input.minGp ?? DEFAULT_UNRANKED_MIN_GP;
    const minMin = input.minMin ?? DEFAULT_UNRANKED_MIN_MIN;
    const qualifies = (r: StatsRow | null) => r !== null && r.line.gp >= minGp && (r.line.minutes ?? 0) >= minMin;
    const keys = new Set<string>();
    for (const r of [...input.latest, ...input.prior]) keys.add(nameKey(r.name));
    const extra: Cand[] = [];
    for (const key of keys) {
      if (includedKeys.has(key)) continue;
      const latest = pick(latestIx.get(key), null);
      const prior = pick(priorIx.get(key), null);
      if (!qualifies(latest) && !qualifies(prior)) continue;
      const blend = blendStats(latest?.line ?? null, prior?.line ?? null);
      const name = (latest ?? prior)!.name;
      if (!blend) {
        counts.unrankedSkipped++;
        skipped.push({ name, reason: "stats-only: too few games in either season for a projection" });
        continue;
      }
      extra.push({ e: { name, team: (latest ?? prior)!.team, positions: [], adp: 0, usedAverage: false, order: 0 }, key, latest, prior, blend, ex: exByKey.get(key) });
    }
    const z = nineCatZSum([...pool.map((p) => p.line), ...extra.map((c) => c.blend!.line)]);
    const zOf = new Map(extra.map((c, i) => [c, z[pool.length + i]]));
    extra.sort((a, b) => zOf.get(b)! - zOf.get(a)! || a.e.name.localeCompare(b.e.name));
    const maxAdp = universe.reduce((m, e) => Math.max(m, e.adp), 0);
    extra.forEach((c, i) => {
      c.e.adp = maxAdp + UNRANKED_ADP_STEP * (i + 1);
      c.e.order = 100_000 + i;
      c.unranked = true;
      cands.push(c);
      includedKeys.add(c.key);
    });
    counts.unranked = extra.length;
  }
  const adpUnmatched: RealDataset["adpUnmatched"] = [];

  type Row = { c: Cand; id: string; name: string; pos: Position[]; team: string; line: PerGameLine; source: RealSource; age: number };
  const rows: Row[] = [];
  const usedIds = new Set<string>();
  for (const c of cands) {
    const name = c.ex?.name || c.latest?.name || c.prior?.name || c.e.name;
    let line = c.blend?.line ?? null;
    let source: RealSource | null = c.blend?.source ?? null;
    if (!line) {
      const exLine = c.ex ? lineFromProjectionRow(c.ex) : null;
      if (exLine) {
        line = exLine;
        source = "existing_csv";
      } else {
        const t = adpTemplateLine(c.e.adp, pool);
        if (t) {
          // keep the line internally consistent (medians of independent stats are not)
          t.fgm = Math.min(t.fgm, t.fga * 0.9);
          t.threePm = Math.min(t.threePm, t.fgm * 0.9);
          t.ftm = Math.min(t.ftm, t.fta);
          t.pts = 2 * t.fgm + t.threePm + t.ftm;
        }
        line = t;
        source = "adp_template";
      }
    }
    if (!c.latest && !c.unranked) adpUnmatched.push({ name: c.e.name, adp: c.e.adp, resolvedAs: line ? source! : "skipped" });
    if (!line || !source) {
      skipped.push({ name: c.e.name, reason: "no stats, no existing row and no ADP donors for a template" });
      continue;
    }

    let pos: Position[] = existingPositions(c.ex);
    let posFrom = "existing";
    if (!pos.length) { pos = c.e.positions; posFrom = "adp_site"; }
    if (!pos.length) {
      const raw = input.nbaIndex?.get(nameKey(c.e.name)) ?? input.nbaIndex?.get(nameKey(name));
      pos = mapNbaPosition(raw);
      posFrom = "nba_index";
    }
    if (!pos.length) { pos = mapNbaPosition((c.latest ?? c.prior)?.pos); posFrom = "stats_pos"; }
    if (!pos.length) {
      skipped.push({ name: c.e.name, reason: "no PG/SG/SF/PF/C eligibility from any source" });
      continue;
    }
    const team = [mapTeam(c.e.team), mapTeam(c.latest?.team ?? null), mapTeam(c.ex?.nba_team ?? null)].find((t) => t && t.length === 3 && t !== "FA");
    if (!team) {
      skipped.push({ name: c.e.name, reason: "no usable 3-letter team" });
      continue;
    }
    counts.positionsFrom[posFrom]++;
    let id = c.ex?.id ?? slugify(name);
    if (c.ex) counts.reusedIds++;
    if (usedIds.has(id)) id = `${id}-${rows.length}`;
    usedIds.add(id);
    const ageRaw = c.latest?.age ?? (c.prior?.age != null ? c.prior.age + 1 : null);
    const age = ageRaw !== null && ageRaw !== undefined ? Math.round(ageRaw) : Number(c.ex?.age) || DEFAULT_AGE;
    counts[source]++;
    rows.push({ c, id, name, pos, team, line, source, age });
  }

  const adp = assignAdp(rows.map((r) => ({ key: r.id, orIndex: r.c.e.order, adp: r.c.e.adp })));
  const order = new Map(adp.map((a) => [a.key, a]));
  rows.sort((a, b) => order.get(a.id)!.rank - order.get(b.id)!.rank);

  const out: RealDataset = { projections: [], adp: [], injuries: [], sources: [], skipped, adpUnmatched, statsUnmatched: [], counts };
  for (const r of rows) {
    const exInj = existing.injuries.get(r.id);
    const exStatus = (exInj?.current_status ?? "healthy") as InjuryStatus;
    const exRisk: ExistingRisk | null = exInj
      ? { injuryHistoryScore: Number(exInj.injury_history_score), majorInjuryHistory: /^(true|1|yes)$/i.test(exInj.major_injury_history), restRisk: Number(exInj.rest_risk) }
      : null;
    // A veteran with a prior-season line but no latest-season row missed the season: count it as 0 GP.
    const latestGp = r.c.latest ? r.c.latest.line.gp : r.c.prior ? 0 : null;
    const gp = effectiveGp(latestGp, r.c.prior?.line.gp ?? null) ?? FALLBACK_GP;
    const risk = deriveRisk({ lastSeasonGp: gp, status: STATUS_CODE[exStatus] ?? "", injuryNote: exStatus === "out-for-season" ? "season" : null, existing: null });
    const l = r.line;
    out.sources.push({ player_id: r.id, source: r.source });
    out.projections.push({
      id: r.id, yahoo_player_key: "", name: r.c.ex?.name || r.name, nba_team: r.team, positions: r.pos.join("/"), age: String(r.age),
      games: String(risk.projectedGames), minutes: f(l.minutes ?? estimateMinutes(l.pts), 1), pts: f(l.pts, 2), fgm: f(l.fgm, 2), fga: f(l.fga, 2),
      ftm: f(l.ftm, 2), fta: f(l.fta, 2), three_pm: f(l.threePm, 2), reb: f(l.reb, 2), ast: f(l.ast, 2), stl: f(l.stl, 2), blk: f(l.blk, 2), tov: f(l.tov, 2),
    });
    const a = order.get(r.id)!;
    out.adp.push({ player_id: r.id, yahoo_adp: String(a.adp), adp_std_dev: String(a.stdDev), rank: String(a.rank) });
    out.injuries.push({
      player_id: r.id,
      projected_games: String(risk.projectedGames),
      current_status: risk.currentStatus,
      // existing history is kept verbatim; new players: 1 - availability (two-season GP)
      injury_history_score: f(exRisk ? exRisk.injuryHistoryScore : 1 - risk.availabilityScore, 2),
      rest_risk: f(exRisk?.restRisk ?? 0.1, 2),
      availability_score: f(risk.availabilityScore, 2),
      major_injury_history: String(exRisk?.majorInjuryHistory ?? false),
      updated_at: input.nowIso,
    });
  }

  const matched = new Set([...input.adp.map((e) => nameKey(e.name)), ...includedKeys]);
  out.statsUnmatched = input.latest
    .filter((s) => !matched.has(nameKey(s.name)) && s.line.gp >= 15 && (s.line.minutes ?? 0) >= 15)
    .sort((a, b) => b.line.pts - a.line.pts)
    .map((s) => ({ name: s.name, team: s.team, pts: s.line.pts }));
  return out;
}

// ------------------------------------------------------------------ fetching

export interface LoadOptions extends FetchOptions {
  /** end year of the latest completed season (2026 = 2025-26). */
  endYear: number;
  statsSource?: "auto" | "nba" | "bbref" | "file";
  statsFile?: string;
  priorStatsFile?: string;
  adpFile?: string;
}

export interface LoadedStats {
  provider: "nba.com" | "basketball-reference" | "file";
  latest: StatsRow[];
  prior: StatsRow[];
  nbaIndex: Map<string, string> | null;
  notes: string[];
}

const BROWSER_HTML_HEADERS = {
  "User-Agent": NBA_HEADERS["User-Agent"],
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const MIN_ROWS = 150;

async function tryNba(o: LoadOptions): Promise<LoadedStats> {
  const log = o.log ?? (() => {});
  const cur = nbaSeasonLabel(o.endYear);
  const prev = nbaSeasonLabel(o.endYear - 1);
  const get = async (name: string, url: string, validate: (t: string) => void) => {
    const r = await cachedText(name, url, NBA_HEADERS, o, validate);
    log(`  NBA.com ${name}: ${r.fromCache ? "cache" : "live"}`);
    return r.text;
  };
  const stats = (n: string) => (t: string) => { if (parseNbaLeagueStats(JSON.parse(t)).length < MIN_ROWS) throw new Error(`${n}: too few rows`); };
  const latest = parseNbaLeagueStats(JSON.parse(await get(`nba-stats-${cur}.json`, nbaStatsUrl(cur), stats(cur))));
  const notes: string[] = [];
  let prior: StatsRow[] = [];
  try {
    prior = parseNbaLeagueStats(JSON.parse(await get(`nba-stats-${prev}.json`, nbaStatsUrl(prev), stats(prev))));
  } catch (e) {
    notes.push(`prior season ${prev} unavailable (${(e as Error).message}); using latest only`);
  }
  let nbaIndex: Map<string, string> | null = null;
  try {
    nbaIndex = parseNbaPlayerIndex(JSON.parse(await get(`nba-playerindex-${cur}.json`, nbaPlayerIndexUrl(cur), (t) => { parseNbaPlayerIndex(JSON.parse(t)); })));
  } catch (e) {
    notes.push(`NBA.com player index unavailable (${(e as Error).message}); positions come from ADP site / existing CSV`);
  }
  return { provider: "nba.com", latest, prior, nbaIndex, notes };
}

async function tryBbref(o: LoadOptions): Promise<LoadedStats> {
  const log = o.log ?? (() => {});
  const get = async (year: number) => {
    const name = `bbref-per-game-${year}.html`;
    const r = await cachedText(name, bbrefUrl(year), BROWSER_HTML_HEADERS, { ...o, retries: Math.min(o.retries ?? 3, 2) }, (t) => { if (parseBbrefPerGame(t).length < MIN_ROWS) throw new Error(`${name}: too few rows`); });
    log(`  Basketball-Reference ${name}: ${r.fromCache ? "cache" : "live"}`);
    return parseBbrefPerGame(r.text);
  };
  const latest = await get(o.endYear);
  const notes: string[] = [];
  let prior: StatsRow[] = [];
  try {
    prior = await get(o.endYear - 1);
  } catch (e) {
    notes.push(`prior season unavailable (${(e as Error).message}); using latest only`);
  }
  return { provider: "basketball-reference", latest, prior, nbaIndex: null, notes };
}

/** Provider chain: NBA.com → Basketball-Reference (auto), or a single explicit provider / user file. */
export async function loadStats(o: LoadOptions): Promise<LoadedStats> {
  const log = o.log ?? (() => {});
  const mode = o.statsFile ? "file" : (o.statsSource ?? "auto");
  if (mode === "file") {
    if (!o.statsFile) throw new Error("--stats-source=file needs --stats-file=<path>");
    const latest = parseStatsFile(fs.readFileSync(o.statsFile, "utf8"));
    const prior = o.priorStatsFile ? parseStatsFile(fs.readFileSync(o.priorStatsFile, "utf8")) : [];
    return { provider: "file", latest, prior, nbaIndex: null, notes: o.priorStatsFile ? [] : ["no --prior-stats-file: latest season only"] };
  }
  const errors: string[] = [];
  if (mode === "auto" || mode === "nba") {
    try {
      return await tryNba(o);
    } catch (e) {
      errors.push(`NBA.com: ${(e as Error).message}`);
      log(`NBA.com stats failed (${(e as Error).message})`);
      if (mode === "nba") throw new Error(errors.join("; "));
    }
  }
  try {
    const r = await tryBbref(o);
    r.notes.unshift(...errors.map((e) => `fell back to Basketball-Reference after ${e}`));
    return r;
  } catch (e) {
    errors.push(`Basketball-Reference: ${(e as Error).message}`);
    throw new Error(`Could not load season stats (${errors.join("; ")}). Download manually and pass --stats-file=<csv|json> (see README).`);
  }
}

export async function loadAdp(o: LoadOptions): Promise<{ source: AdpSourceName; entries: AdpEntry[]; notes: string[] }> {
  const log = o.log ?? (() => {});
  if (o.adpFile) {
    const r = parseAdpFile(fs.readFileSync(o.adpFile, "utf8"));
    if (!r.entries.length) throw new Error(`--adp-file ${o.adpFile}: no ADP rows recognised`);
    return { ...r, notes: [] };
  }
  const notes: string[] = [];
  const tries: { source: AdpSourceName; name: string; url: string; parse: (h: string) => AdpEntry[] }[] = [
    { source: "fantasypros", name: "adp-fantasypros.html", url: FANTASYPROS_URL, parse: parseFantasyProsAdp },
    { source: "hashtag", name: "adp-hashtag.html", url: HASHTAG_URL, parse: parseHashtagAdp },
  ];
  for (const t of tries) {
    try {
      const r = await cachedText(t.name, t.url, BROWSER_HTML_HEADERS, o, (h) => { if (t.parse(h).length < 50) throw new Error("fewer than 50 ADP rows parsed"); });
      const entries = t.parse(r.text);
      if (entries.length < 50) throw new Error("fewer than 50 ADP rows parsed");
      log(`  ADP ${t.source}: ${entries.length} rows (${r.fromCache ? "cache" : "live"})`);
      return { source: t.source, entries, notes };
    } catch (e) {
      notes.push(`${t.source} ADP failed: ${(e as Error).message}`);
      log(`ADP ${t.source} failed (${(e as Error).message})`);
    }
  }
  throw new Error(`Could not load ADP (${notes.join("; ")}). Save the FantasyPros/Hashtag page (or a name,adp CSV) and pass --adp-file=<path>.`);
}

// ------------------------------------------------------------------ orchestration

export interface RunOptions extends LoadOptions {
  dataDir: string;
  now?: Date;
  limit?: number;
  dryRun?: boolean;
  includeUnranked?: boolean;
  minGp?: number;
  minMin?: number;
}

export interface RunSummary {
  stats: LoadedStats;
  adpSource: AdpSourceName;
  adpNotes: string[];
  adpUsedAverage: number;
  dataset: RealDataset;
  backupDir: string | null;
}

export async function runRealImport(o: RunOptions): Promise<RunSummary> {
  const now = o.now ?? new Date();
  const stats = await loadStats(o);
  const adp = await loadAdp(o);
  const dataset = buildRealDataset({
    adp: adp.entries, latest: stats.latest, prior: stats.prior, nbaIndex: stats.nbaIndex, existing: readExisting(o.dataDir),
    nowIso: now.toISOString().replace(/\.\d+Z$/, "Z"), limit: o.limit,
    includeUnranked: o.includeUnranked, minGp: o.minGp, minMin: o.minMin,
  });
  if (!dataset.projections.length) throw new Error("import produced no players");
  const backupDir = o.dryRun ? null : writeDatasetFiles(o.dataDir, dataset, now);
  return { stats, adpSource: adp.source, adpNotes: adp.notes, adpUsedAverage: adp.entries.filter((e) => e.usedAverage).length, dataset, backupDir };
}

export function defaultCacheDir(dataDir: string): string {
  return path.join(dataDir, "cache");
}
