import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { POSITIONS, type InjuryStatus, type PlayerRecord, type Position } from "@/types";

/** Minimal RFC4180-ish parser: quoted fields, escaped quotes, CRLF. Returns header-keyed rows. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (inQuotes) throw new Error("CSV parse error: unterminated quoted field");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r, idx) => {
    if (r.length !== header.length)
      throw new Error(`CSV row ${idx + 2} has ${r.length} fields, expected ${header.length}`);
    return Object.fromEntries(header.map((h, i) => [h, r[i].trim()]));
  });
}

const num = z.string().trim().min(1).transform(Number).pipe(z.number().finite());
const bool = z.string().transform((s, ctx) => {
  const v = s.trim().toLowerCase();
  if (["true", "1", "yes"].includes(v)) return true;
  if (["false", "0", "no", ""].includes(v)) return false;
  ctx.addIssue({ code: "custom", message: `invalid boolean "${s}"` });
  return z.NEVER;
});
const unit = num.pipe(z.number().min(0).max(1));
const status = z.enum(["healthy", "day-to-day", "out", "out-for-season"]);

const projectionRow = z.object({
  id: z.string().min(1),
  yahoo_player_key: z.string().optional().default(""),
  name: z.string().min(1),
  nba_team: z.string().min(1),
  positions: z.string().min(1),
  age: num,
  games: num,
  minutes: num,
  pts: num,
  fgm: num,
  fga: num,
  ftm: num,
  fta: num,
  three_pm: num,
  reb: num,
  ast: num,
  stl: num,
  blk: num,
  tov: num,
});
const adpRow = z.object({ player_id: z.string().min(1), yahoo_adp: num, adp_std_dev: num, rank: num });
const injuryRow = z.object({
  player_id: z.string().min(1),
  projected_games: num,
  current_status: status,
  injury_history_score: unit,
  rest_risk: unit,
  availability_score: unit,
  major_injury_history: bool,
  updated_at: z.string().min(1),
});

function readRows<S extends z.ZodType>(file: string, schema: S): z.output<S>[] {
  if (!fs.existsSync(file)) throw new Error(`Missing CSV file: ${file}`);
  return parseCsv(fs.readFileSync(file, "utf8")).map((r, i) => {
    const res = schema.safeParse(r);
    if (!res.success)
      throw new Error(
        `${path.basename(file)} row ${i + 2}: ${res.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`,
      );
    return res.data;
  });
}

function parsePositions(raw: string, id: string): Position[] {
  const parts = raw.split("/").map((p) => p.trim().toUpperCase());
  for (const p of parts)
    if (!(POSITIONS as readonly string[]).includes(p)) throw new Error(`projections.csv: player ${id} has invalid position "${p}"`);
  return parts as Position[];
}

function indexById<T>(rows: T[], key: (r: T) => string, file: string): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    if (m.has(k)) throw new Error(`${file}: duplicate player id "${k}"`);
    m.set(k, r);
  }
  return m;
}

/** Loads projections.csv, yahoo-adp.csv, injuries.csv from `dir` and joins them by player id. */
export function loadPlayerRecordsFromCsv(dir: string): PlayerRecord[] {
  const proj = readRows(path.join(dir, "projections.csv"), projectionRow);
  const adp = indexById(readRows(path.join(dir, "yahoo-adp.csv"), adpRow), (r) => r.player_id, "yahoo-adp.csv");
  const inj = indexById(readRows(path.join(dir, "injuries.csv"), injuryRow), (r) => r.player_id, "injuries.csv");
  const projIds = indexById(proj, (r) => r.id, "projections.csv");

  for (const id of adp.keys()) if (!projIds.has(id)) throw new Error(`yahoo-adp.csv references unknown player id "${id}"`);
  for (const id of inj.keys()) if (!projIds.has(id)) throw new Error(`injuries.csv references unknown player id "${id}"`);

  return proj.map((p) => {
    const a = adp.get(p.id);
    if (!a) throw new Error(`Player "${p.id}" missing from yahoo-adp.csv`);
    const r = inj.get(p.id);
    if (!r) throw new Error(`Player "${p.id}" missing from injuries.csv`);
    return {
      player: {
        id: p.id,
        yahooPlayerKey: p.yahoo_player_key || null,
        name: p.name,
        nbaTeam: p.nba_team,
        positions: parsePositions(p.positions, p.id),
        age: p.age,
      },
      projection: {
        playerId: p.id,
        games: p.games,
        minutes: p.minutes,
        pts: p.pts,
        fgm: p.fgm,
        fga: p.fga,
        ftm: p.ftm,
        fta: p.fta,
        threePm: p.three_pm,
        reb: p.reb,
        ast: p.ast,
        stl: p.stl,
        blk: p.blk,
        tov: p.tov,
      },
      market: { playerId: p.id, yahooAdp: a.yahoo_adp, adpStdDev: a.adp_std_dev, rank: a.rank },
      risk: {
        playerId: p.id,
        projectedGames: r.projected_games,
        currentStatus: r.current_status as InjuryStatus,
        injuryHistoryScore: r.injury_history_score,
        restRisk: r.rest_risk,
        availabilityScore: r.availability_score,
        majorInjuryHistory: r.major_injury_history,
        updatedAt: r.updated_at,
      },
    };
  });
}
