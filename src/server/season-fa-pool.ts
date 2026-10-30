import type { Db } from "@/db/client";
import { gamesLeftThisWeek } from "@/engine/season/evaluate";
import { loadSeasonState, type StateOptions } from "./season";

export interface FaPoolPlayer {
  playerId: string;
  name: string;
  team: string;
  positions: string;
  /** Season value: per-game nine-cat z-score sum x availability. */
  value: number;
  gamesThisWeek: number;
  pctOwned: number | null;
  status: { flag: string; detail?: string };
}
export interface FaPool { date: string; count: number; source: "captured" | "all-unrostered"; players: FaPoolPlayer[] }
export interface FaPoolQuery { pos?: string; q?: string; sort?: "value" | "games" | "owned"; limit?: number }

/** The scored free-agent pool (captured Yahoo free agents, or all unrostered players as a fallback). Null without a league. */
export function computeFaPool(db: Db, query: FaPoolQuery = {}, opts: StateOptions = {}): FaPool | null {
  const s = loadSeasonState(db, opts);
  if (!s) return null;
  let rows: FaPoolPlayer[] = [];
  for (const id of s.faIds) {
    const p = s.players.get(id);
    if (!p) continue;
    const detail = [p.injury.injury, p.injury.estReturn ? `back ${p.injury.estReturn}` : null].filter(Boolean).join(", ");
    rows.push({
      playerId: p.id, name: p.name, team: p.team, positions: p.positions.join("/"),
      value: Math.round(p.nineCat * p.avail * 100) / 100,
      gamesThisWeek: gamesLeftThisWeek(s.ctx.schedule, p.team, s.today),
      pctOwned: s.faPct.get(p.id) ?? null,
      status: { flag: p.injury.flag, ...(detail ? { detail: `(${detail})` } : {}) },
    });
  }
  const count = rows.length;
  if (query.pos) rows = rows.filter((r) => r.positions.split("/").includes(query.pos!));
  if (query.q?.trim()) {
    const q = query.q.trim().toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  }
  const sort = query.sort ?? "value";
  const key = (r: FaPoolPlayer) => (sort === "games" ? r.gamesThisWeek : sort === "owned" ? r.pctOwned ?? -1 : r.value);
  rows.sort((a, b) => key(b) - key(a) || b.value - a.value || a.name.localeCompare(b.name));
  return { date: s.today, count, source: s.faSource, players: rows.slice(0, query.limit ?? 50) };
}
