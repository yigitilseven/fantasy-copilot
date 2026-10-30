import type { Db } from "@/db/client";
import { SeasonError } from "@/db/season";
import { nameKey } from "@/integrations/projections/names";
import { evaluateTrade, findTrades, tradeContext, type FindTradesResult, type TradeContext, type TradeEval, type TradeTeam } from "@/engine/season/trades";
import type { SeasonPlayer } from "@/engine/season/types";
import { loadSeasonState, type SeasonState, type StateOptions } from "./season";

/** Every team (you included) with its live (non-IL) players, plus the free-agent pool, from the current season state. */
function tradeSetup(s: SeasonState): { tc: TradeContext; freeAgents: SeasonPlayer[]; userSlot: number } {
  const userSlot = s.league.userSlot;
  const user = s.teams.find((t) => t.slot === userSlot)!;
  const mine = s.userEntries.filter((e) => e.status !== "il").map((e) => s.players.get(e.playerId)).filter((p): p is SeasonPlayer => !!p);
  const teams: TradeTeam[] = [{ slot: userSlot, name: user.name, players: mine }, ...s.opponents.map((o) => ({ slot: o.slot, name: o.name, players: o.players }))];
  const freeAgents = s.faIds.map((id) => s.players.get(id)).filter((p): p is SeasonPlayer => !!p);
  return { tc: tradeContext(s.ctx, teams, s.scheduleData ? { lastDate: s.scheduleData.lastDate } : null), freeAgents, userSlot };
}

export interface TradeIdeasResult extends FindTradesResult { date: string; note: string }

/** Trade offers worth making (both sides gain), best for you first. Null without a league. */
export function computeTradeIdeas(db: Db, opts: StateOptions & { limit?: number } = {}): TradeIdeasResult | null {
  const s = loadSeasonState(db, opts);
  if (!s) return null;
  const { tc, freeAgents, userSlot } = tradeSetup(s);
  const r = findTrades({ tc, userSlot, freeAgents, limit: opts.limit });
  return {
    ...r,
    date: s.today,
    note: "Win chances are the average weekly win probability over the next 3 weeks against the rest of the league, for each side with its own roster. Only trades both sides gain from are listed.",
  };
}

export interface TradeCheckBody {
  /** Team name (or slot); omitted = your team. */
  a?: { team?: string | number; gives: string[] };
  b: { team?: string | number; gives: string[] };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Finds a player on a team by name: full name, or "A. Wiggins" / "Wiggins" style when it is unique on that team. */
function findOnTeam(t: TradeTeam, name: string): SeasonPlayer {
  const k = nameKey(name);
  const exact = t.players.filter((p) => nameKey(p.name) === k);
  if (exact.length === 1) return exact[0];
  const parts = k.split(" ").filter(Boolean);
  const last = parts[parts.length - 1];
  const init = parts.length > 1 ? parts[0][0] : null;
  const loose = t.players.filter((p) => {
    const q = nameKey(p.name).split(" ");
    return q[q.length - 1] === last && (!init || q[0][0] === init);
  });
  if (loose.length === 1) return loose[0];
  throw new SeasonError("PLAYER_NOT_FOUND", loose.length > 1 ? `"${name}" is ambiguous on ${t.name}` : `"${name}" is not on ${t.name}'s active roster`);
}

function findTeam(tc: TradeContext, team: string | number | undefined, fallback: number): TradeTeam {
  if (team === undefined || team === "") return tc.teams.find((t) => t.slot === fallback)!;
  const hit = typeof team === "number" ? tc.teams.find((t) => t.slot === team) : tc.teams.find((t) => norm(t.name) === norm(team)) ?? tc.teams.filter((t) => norm(t.name).includes(norm(team))).at(0);
  if (!hit) throw new SeasonError("TEAM_NOT_FOUND", `No team "${team}" in the league`);
  return hit;
}

/** Scores one trade given by names. Team B can be omitted when every player B gives is on exactly one team. */
export function checkTrade(db: Db, body: TradeCheckBody, opts: StateOptions = {}): TradeEval & { date: string } {
  const s = loadSeasonState(db, opts);
  if (!s) throw new SeasonError("LEAGUE_NOT_FOUND", "No season league yet");
  const { tc, freeAgents, userSlot } = tradeSetup(s);
  const a = findTeam(tc, body.a?.team, userSlot);
  let b: TradeTeam;
  if (body.b.team !== undefined && body.b.team !== "") b = findTeam(tc, body.b.team, userSlot);
  else {
    const owners = tc.teams.filter((t) => t.slot !== a.slot && body.b.gives.every((n) => { try { findOnTeam(t, n); return true; } catch { return false; } }));
    if (owners.length !== 1) throw new SeasonError("TEAM_NOT_FOUND", "Name the other team: its players could not be placed on exactly one team");
    b = owners[0];
  }
  if (a.slot === b.slot) throw new SeasonError("INVALID", "Both sides are the same team");
  const aGives = (body.a?.gives ?? []).map((n) => findOnTeam(a, n));
  const bGives = body.b.gives.map((n) => findOnTeam(b, n));
  if (!aGives.length || !bGives.length) throw new SeasonError("INVALID", "Each side must give at least one player");
  return { ...evaluateTrade(tc, a.slot, aGives, b.slot, bGives, freeAgents), date: s.today };
}
