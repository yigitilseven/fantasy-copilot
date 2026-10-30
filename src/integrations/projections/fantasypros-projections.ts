/**
 * FantasyPros consensus NBA season projections (https://www.fantasypros.com/nba/projections/overall.php): season TOTALS for
 * PTS REB AST BLK STL FG% FT% 3PM GP MIN TO per player ("Shai Gilgeous-Alexander (OKC - PG)"). Dependency-free HTML parsing; the
 * table has a header row, so columns are located by their labels (a reordering or an added column does not break the parse).
 *
 * It is the optional third source of the projection blend: per player the "projection side" is average(Yahoo, FantasyPros)
 * per stat when both exist (engine/projection/blend.ts), and FantasyPros' MIN/GP is the only forward-looking minutes figure
 * (Yahoo's table has none), which anchors the projected minutes.
 */
import fs from "node:fs";
import path from "node:path";
import type { Position, ProjectionLine } from "../../types";
import { canonicalTeam } from "../../engine/projection/blend";
import { deriveAttempts } from "../yahoo/projection-merge";
import { cachedText, type FetchOptions } from "./fetch-cache";
import { nameKey } from "./names";
import { parsePositionList } from "./adp-sources";

export const FP_PROJECTIONS_URL = "https://www.fantasypros.com/nba/projections/overall.php";
export const FP_PROJECTIONS_CACHE = "fantasypros-projections-2026-27.html";
/** The refresh helper treats a cache older than this as stale. */
export const FP_PROJECTIONS_MAX_AGE_MS = 12 * 3_600_000;

export interface FpProjectionRow {
  name: string;
  team: string | null;
  positions: Position[];
  /** Season totals as listed. */
  gp: number;
  min: number | null;
  pts: number;
  reb: number;
  ast: number;
  blk: number;
  stl: number;
  fgPct: number;
  ftPct: number;
  threePm: number;
  tov: number;
}

const decode = (s: string) =>
  s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** "2,394" -> 2394, ".528" -> 0.528, "-" -> null. */
function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.replace(/,/g, "").trim();
  if (!t || t === "-" || t === "--") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parses the projections table; rows missing any category (or with GP <= 0) are skipped. */
export function parseFantasyProsProjections(html: string): FpProjectionRow[] {
  const start = html.indexOf('id="data"');
  if (start < 0) return [];
  const tbl = html.slice(start);
  const head = /<thead[\s\S]*?<\/thead>/.exec(tbl)?.[0] ?? "";
  const cols = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => decode(m[1]).toUpperCase());
  const ix = (label: string) => cols.indexOf(label);
  const need = ["PTS", "REB", "AST", "BLK", "STL", "FG%", "FT%", "3PM", "GP", "TO"].map((l) => [l, ix(l)] as const);
  if (need.some(([, i]) => i < 0)) return [];
  const colOf = Object.fromEntries(need) as Record<string, number>;
  const minCol = ix("MIN");
  const out: FpProjectionRow[] = [];
  for (const row of tbl.slice(head.length).split(/<tr[\s>]/).slice(1)) {
    const nameM = /<a[^>]*class="[^"]*player-name[^"]*"[^>]*>([^<]+)<\/a>\s*(?:<small>\(([^)]*)\)<\/small>)?/.exec(row);
    if (!nameM) continue;
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decode(m[1]));
    const v = (label: string) => num(tds[colOf[label]]);
    const [pts, reb, ast, blk, stl, fgPct, ftPct, threePm, gp, tov] = ["PTS", "REB", "AST", "BLK", "STL", "FG%", "FT%", "3PM", "GP", "TO"].map(v);
    if ([pts, reb, ast, blk, stl, fgPct, ftPct, threePm, gp, tov].some((x) => x === null) || !(gp! > 0)) continue;
    const meta = (nameM[2] ?? "").split("-").map((x) => x.trim());
    out.push({
      name: decode(nameM[1]),
      team: meta[0] && /^[A-Za-z]{2,4}$/.test(meta[0]) ? meta[0].toUpperCase() : null,
      positions: parsePositionList(meta.slice(1).join(" ")),
      gp: gp!, min: minCol >= 0 ? num(tds[minCol]) : null,
      pts: pts!, reb: reb!, ast: ast!, blk: blk!, stl: stl!, fgPct: fgPct!, ftPct: ftPct!, threePm: threePm!, tov: tov!,
    });
  }
  return out;
}

/**
 * Season totals -> a per-game line (games = GP, minutes = MIN/GP). FGA/FTA come from the same points identity as Yahoo's
 * (projection-merge.ts) using the player's real FTA/FGA ratio from `base` when known.
 */
export function fpLine(r: FpProjectionRow, base?: Pick<ProjectionLine, "pts" | "fga" | "fta"> | null): ProjectionLine {
  const pg = (x: number) => x / r.gp;
  const att = deriveAttempts({ ptsPg: pg(r.pts), threePmPg: pg(r.threePm), fgPct: r.fgPct, ftPct: r.ftPct, base });
  return {
    games: r.gp,
    minutes: r.min && r.min > 0 ? r.min / r.gp : 0,
    pts: pg(r.pts), fgm: att.fgm, fga: att.fga, ftm: att.ftm, fta: att.fta,
    threePm: pg(r.threePm), reb: pg(r.reb), ast: pg(r.ast), stl: pg(r.stl), blk: pg(r.blk), tov: pg(r.tov),
  };
}

/** average(a, b) per field (every field, attempts and makes separately so the percentages stay Σmakes/Σattempts). `minutes` comes from whichever has it. */
export function averageLines(a: ProjectionLine, b: ProjectionLine): ProjectionLine {
  const out = {} as ProjectionLine;
  for (const k of Object.keys(a) as (keyof ProjectionLine)[]) out[k] = (a[k] + b[k]) / 2;
  out.minutes = b.minutes > 0 ? b.minutes : a.minutes;
  return out;
}

export interface FpIndex {
  count: number;
  find: (q: { playerName: string; nbaTeam?: string | null }) => FpProjectionRow | null;
}

export function indexFpRows(rows: FpProjectionRow[]): FpIndex {
  const m = new Map<string, FpProjectionRow[]>();
  for (const r of rows) (m.get(nameKey(r.name)) ?? m.set(nameKey(r.name), []).get(nameKey(r.name))!).push(r);
  return {
    count: rows.length,
    find: (q) => {
      let c = m.get(nameKey(q.playerName)) ?? [];
      if (c.length > 1 && q.nbaTeam) {
        const t = canonicalTeam(q.nbaTeam);
        const byTeam = c.filter((x) => canonicalTeam(x.team) === t);
        if (byTeam.length) c = byTeam;
      }
      return c.length === 1 ? c[0] : null;
    },
  };
}

const memo = new Map<string, { mtimeMs: number; index: FpIndex }>();
/** The cached FantasyPros projections of `cacheDir` (null when the file is absent or unreadable). Memoised by mtime. Never throws. */
export function loadFantasyProsProjections(cacheDir: string): FpIndex | null {
  const file = path.join(cacheDir, FP_PROJECTIONS_CACHE);
  try {
    const st = fs.statSync(file);
    const hit = memo.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.index;
    const rows = parseFantasyProsProjections(fs.readFileSync(file, "utf8"));
    if (!rows.length) return null;
    const index = indexFpRows(rows);
    memo.set(file, { mtimeMs: st.mtimeMs, index });
    return index;
  } catch {
    return null;
  }
}

/** Age of the cache file in ms (null when absent). */
export function fpCacheAgeMs(cacheDir: string, now = Date.now()): number | null {
  try {
    return now - fs.statSync(path.join(cacheDir, FP_PROJECTIONS_CACHE)).mtimeMs;
  } catch {
    return null;
  }
}

const FP_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Cache-first fetch + parse. A response that does not parse to a plausible table (>= 50 rows) is never cached. */
export async function fetchFantasyProsProjections(o: FetchOptions): Promise<{ rows: FpProjectionRow[]; fromCache: boolean }> {
  const { text, fromCache } = await cachedText(FP_PROJECTIONS_CACHE, FP_PROJECTIONS_URL, FP_HEADERS, o, (t) => {
    if (parseFantasyProsProjections(t).length < 50) throw new Error("FantasyPros projections page did not contain a projections table");
  });
  return { rows: parseFantasyProsProjections(text), fromCache };
}
