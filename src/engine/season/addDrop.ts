import { positionGroups, slotAccepts } from "./slots";
import { buildModel, gamesLeftThisWeek, type MatchupData, type Opponent, type RosDetail, type WeekDetail } from "./evaluate";
import { isIlEligible } from "./lineup";
import { SEASON_CATS, type LineupContext, type RosterEntry, type SeasonPlayer } from "./types";
import { addDays } from "./schedule";

export type MoveKind = "season" | "stream" | "injury";

export interface PlayerRef {
  playerId: string;
  name: string;
  team: string;
  positions: string;
}
export interface MoveSuggestion {
  kind: MoveKind;
  /** "Season add" | "Stream this week (4 games)" | "Injury replacement (C)". */
  label: string;
  add: PlayerRef & { games: number; pctOwned: number | null };
  /** null = an open roster spot (or the injured player goes to IL). */
  drop: PlayerRef | null;
  /** Injured player to move to IL first (frees the spot). */
  ilMove: PlayerRef | null;
  /** Change in this week's matchup win probability (fraction; 0.03 = +3 pp). */
  dWeek: number;
  /** Change in the average weekly win probability over the next weeks. */
  dRos: number;
  /** dWeek (+ 4 x dRos for holds), the ranking key. */
  score: number;
  reasons: string[];
  news: string[];
  /** Set when the move cannot be made now (add limit reached). */
  blocked?: string;
}

export interface AddDropInput {
  ctx: LineupContext;
  players: ReadonlyMap<string, SeasonPlayer>;
  entries: readonly RosterEntry[];
  opponents: readonly Opponent[];
  freeAgentIds: readonly string[];
  pctOwned?: ReadonlyMap<string, number>;
  matchup: MatchupData | null;
  schedule: { lastDate: string | null } | null;
  addsRemaining: number;
  /** Candidate FAs evaluated (by season value and by this-week value each). */
  maxCandidates?: number;
  /** Moves returned. */
  limit?: number;
}
export interface AddDropResult {
  moves: MoveSuggestion[];
  baseline: { week: WeekDetail; ros: RosDetail };
  evaluated: number;
  droppable: PlayerRef[];
  notes: string[];
}

const ref = (p: SeasonPlayer): PlayerRef => ({ playerId: p.id, name: p.name, team: p.team, positions: p.positions.join("/") });
const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pp`;

/** Hold-value of a permanent add counts this many weekly deltas (the next ROS weeks). */
const HOLD_WEEKS = 4;
const MIN_SCORE = 0.002;
const TOP_PROTECTED = 8;
/** An injured player returning later than this many days is droppable / IL material. */
export const LONG_TERM_DAYS = 10;

export function isLongTermOut(p: SeasonPlayer, today: string): boolean {
  const i = p.injury;
  if (i.flag === "ofs") return true;
  if (i.flag !== "out") return false;
  return !i.estReturn || i.estReturn > addDays(today, LONG_TERM_DAYS);
}

/** Why a move helps, from the change in per-category win probability: the biggest gains and the biggest loss. */
export function catReasons(base: number[], next: number[], horizon: string): string[] {
  const d = SEASON_CATS.map((c, i) => ({ c, d: next[i] - base[i] }));
  const ups = d.filter((x) => x.d > 0.01).sort((a, b) => b.d - a.d).slice(0, 3);
  const downs = d.filter((x) => x.d < -0.01).sort((a, b) => a.d - b.d).slice(0, 2);
  const out: string[] = [];
  if (ups.length) out.push(`${horizon}: ${ups.map((x) => `${x.c} ${pp(x.d)}`).join(", ")}`);
  if (downs.length) out.push(`costs ${downs.map((x) => `${x.c} ${pp(x.d)}`).join(", ")}`);
  return out;
}

/** Roster spots the league allows without IL (active + bench). */
export const rosterCapacity = (ctx: LineupContext): number => ctx.settings.rosterSlots.length + ctx.settings.benchSlots;

export function rankMoves(input: AddDropInput): AddDropResult {
  const { ctx, players, entries, opponents } = input;
  const today = ctx.today;
  const notes: string[] = [];
  const mine = entries.map((e) => ({ e, p: players.get(e.playerId) })).filter((x): x is { e: RosterEntry; p: SeasonPlayer } => !!x.p);
  const live = mine.filter((x) => x.e.status !== "il").map((x) => x.p);
  const ilCount = mine.filter((x) => x.e.status === "il").length;
  const model = buildModel(ctx, opponents, input.matchup, input.schedule);
  const baseWeek = model.week(live);
  const baseRos = model.ros(live);

  const capacity = rosterCapacity(ctx);
  const openSpots = Math.max(0, capacity - live.length);
  const value = (p: SeasonPlayer) => p.nineCat * Math.max(0.3, p.avail);
  const ranked = [...live].sort((a, b) => value(b) - value(a));
  const protectedIds = new Set(ranked.slice(0, TOP_PROTECTED).filter((p) => !isLongTermOut(p, today)).map((p) => p.id));
  const droppable = live.filter((p) => !protectedIds.has(p.id));

  // Candidate free agents: healthy-ish, in the projection data, not on a roster. Shortlist by season value and by value x games this week.
  const rostered = new Set(entries.map((e) => e.playerId));
  for (const o of opponents) for (const p of o.players) rostered.add(p.id);
  const pool = input.freeAgentIds.map((id) => players.get(id)).filter((p): p is SeasonPlayer => !!p && !rostered.has(p.id) && p.injury.flag !== "ofs" && !(p.injury.flag === "out" && isLongTermOut(p, today)));
  const maxC = input.maxCandidates ?? 120;
  const gamesLeft = (p: SeasonPlayer) => gamesLeftThisWeek(ctx.schedule, p.team, today);
  const byValue = [...pool].sort((a, b) => value(b) - value(a)).slice(0, maxC);
  const byWeek = [...pool].sort((a, b) => value(b) * gamesLeft(b) - value(a) * gamesLeft(a)).slice(0, maxC);
  const cands = [...new Map([...byValue, ...byWeek].map((p) => [p.id, p])).values()];
  if (!cands.length) notes.push("No free-agent candidates (no captured free-agent pool and nobody unrostered with a projection).");

  // Ways to make room for a candidate.
  type Slot = { drop: SeasonPlayer | null; il: SeasonPlayer | null; base: SeasonPlayer[] };
  const rooms: Slot[] = [];
  if (openSpots > 0) rooms.push({ drop: null, il: null, base: live });
  const ilFree = Math.max(0, ctx.settings.ilSlots - ilCount);
  const longOut = live.filter((p) => isIlEligible(p) && (p.injury.flag === "ofs" || !p.injury.estReturn || p.injury.estReturn > addDays(today, 2)));
  if (ilFree > 0) for (const p of longOut) rooms.push({ drop: null, il: p, base: live });
  for (const p of droppable) rooms.push({ drop: p, il: null, base: live.filter((x) => x.id !== p.id) });

  const cThin = (() => {
    const cSlots = ctx.settings.rosterSlots.filter((s) => s === "C").length;
    const eligible = live.filter((p) => slotAccepts("C", p.positions) && p.injury.flag !== "ofs").length;
    return eligible <= cSlots + 1;
  })();

  const out: MoveSuggestion[] = [];
  let evaluated = 0;
  for (const f of cands) {
    let best: MoveSuggestion | null = null;
    for (const room of rooms) {
      evaluated++;
      const roster = [...room.base, f];
      // Parking an injured player on IL: this week he is out anyway; for the rest of the season count him as gone (when he returns you must cut somebody).
      const rosRoster = room.il ? [...room.base.filter((x) => x.id !== room.il!.id), f] : roster;
      const w = model.week(roster);
      const r = model.ros(rosRoster);
      const dWeek = w.winProb - baseWeek.winProb;
      const dRos = r.winProb - baseRos.winProb;
      const isInjuryFix = !!room.il || (!!room.drop && isLongTermOut(room.drop, today));
      const hold = dRos >= 0;
      const score = hold ? HOLD_WEEKS * dRos + dWeek : dWeek;
      if (best && score <= best.score) continue;
      const games = gamesLeft(f);
      const kind: MoveKind = isInjuryFix && hold ? "injury" : hold ? "season" : "stream";
      const pos = f.positions.join("/");
      const label = kind === "injury" ? `Injury replacement (${pos})` : kind === "stream" ? `Stream this week (${games} game${games === 1 ? "" : "s"})` : "Season add";
      const reasons: string[] = [];
      reasons.push(...catReasons(baseWeek.catP, w.catP, "this week"));
      if (hold) reasons.push(...catReasons(baseRos.catP, r.catP, "rest of season").slice(0, 1));
      if (f.positions.includes("C") && cThin && (f.positions.length === 1 || !f.positions.includes("PF"))) reasons.push("adds C depth (thin at C)");
      const news: string[] = [];
      if (f.boost) news.push(f.boost.reason);
      if (f.injury.flag === "gtd") news.push(`${f.name} is a game-time decision${f.injury.injury ? ` (${f.injury.injury})` : ""}`);
      if (f.injury.headline) news.push(f.injury.headline);
      if (room.il) news.push(`${room.il.name} is out${room.il.injury.injury ? ` (${room.il.injury.injury})` : ""}${room.il.injury.estReturn ? `, back ${room.il.injury.estReturn}` : ""}: IL slot is free`);
      else if (room.drop && isLongTermOut(room.drop, today)) news.push(`${room.drop.name} is out long-term: IL slots are full, so drop him`);
      best = {
        kind, label,
        add: { ...ref(f), games, pctOwned: input.pctOwned?.get(f.id) ?? null },
        drop: room.drop ? ref(room.drop) : null,
        ilMove: room.il ? ref(room.il) : null,
        dWeek, dRos, score, reasons, news,
      };
    }
    if (best && best.score >= MIN_SCORE) out.push(best);
  }

  out.sort((a, b) => b.score - a.score);
  // Diversify: one move per add; one drop may fill at most half the list. The cheapest drop is usually the same player for every
  // good add, and the alternatives for that spot are exactly what the manager compares (a cap of 2 hid the third-best add).
  const limit = input.limit ?? 8;
  const perDrop = Math.max(2, Math.ceil(limit / 2));
  const used = new Map<string, number>();
  const moves: MoveSuggestion[] = [];
  for (const m of out) {
    const key = m.drop?.playerId ?? m.ilMove?.playerId ?? "spot";
    if ((used.get(key) ?? 0) >= perDrop) continue;
    used.set(key, (used.get(key) ?? 0) + 1);
    moves.push(m);
    if (moves.length >= limit) break;
  }
  if (input.addsRemaining <= 0) for (const m of moves) m.blocked = "No adds left this week (resets Monday)";
  else if (input.addsRemaining === 1) for (const m of moves) if (m.kind === "stream") m.reasons.push("1 add left this week: save it unless this is clearly your best use");
  return { moves, baseline: { week: baseWeek, ros: baseRos }, evaluated, droppable: droppable.map(ref), notes };
}

export { positionGroups, gamesLeftThisWeek };
