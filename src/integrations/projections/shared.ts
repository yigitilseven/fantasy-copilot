/**
 * Pieces shared by every importer that writes the data/*.csv set (Yahoo API importer, real-data importer):
 * CSV writing, timestamped backups, previous-CSV lookup and the conservative ADP-template rookie line.
 */
import fs from "node:fs";
import path from "node:path";
import type { PerGameLine } from "../yahoo/stats";
import { parseCsv } from "./csv";

export const PROJECTION_COLUMNS = ["id", "yahoo_player_key", "name", "nba_team", "positions", "age", "games", "minutes", "pts", "fgm", "fga", "ftm", "fta", "three_pm", "reb", "ast", "stl", "blk", "tov"] as const;
export const ADP_COLUMNS = ["player_id", "yahoo_adp", "adp_std_dev", "rank"] as const;
export const SOURCE_COLUMNS = ["player_id", "source"] as const;
export const INJURY_COLUMNS = ["player_id", "projected_games", "current_status", "injury_history_score", "rest_risk", "availability_score", "major_injury_history", "updated_at"] as const;

export interface ExistingData {
  /** id → projections row */
  projections: Map<string, Record<string, string>>;
  injuries: Map<string, Record<string, string>>;
}

export function readExisting(dataDir: string): ExistingData {
  const read = (f: string, key: string) => {
    const file = path.join(dataDir, f);
    const m = new Map<string, Record<string, string>>();
    if (fs.existsSync(file)) for (const r of parseCsv(fs.readFileSync(file, "utf8"))) m.set(r[key], r);
    return m;
  };
  return { projections: read("projections.csv", "id"), injuries: read("injuries.csv", "player_id") };
}

/** Rows of the four output files. */
export interface DatasetRows {
  projections: Record<string, string>[];
  adp: Record<string, string>[];
  injuries: Record<string, string>[];
  sources: Record<string, string>[];
}

export function toCsv(columns: readonly string[], rows: Record<string, string>[]): string {
  const q = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns.join(","), ...rows.map((r) => columns.map((c) => q(r[c] ?? "")).join(","))].join("\n") + "\n";
}

/** Writes the four CSVs into `dataDir`, first copying any existing ones to `backup-<timestamp>/`. Returns the backup dir (or null). */
export function writeDatasetFiles(dataDir: string, d: DatasetRows, now: Date): string | null {
  const files = {
    "projections.csv": toCsv(PROJECTION_COLUMNS, d.projections),
    "yahoo-adp.csv": toCsv(ADP_COLUMNS, d.adp),
    "injuries.csv": toCsv(INJURY_COLUMNS, d.injuries),
    "projection-sources.csv": toCsv(SOURCE_COLUMNS, d.sources),
  };
  let backupDir: string | null = null;
  const existingFiles = Object.keys(files).filter((n) => fs.existsSync(path.join(dataDir, n)));
  if (existingFiles.length) {
    backupDir = path.join(dataDir, `backup-${now.toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const n of existingFiles) fs.copyFileSync(path.join(dataDir, n), path.join(backupDir, n));
  }
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [n, content] of Object.entries(files)) fs.writeFileSync(path.join(dataDir, n), content);
  return backupDir;
}

export const ADP_TEMPLATE_WINDOW = 10;
export const ADP_TEMPLATE_SCALE = 0.9;
export const ADP_TEMPLATE_MIN_NEIGHBOURS = 3;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Existing data/projections.csv row → per-game line (null when any stat is missing / non-numeric). */
export function lineFromProjectionRow(r: Record<string, string>): PerGameLine | null {
  const n = (k: string) => (r[k] === undefined || r[k] === "" ? NaN : Number(r[k]));
  const v = { gp: n("games"), minutes: n("minutes"), pts: n("pts"), fgm: n("fgm"), fga: n("fga"), ftm: n("ftm"), fta: n("fta"), threePm: n("three_pm"), reb: n("reb"), ast: n("ast"), stl: n("stl"), blk: n("blk"), tov: n("tov") };
  if (Object.values(v).some((x) => !Number.isFinite(x))) return null;
  return v;
}

/**
 * Conservative rookie line: per-stat median of the per-game lines of players whose ADP is within ±10 of `adp`
 * (widened to the nearest 3 when the window is sparse), scaled by 0.9. null when there are no donors at all.
 */
export function adpTemplateLine(adp: number, pool: { adp: number; line: PerGameLine }[]): PerGameLine | null {
  let donors = pool.filter((p) => Math.abs(p.adp - adp) <= ADP_TEMPLATE_WINDOW);
  if (donors.length < ADP_TEMPLATE_MIN_NEIGHBOURS) donors = [...pool].sort((a, b) => Math.abs(a.adp - adp) - Math.abs(b.adp - adp)).slice(0, ADP_TEMPLATE_MIN_NEIGHBOURS);
  if (!donors.length) return null;
  const med = (get: (l: PerGameLine) => number | null) => {
    const xs = donors.map((d) => get(d.line)).filter((x): x is number => x !== null);
    return xs.length ? median(xs) * ADP_TEMPLATE_SCALE : null;
  };
  return {
    gp: Math.round(median(donors.map((d) => d.line.gp))),
    minutes: med((l) => l.minutes),
    pts: med((l) => l.pts)!,
    fgm: med((l) => l.fgm)!,
    fga: med((l) => l.fga)!,
    ftm: med((l) => l.ftm)!,
    fta: med((l) => l.fta)!,
    threePm: med((l) => l.threePm)!,
    reb: med((l) => l.reb)!,
    ast: med((l) => l.ast)!,
    stl: med((l) => l.stl)!,
    blk: med((l) => l.blk)!,
    tov: med((l) => l.tov)!,
  };
}
