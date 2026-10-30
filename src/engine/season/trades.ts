/**
 * Trades, judged with the same model as the add/drop moves: a team's average weekly win probability over the next weeks against the
 * rest of the league (ROS). Each side is scored with its own model (its opponents = every other team as rostered today).
 *
 * - evaluateTrade: any trade between two teams (yours, or a league vote), both sides' change and the category reasons.
 * - findTrades: offers worth making: 1-for-1 swaps and 2-for-1 consolidations (you give two, get one better player and fill the
 *   freed spot with the best free agent; they drop their weakest player to make room). Only trades where BOTH sides gain are kept,
 *   because the other manager has to accept. The search is pruned to value-balanced swaps and capped (`maxEvaluations`).
 */
import { catReasons, isLongTermOut } from "./addDrop";
import { buildModel, type Model, type Opponent } from "./evaluate";
import type { LineupContext, SeasonPlayer } from "./types";

export interface TradeTeam { slot: number; name: string; players: SeasonPlayer[] }
export interface TradePlayerRef {
  playerId: string; name: string; team: string; positions: string;
  /** "Out (Knee), back 2026-11-20" / "GTD"; absent when healthy. */
  status?: string;
}
export interface TradeSideResult {
  slot: number;
  name: string;
  gives: TradePlayerRef[];
  gets: TradePlayerRef[];
  /** Free agent added (2-for-1, the side that gives two) or own player dropped (the side that gets two) to keep the roster size. */
  adds: TradePlayerRef | null;
  drops: TradePlayerRef | null;
  before: number;
  after: number;
  /** after - before (fraction; 0.02 = +2 pp). */
  dRos: number;
  reasons: string[];
}
export interface TradeEval { a: TradeSideResult; b: TradeSideResult }
export interface TradeIdea extends TradeEval { kind: "1-for-1" | "2-for-1"; score: number }

const statusOf = (p: SeasonPlayer): string | undefined => {
  const i = p.injury;
  if (i.flag === "healthy") return undefined;
  const label = i.flag === "out" ? "Out" : i.flag === "ofs" ? "Out for season" : i.flag.toUpperCase();
  return `${label}${i.injury ? ` (${i.injury})` : ""}${i.estReturn ? `, back ${i.estReturn}` : ""}`;
};
const ref = (p: SeasonPlayer): TradePlayerRef => ({ playerId: p.id, name: p.name, team: p.team, positions: p.positions.join("/"), ...(statusOf(p) ? { status: statusOf(p) } : {}) });
const value = (p: SeasonPlayer) => p.nineCat * Math.max(0.3, p.avail);

export interface TradeContext {
  ctx: LineupContext;
  teams: readonly TradeTeam[];
  schedule: { lastDate: string | null } | null;
  /** Lazily built per-team model and baseline (cached). */
  model(slot: number): { m: Model; base: ReturnType<Model["ros"]> };
}

export function tradeContext(ctx: LineupContext, teams: readonly TradeTeam[], schedule: { lastDate: string | null } | null): TradeContext {
  const cache = new Map<number, { m: Model; base: ReturnType<Model["ros"]> }>();
  return {
    ctx, teams, schedule,
    model(slot) {
      let hit = cache.get(slot);
      if (!hit) {
        const me = teams.find((t) => t.slot === slot);
        if (!me) throw new Error(`no team in slot ${slot}`);
        const opps: Opponent[] = teams.filter((t) => t.slot !== slot).map((t) => ({ slot: t.slot, name: t.name, players: t.players }));
        const m = buildModel(ctx, opps, null, schedule);
        hit = { m, base: m.ros(me.players) };
        cache.set(slot, hit);
      }
      return hit;
    },
  };
}

function side(tc: TradeContext, slot: number, gives: SeasonPlayer[], gets: SeasonPlayer[], adds: SeasonPlayer | null, drops: SeasonPlayer | null): TradeSideResult {
  const team = tc.teams.find((t) => t.slot === slot)!;
  const { m, base } = tc.model(slot);
  const out = new Set([...gives.map((p) => p.id), ...(drops ? [drops.id] : [])]);
  const roster = [...team.players.filter((p) => !out.has(p.id)), ...gets, ...(adds ? [adds] : [])];
  const r = m.ros(roster);
  return {
    slot, name: team.name, gives: gives.map(ref), gets: gets.map(ref), adds: adds ? ref(adds) : null, drops: drops ? ref(drops) : null,
    before: base.winProb, after: r.winProb, dRos: r.winProb - base.winProb, reasons: catReasons(base.catP, r.catP, "per week"),
  };
}

/** The weakest player a team would cut to make room (lowest value, never one it just received). */
function cutCandidate(team: TradeTeam, keep: ReadonlySet<string>, today: string): SeasonPlayer | null {
  const pool = team.players.filter((p) => !keep.has(p.id));
  if (!pool.length) return null;
  return [...pool].sort((x, y) => (isLongTermOut(x, today) ? -1 : 0) - (isLongTermOut(y, today) ? -1 : 0) || value(x) - value(y))[0];
}

/**
 * Scores a trade: team `aSlot` gives `aGives`, team `bSlot` gives `bGives`. When the counts differ, the side that ends up with more
 * players drops its weakest one, the other side adds the best free agent from `freeAgents` (if given) to keep roster sizes.
 */
export function evaluateTrade(tc: TradeContext, aSlot: number, aGives: SeasonPlayer[], bSlot: number, bGives: SeasonPlayer[], freeAgents: readonly SeasonPlayer[] = []): TradeEval {
  const diff = bGives.length - aGives.length; // > 0: A ends up with more players
  const bestFa = (taken: ReadonlySet<string>) => [...freeAgents].filter((p) => !taken.has(p.id) && !isLongTermOut(p, tc.ctx.today)).sort((x, y) => value(y) - value(x))[0] ?? null;
  const teamA = tc.teams.find((t) => t.slot === aSlot)!;
  const teamB = tc.teams.find((t) => t.slot === bSlot)!;
  let aDrop: SeasonPlayer | null = null, bDrop: SeasonPlayer | null = null, aAdd: SeasonPlayer | null = null, bAdd: SeasonPlayer | null = null;
  if (diff > 0) {
    aDrop = cutCandidate({ ...teamA, players: teamA.players.filter((p) => !aGives.some((g) => g.id === p.id)) }, new Set(bGives.map((p) => p.id)), tc.ctx.today);
    bAdd = bestFa(new Set());
  } else if (diff < 0) {
    bDrop = cutCandidate({ ...teamB, players: teamB.players.filter((p) => !bGives.some((g) => g.id === p.id)) }, new Set(aGives.map((p) => p.id)), tc.ctx.today);
    aAdd = bestFa(new Set());
  }
  return { a: side(tc, aSlot, aGives, bGives, aAdd, aDrop), b: side(tc, bSlot, bGives, aGives, bAdd, bDrop) };
}

export interface FindTradesInput {
  tc: TradeContext;
  userSlot: number;
  freeAgents: readonly SeasonPlayer[];
  limit?: number;
  /** Minimum gain for you / for them (fractions). Defaults 0.005 and 0.001. */
  minGain?: number;
  minTheirGain?: number;
  /** Rank window for a value-balanced swap (players ranked league-wide by value). Default 45. */
  rankBand?: number;
  maxEvaluations?: number;
}
export interface FindTradesResult { ideas: TradeIdea[]; evaluated: number; capped: boolean }

export function findTrades(input: FindTradesInput): FindTradesResult {
  const { tc, userSlot, freeAgents } = input;
  const today = tc.ctx.today;
  const minGain = input.minGain ?? 0.005;
  const minTheir = input.minTheirGain ?? 0.001;
  const band = input.rankBand ?? 45;
  const maxEval = input.maxEvaluations ?? 1500;
  const user = tc.teams.find((t) => t.slot === userSlot);
  if (!user) return { ideas: [], evaluated: 0, capped: false };

  const all = tc.teams.flatMap((t) => t.players);
  const rank = new Map([...all].sort((x, y) => value(y) - value(x)).map((p, i) => [p.id, i]));
  const healthy = (p: SeasonPlayer) => !isLongTermOut(p, today);
  const mine = user.players.filter(healthy);

  // Candidate trades with a cheap promise score (value you gain), best first; evaluated until the budget runs out.
  type Cand = { kind: TradeIdea["kind"]; gives: SeasonPlayer[]; gets: SeasonPlayer[]; slot: number; promise: number };
  const cands: Cand[] = [];
  for (const t of tc.teams) {
    if (t.slot === userSlot) continue;
    const theirs = t.players.filter(healthy);
    for (const g of mine) for (const r of theirs) {
      if (Math.abs(rank.get(g.id)! - rank.get(r.id)!) > band) continue;
      cands.push({ kind: "1-for-1", gives: [g], gets: [r], slot: t.slot, promise: value(r) - value(g) });
    }
    // 2-for-1: one of their top players for two of yours whose combined value is higher, but each lower than him.
    const stars = [...theirs].sort((x, y) => value(y) - value(x)).slice(0, 5);
    for (const r of stars) {
      const below = mine.filter((p) => value(p) < value(r) && rank.get(p.id)! - rank.get(r.id)! <= band * 2);
      for (let i = 0; i < below.length; i++) for (let j = i + 1; j < below.length; j++) {
        const g1 = below[i], g2 = below[j];
        if (value(g1) + value(g2) <= value(r)) continue;
        cands.push({ kind: "2-for-1", gives: [g1, g2], gets: [r], slot: t.slot, promise: value(r) - Math.max(value(g1), value(g2)) });
      }
    }
  }
  cands.sort((x, y) => y.promise - x.promise);

  const ideas: TradeIdea[] = [];
  let evaluated = 0;
  for (const c of cands) {
    if (evaluated >= maxEval) break;
    evaluated++;
    const e = evaluateTrade(tc, userSlot, c.gives, c.slot, c.gets, freeAgents);
    if (e.a.dRos < minGain || e.b.dRos < minTheir) continue;
    // Prefer what helps you most among trades they gain from too; a fairer split ranks a little higher (more likely accepted).
    ideas.push({ ...e, kind: c.kind, score: e.a.dRos + 0.5 * Math.min(e.a.dRos, e.b.dRos) });
  }
  ideas.sort((x, y) => y.score - x.score);

  // Diversify: at most two ideas per partner team and per player you give.
  const limit = input.limit ?? 8;
  const perTeam = new Map<number, number>();
  const perGive = new Map<string, number>();
  const out: TradeIdea[] = [];
  for (const i of ideas) {
    const g = i.a.gives.map((p) => p.playerId);
    if ((perTeam.get(i.b.slot) ?? 0) >= 2 || g.some((id) => (perGive.get(id) ?? 0) >= 2)) continue;
    perTeam.set(i.b.slot, (perTeam.get(i.b.slot) ?? 0) + 1);
    for (const id of g) perGive.set(id, (perGive.get(id) ?? 0) + 1);
    out.push(i);
    if (out.length >= limit) break;
  }
  return { ideas: out, evaluated, capped: evaluated >= maxEval && cands.length > maxEval };
}
