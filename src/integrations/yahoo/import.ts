import {
  ADP_COLUMNS,
  INJURY_COLUMNS,
  PROJECTION_COLUMNS,
  SOURCE_COLUMNS,
  adpTemplateLine,
  lineFromProjectionRow,
  readExisting,
  toCsv,
  writeDatasetFiles,
  type ExistingData,
} from "../projections/shared";
import type { YahooGet } from "./client";
import { YahooError, isShapeError } from "./errors";
import { assignAdp, deriveRisk, estimateMinutes, mapPositions, mapTeam, slugify, type ExistingRisk } from "./heuristics";
import {
  mergePlayer,
  normalizeGame,
  normalizePlayers,
  normalizeSinglePlayer,
  type YahooGame,
  type YahooPlayer,
} from "./normalize";
import { STAT, projectionUsable, statsToPerGame, type PerGameLine } from "./stats";

export type SourceFlag = "projected" | "last_season" | "auto";
export type LineSource = "yahoo_projected" | "last_season";
/** Where a written projection row came from (data/projection-sources.csv). */
export type ProjectionSource = LineSource | "existing_csv" | "adp_template";
export type Log = (msg: string) => void;

// Shared CSV pieces live in ../projections/shared; re-exported here for existing callers.
export { ADP_COLUMNS, INJURY_COLUMNS, PROJECTION_COLUMNS, SOURCE_COLUMNS, adpTemplateLine, lineFromProjectionRow, readExisting, toCsv };
export type { ExistingData };

const PAGE = 25;
const DEFAULT_AGE = "27";
const FALLBACK_LAST_GP = 65; // rookies with projections but no last-season sample

// ------------------------------------------------------------------ fetching

export async function resolveGame(get: YahooGet): Promise<YahooGame> {
  return normalizeGame(await get("game/nba"));
}

/** One page of players in Yahoo overall-rank order with draft_analysis + percent_owned, trying progressively simpler request shapes. */
export async function fetchPlayerPage(get: YahooGet, gameKey: string, start: number, count: number, log: Log = () => {}): Promise<YahooPlayer[]> {
  const base = `game/${gameKey}/players;start=${start};count=${count};sort=OR`;
  const tiers: { name: string; run: () => Promise<YahooPlayer[]> }[] = [
    {
      name: "collection ;out=",
      run: async () => normalizePlayers(await get(`${base};out=draft_analysis,percent_owned`)),
    },
    {
      name: "collection /sub-resource",
      run: async () => {
        const list = normalizePlayers(await get(`${base}/draft_analysis`));
        const owned = new Map(normalizePlayers(await get(`${base}/percent_owned`)).map((p) => [p.playerKey, p]));
        return list.map((p) => mergePlayer(p, owned.get(p.playerKey) ?? null));
      },
    },
    {
      name: "per-player",
      run: async () => {
        const list = normalizePlayers(await get(base));
        const out: YahooPlayer[] = [];
        for (const p of list) {
          let merged = p;
          for (const sub of ["draft_analysis", "percent_owned"]) {
            try {
              merged = mergePlayer(merged, normalizeSinglePlayer(await get(`player/${p.playerKey}/${sub}`)));
            } catch (e) {
              if (!isShapeError(e)) throw e;
            }
          }
          out.push(merged);
        }
        return out;
      },
    },
  ];
  let lastErr: unknown;
  for (const t of tiers) {
    try {
      const res = await t.run();
      if (res.length === 0 || res.some((p) => p.hasDraftAnalysis) || t.name === "per-player") {
        if (t.name !== tiers[0].name) log(`players page ${start}: used ${t.name} fallback`);
        return res;
      }
      lastErr = new YahooError("PARSE", `${t.name} returned players without draft_analysis`);
    } catch (e) {
      if (!isShapeError(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new YahooError("PARSE", "Could not fetch players page");
}

export async function fetchRankedPlayers(get: YahooGet, gameKey: string, limit: number, log: Log = () => {}): Promise<YahooPlayer[]> {
  const out: YahooPlayer[] = [];
  const seen = new Set<string>();
  for (let start = 0; start < limit; start += PAGE) {
    const page = await fetchPlayerPage(get, gameKey, start, Math.min(PAGE, limit - start), log);
    for (const p of page) if (!seen.has(p.playerKey)) {
        seen.add(p.playerKey);
        out.push(p);
      }
    if (page.length < Math.min(PAGE, limit - start)) break;
  }
  return out;
}

/** stat_id maps keyed by player_key for a stats spec such as "type=season;season=2025". Collection form first, per-player fallback. */
export async function fetchStats(get: YahooGet, gameKey: string, keys: string[], spec: string, log: Log = () => {}): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  for (let i = 0; i < keys.length; i += PAGE) {
    const chunk = keys.slice(i, i + PAGE);
    let ok = false;
    try {
      let got = 0;
      for (const p of normalizePlayers(await get(`game/${gameKey}/players;player_keys=${chunk.join(",")}/stats;${spec}`)))
        if (p.stats) {
          out.set(p.playerKey, p.stats);
          got++;
        }
      ok = got > 0;
    } catch (e) {
      if (!isShapeError(e)) throw e;
    }
    if (!ok) {
      log(`stats (${spec}) chunk ${i / PAGE}: collection form failed, falling back to per-player calls`);
      for (const k of chunk) {
        try {
          const p = normalizeSinglePlayer(await get(`player/${k}/stats;${spec}`));
          if (p?.stats) out.set(k, p.stats);
        } catch (e) {
          if (!isShapeError(e)) throw e;
        }
      }
    }
  }
  return out;
}

export interface ProbeResult {
  playerKey: string;
  name: string;
  usable: boolean;
  error?: string;
  rawStats: Record<string, string> | null;
}

/** Tests whether `stats;type=projected_season` yields usable data for the first `n` ranked players. */
export async function probeProjections(get: YahooGet, n = 3, log: Log = () => {}): Promise<{ game: YahooGame; results: ProbeResult[] }> {
  const game = await resolveGame(get);
  const players = (await fetchPlayerPage(get, game.gameKey, 0, n, log)).slice(0, n);
  const results: ProbeResult[] = [];
  for (const p of players) {
    try {
      const sp = normalizeSinglePlayer(await get(`player/${p.playerKey}/stats;type=projected_season`));
      results.push({ playerKey: p.playerKey, name: p.name, usable: projectionUsable(sp?.stats), rawStats: sp?.stats ?? null });
    } catch (e) {
      if (!isShapeError(e)) throw e;
      results.push({ playerKey: p.playerKey, name: p.name, usable: false, rawStats: null, error: (e as Error).message });
    }
  }
  return { game, results };
}

// ------------------------------------------------------------------ dataset

export interface Candidate {
  yp: YahooPlayer;
  /** 0-based position in Yahoo overall-rank order. */
  orIndex: number;
  line: PerGameLine | null;
  lineSource: LineSource | null;
  /** Last season's games played (null = no last-season sample). */
  lastGp: number | null;
}

export interface Dataset {
  projections: Record<string, string>[];
  adp: Record<string, string>[];
  injuries: Record<string, string>[];
  /** player_id → where the projection line came from. */
  sources: Record<string, string>[];
  skipped: { name: string; reason: string }[];
  stats: { fromProjected: number; fromLastSeason: number; fromExistingCsv: number; fromAdpTemplate: number; adpFallback: number; ageDefaulted: number; reusedIds: number };
}

const f = (x: number, d: number) => x.toFixed(d);

export function buildDataset(cands: Candidate[], existing: ExistingData, nowIso: string): Dataset {
  const skipped: Dataset["skipped"] = [];
  const bySlug = new Map<string, Record<string, string>>();
  for (const r of existing.projections.values()) bySlug.set(slugify(r.name), r);

  type Row = { c: Candidate; id: string; pos: string[]; team: string; line: PerGameLine; source: ProjectionSource; ex: Record<string, string> | undefined };
  const rows: Row[] = [];
  const pool = cands.filter((c) => c.line && c.yp.averagePick !== null).map((c) => ({ adp: c.yp.averagePick as number, line: c.line as PerGameLine }));
  const usedIds = new Set<string>();
  let reused = 0;
  for (const c of cands) {
    const name = c.yp.name;
    const slug = slugify(name);
    const ex = bySlug.get(slug);
    let line = c.line;
    let source: ProjectionSource | null = c.lineSource;
    if (!line) {
      // Rookie / no usable stats: keep high-ADP players on the board.
      if (c.yp.averagePick === null) {
        skipped.push({ name, reason: "no usable stats and no Yahoo ADP" });
        continue;
      }
      const existingLine = ex ? lineFromProjectionRow(ex) : null;
      if (existingLine) {
        line = existingLine;
        source = "existing_csv";
      } else {
        line = adpTemplateLine(c.yp.averagePick, pool);
        source = "adp_template";
        if (!line) {
          skipped.push({ name, reason: "no usable stats and no ADP-similar players to template from" });
          continue;
        }
      }
    }
    const pos = mapPositions(c.yp);
    if (!pos.length) {
      skipped.push({ name, reason: "no PG/SG/SF/PF/C eligibility" });
      continue;
    }
    const team = mapTeam(c.yp.teamAbbr);
    if (!team || team.length !== 3) {
      skipped.push({ name, reason: `unusable team "${c.yp.teamAbbr ?? ""}"` });
      continue;
    }
    let id = ex?.id ?? slug;
    if (ex) reused++;
    if (usedIds.has(id)) id = `${slug}-${c.yp.playerId}`;
    usedIds.add(id);
    rows.push({ c, id, pos, team, line, source: source!, ex: ex ?? existing.projections.get(id) });
  }

  const adp = assignAdp(rows.map((r) => ({ key: r.id, orIndex: r.c.orIndex, adp: r.c.yp.averagePick })));
  const order = new Map(adp.map((a) => [a.key, a]));
  rows.sort((a, b) => order.get(a.id)!.rank - order.get(b.id)!.rank);

  const out: Dataset = { projections: [], adp: [], injuries: [], sources: [], skipped, stats: { fromProjected: 0, fromLastSeason: 0, fromExistingCsv: 0, fromAdpTemplate: 0, adpFallback: 0, ageDefaulted: 0, reusedIds: reused } };
  for (const r of rows) {
    const exInj = existing.injuries.get(r.id);
    const exRisk: ExistingRisk | null = exInj
      ? { injuryHistoryScore: Number(exInj.injury_history_score), majorInjuryHistory: /^(true|1|yes)$/i.test(exInj.major_injury_history), restRisk: Number(exInj.rest_risk) }
      : null;
    const risk = deriveRisk({ lastSeasonGp: r.c.lastGp ?? FALLBACK_LAST_GP, status: r.c.yp.status, injuryNote: r.c.yp.injuryNote, existing: exRisk });
    const l = r.line;
    if (r.source === "yahoo_projected") out.stats.fromProjected++;
    else if (r.source === "last_season") out.stats.fromLastSeason++;
    else if (r.source === "existing_csv") out.stats.fromExistingCsv++;
    else out.stats.fromAdpTemplate++;
    out.sources.push({ player_id: r.id, source: r.source });
    if (!r.ex?.age) out.stats.ageDefaulted++;
    out.projections.push({
      id: r.id,
      yahoo_player_key: r.c.yp.playerKey,
      name: r.c.yp.name,
      nba_team: r.team,
      positions: r.pos.join("/"),
      age: r.ex?.age || DEFAULT_AGE,
      games: String(risk.projectedGames),
      minutes: f(l.minutes ?? estimateMinutes(l.pts), 1),
      pts: f(l.pts, 2),
      fgm: f(l.fgm, 2),
      fga: f(l.fga, 2),
      ftm: f(l.ftm, 2),
      fta: f(l.fta, 2),
      three_pm: f(l.threePm, 2),
      reb: f(l.reb, 2),
      ast: f(l.ast, 2),
      stl: f(l.stl, 2),
      blk: f(l.blk, 2),
      tov: f(l.tov, 2),
    });
    const a = order.get(r.id)!;
    if (a.fallback) out.stats.adpFallback++;
    out.adp.push({ player_id: r.id, yahoo_adp: String(a.adp), adp_std_dev: String(a.stdDev), rank: String(a.rank) });
    out.injuries.push({
      player_id: r.id,
      projected_games: String(risk.projectedGames),
      current_status: risk.currentStatus,
      injury_history_score: f(risk.injuryHistoryScore, 2),
      rest_risk: f(risk.restRisk, 2),
      availability_score: f(risk.availabilityScore, 2),
      major_injury_history: String(risk.majorInjuryHistory),
      updated_at: nowIso,
    });
  }
  return out;
}

// ------------------------------------------------------------------ orchestration

export interface ImportOptions {
  get: YahooGet;
  dataDir: string;
  source?: SourceFlag;
  limit?: number;
  now?: Date;
  log?: Log;
  dryRun?: boolean;
}

export interface ImportSummary {
  game: YahooGame;
  sourceUsed: "projected" | "last_season";
  counts: { fetched: number; written: number };
  dataset: Dataset;
  backupDir: string | null;
  statScales: string[];
}

export async function runImport(opts: ImportOptions): Promise<ImportSummary> {
  const log = opts.log ?? (() => {});
  const { get } = opts;
  const mode = opts.source ?? "auto";
  const limit = opts.limit ?? 300;
  const now = opts.now ?? new Date();

  const game = await resolveGame(get);
  log(`Yahoo NBA game_key=${game.gameKey} season=${game.season}`);

  let sourceUsed: "projected" | "last_season";
  if (mode === "auto") {
    const probe = await probeProjections(get, 3, log);
    const ok = probe.results.filter((r) => r.usable).length;
    sourceUsed = ok >= 2 ? "projected" : "last_season";
    log(`auto: projected_season usable for ${ok}/${probe.results.length} probed players -> using ${sourceUsed === "projected" ? "yahoo_projected" : "last_season"}`);
  } else sourceUsed = mode;

  const ranked = await fetchRankedPlayers(get, game.gameKey, limit, log);
  log(`fetched ${ranked.length} ranked players (sort=OR)`);
  const keys = ranked.map((p) => p.playerKey);

  const lastSpec = `type=season;season=${game.season - 1}`;
  const lastStats = await fetchStats(get, game.gameKey, keys, lastSpec, log);
  log(`last-season (${game.season - 1}) stats for ${lastStats.size}/${keys.length} players`);
  const projStats = sourceUsed === "projected" ? await fetchStats(get, game.gameKey, keys, "type=projected_season", log) : new Map<string, Record<string, string>>();
  if (sourceUsed === "projected") log(`projected_season stats for ${projStats.size}/${keys.length} players`);

  const scales = new Set<string>();
  const cands: Candidate[] = ranked.map((yp, orIndex) => {
    const last = statsToPerGame(lastStats.get(yp.playerKey));
    let line: PerGameLine | null = null;
    let lineSource: LineSource | null = null;
    if (sourceUsed === "projected") {
      const raw = projStats.get(yp.playerKey);
      if (projectionUsable(raw)) {
        const r = statsToPerGame(raw);
        if (r.line) {
          line = r.line;
          lineSource = "yahoo_projected";
          scales.add(`projected:${r.scale}`);
        }
      }
    } else if (last.line) {
      line = last.line;
      lineSource = "last_season";
      scales.add(`last_season:${last.scale}`);
    }
    const lastGpRaw = lastStats.get(yp.playerKey)?.[STAT.GP];
    const gp = lastGpRaw === undefined ? null : Number(lastGpRaw);
    return { yp, orIndex, line, lineSource, lastGp: gp !== null && Number.isFinite(gp) ? gp : null };
  });

  const dataset = buildDataset(cands, readExisting(opts.dataDir), now.toISOString().replace(/\.\d+Z$/, "Z"));

  const backupDir = opts.dryRun ? null : writeDatasetFiles(opts.dataDir, dataset, now);
  return { game, sourceUsed, counts: { fetched: ranked.length, written: dataset.projections.length }, dataset, backupDir, statScales: [...scales] };
}
