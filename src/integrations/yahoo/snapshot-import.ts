import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import type { Db } from "../../db/client";
import { drafts } from "../../db/schema";
import { eq } from "drizzle-orm";
import { draftRoomKey, parseBoard, parseLeagueName, parseResultsTeams, parseStandings } from "../../../extension/parser.js";
import { applyPostdraft, type PostdraftInput, type PostdraftResult } from "./postdraft";
import type { DomPickInput } from "./dom-ingest";
import type { StandingsRowInput } from "../../db/history";

/**
 * Backfill from the draft-room snapshots the userscript saved (data/cache/draftroom-<ts>.html, first line `<!-- url: ... -->`).
 * The Standings view is inferred from the printed numbers (the <select> state is lost in snapshots). Dev/CLI only (needs jsdom).
 */

export interface SnapshotFile {
  file: string;
  room: string | null;
  /** ISO time from the file name. */
  at: string;
}

export function listSnapshots(dir: string): SnapshotFile[] {
  const out: SnapshotFile[] = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = /^draftroom-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.html$/.exec(f);
    if (!m) continue;
    const head = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 400);
    const u = /<!--\s*url:\s*(\S+)/.exec(head);
    out.push({ file: f, room: u ? draftRoomKey(u[1]) : null, at: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** The room whose first snapshot is the closest one at/after the draft's creation time. */
export function guessRoom(db: Db, draftId: number, snaps: SnapshotFile[]): string | null {
  const d = db.select({ createdAt: drafts.createdAt }).from(drafts).where(eq(drafts.id, draftId)).get();
  if (!d) return null;
  const t0 = Date.parse(d.createdAt);
  let best: { room: string; gap: number } | null = null;
  const firstOf = new Map<string, number>();
  for (const s of snaps) if (s.room && !firstOf.has(s.room)) firstOf.set(s.room, Date.parse(s.at));
  for (const [room, t] of firstOf) {
    const gap = t - t0;
    if (gap >= -60_000 && (!best || gap < best.gap)) best = { room, gap };
  }
  return best?.room ?? null;
}

interface StandingsRaw {
  rank: number;
  teamName: string;
  label?: string;
  [k: string]: unknown;
}
interface BoardTeam {
  slot: number;
  name: string;
  isUser?: boolean;
}
interface BoardPickRaw {
  pick: number;
  playerName: string;
  nbaTeam?: string;
  positions?: string;
  teamName?: string;
}

export interface SnapshotImportReport {
  room: string | null;
  files: number;
  views: string[];
  boardPicks: number;
  teams: number;
  result: PostdraftResult | null;
}

export function importSnapshots(db: Db, draftId: number, opts: { dir?: string; room?: string } = {}): SnapshotImportReport {
  const dir = opts.dir ?? path.resolve(process.cwd(), "data", "cache");
  const snaps = listSnapshots(dir);
  const room = opts.room ?? guessRoom(db, draftId, snaps);
  const mine = snaps.filter((s) => s.room === room);
  const standings = new Map<string, { view: string; rows: StandingsRowInput[] }>();
  let board: { teams: BoardTeam[]; picks: DomPickInput[] } | undefined;
  const results: DomPickInput[] = [];
  let leagueName: string | null = null;
  for (const s of mine) {
    const doc = new JSDOM(fs.readFileSync(path.join(dir, s.file), "utf8")).window.document;
    leagueName = parseLeagueName(doc) ?? leagueName;
    const st = parseStandings(doc, { trustSelect: false });
    if (st.active && st.view !== "unknown" && st.rows.length >= 2) {
      standings.set(st.view, { view: st.view, rows: (st.rows as StandingsRaw[]).map((r) => { const o = { ...r }; delete o.label; return o as unknown as StandingsRowInput; }) });
    }
    const b = parseBoard(doc);
    if (b.active && (!board || b.picks.length >= board.picks.length)) {
      board = { teams: b.teams, picks: (b.picks as BoardPickRaw[]).map((p) => ({ pick: p.pick, playerName: p.playerName, nbaTeam: p.nbaTeam, positions: p.positions, teamName: p.teamName })) };
    }
    const rt = parseResultsTeams(doc);
    for (const p of rt.picks) results.push(p);
  }
  const input: PostdraftInput = {
    standings: [...standings.values()],
    ...(board ? { board } : {}),
    ...(results.length ? { results: { picks: results } } : {}),
    roomKey: room,
    leagueName,
    capturedAt: mine.length ? mine[mine.length - 1].at : undefined,
  };
  const result = mine.length ? applyPostdraft(db, draftId, input) : null;
  return { room, files: mine.length, views: [...standings.keys()], boardPicks: board?.picks.length ?? 0, teams: board?.teams.length ?? 0, result };
}
