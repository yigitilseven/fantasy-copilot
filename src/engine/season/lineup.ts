import { assignSlots, refineSlots } from "./slots";
import { playProb } from "./projection";
import { hasGame } from "./schedule";
import { startValue, weightedValue } from "./window";
import { SEASON_CATS, type LineupContext, type RosterEntry, type SeasonPlayer } from "./types";

export interface StarterRow {
  playerId: string;
  name: string;
  team: string;
  positions: string;
  slot: string;
  value: number;
  /** Chance he actually plays (injury / GTD adjusted). */
  prob: number;
  flags: string[];
  reason: string;
}
export interface BenchRow {
  playerId: string;
  name: string;
  team: string;
  positions: string;
  reason: string;
  flags: string[];
  /** true = has a game today but is not in the best lineup. */
  hasGame: boolean;
}
export interface LineupChange {
  type: "start" | "sit";
  playerId: string;
  name: string;
  toSlot?: string;
  reason: string;
}
export interface IlMove {
  playerId: string;
  name: string;
  reason: string;
  /** false = no free IL slot. */
  ilSlotFree: boolean;
}
export interface DayLineup {
  date: string;
  /** Roster players (not on IL) whose team plays today. */
  gamesToday: number;
  starters: StarterRow[];
  bench: BenchRow[];
  il: BenchRow[];
  emptySlots: string[];
  /** Differences from the lineup currently set on Yahoo (only when slots were read from the roster page). */
  changes: LineupChange[];
  ilMoves: IlMove[];
  notes: string[];
}

const ACTIVE = (slot: string | null | undefined) => !!slot && slot !== "BN" && slot !== "IL" && slot !== "IL+" && slot !== "NA";

/** Why a player helps today: his two biggest leverage-weighted category contributions. */
function helpsText(p: SeasonPlayer, w: number[]): string {
  const parts = SEASON_CATS.map((c, i) => ({ c, v: w[i] * (p.z[c] ?? 0) })).filter((x) => x.v > 0.35).sort((a, b) => b.v - a.v).slice(0, 2);
  return parts.length ? `helps ${parts.map((x) => x.c).join(", ")}` : "best available for the slot";
}

/** Players on Yahoo's roster page with an injury tag that makes them IL-eligible (O / INJ / IL). */
export const isIlEligible = (p: SeasonPlayer): boolean => p.injury.flag === "ofs" || (p.injury.flag === "out" && (!!p.injury.tag ? /^(O|INJ|IL\+?|OUT)$/i.test(p.injury.tag) : true));

/**
 * The best lineup for `ctx.today`. `weights` are the category leverage weights from this week's matchup (see matchup.ts leverageWeights);
 * uniform when absent. Rules:
 *  - out / out-for-season players never start (-> bench, or IL when a slot is free: reported in ilMoves);
 *  - players without a game today sit;
 *  - game-time decisions start when no healthy alternative with a game would beat them, flagged, naming the bench option;
 *  - starters maximize leverage-weighted category value under the position eligibility of the slots.
 */
export function planDay(entries: readonly RosterEntry[], players: ReadonlyMap<string, SeasonPlayer>, ctx: LineupContext, weights?: number[]): DayLineup {
  const w = weights ?? new Array<number>(9).fill(1);
  const notes: string[] = [];
  const row = (p: SeasonPlayer) => ({ playerId: p.id, name: p.name, team: p.team, positions: p.positions.join("/") });
  const ilEntries = entries.filter((e) => e.status === "il");
  const live = entries.filter((e) => e.status !== "il");
  const known = live.map((e) => players.get(e.playerId)).filter((p): p is SeasonPlayer => !!p);
  const missing = live.length - known.length;
  if (missing) notes.push(`${missing} roster player(s) have no projection and are ignored`);

  const il: BenchRow[] = ilEntries.map((e) => players.get(e.playerId)).filter((p): p is SeasonPlayer => !!p).map((p) => ({
    ...row(p), hasGame: false, flags: p.injury.flag === "healthy" ? ["HEALTHY"] : [], reason: p.injury.flag === "healthy" ? "Healthy on IL: activate or drop" : `On IL${p.injury.injury ? ` (${p.injury.injury})` : ""}${p.injury.estReturn ? `, back ${p.injury.estReturn}` : ""}`,
  }));

  const bench: BenchRow[] = [];
  const cands: SeasonPlayer[] = [];
  const probs = new Map<string, number>();
  for (const p of known) {
    const prob = playProb(p, ctx.today, ctx.today);
    const game = ctx.schedule ? hasGame(ctx.schedule, p.team, ctx.today) : true;
    const flags: string[] = [];
    if (p.injury.flag === "gtd") flags.push("GTD");
    if (p.injury.flag === "out" || p.injury.flag === "ofs") flags.push(p.injury.tag ?? (p.injury.flag === "ofs" ? "OFS" : "OUT"));
    if (prob <= 0) {
      const why = p.injury.flag === "ofs" ? "Out for the season" : `Out${p.injury.injury ? ` (${p.injury.injury})` : ""}${p.injury.estReturn ? `, back ${p.injury.estReturn}` : ""}`;
      bench.push({ ...row(p), reason: why, flags, hasGame: game });
    } else if (!game) bench.push({ ...row(p), reason: "No game today", flags, hasGame: false });
    else {
      cands.push(p);
      probs.set(p.id, prob);
    }
  }

  if (!ctx.schedule) notes.push("NBA schedule unavailable: assuming every rostered player has a game today");
  const slots = ctx.settings.rosterSlots;
  const byId = new Map(cands.map((p) => [p.id, p]));
  const placed = assignSlots(cands.map((p) => ({ id: p.id, positions: p.positions, value: startValue(p, probs.get(p.id)!, w) })), slots);
  const startIds = new Set(placed.filter((x): x is string => !!x));
  const shown = refineSlots(cands.filter((p) => startIds.has(p.id)).map((p) => ({ id: p.id, positions: p.positions, value: startValue(p, probs.get(p.id)!, w) })), slots);
  const starters: StarterRow[] = [];
  shown.forEach((id, i) => {
    if (!id) return;
    const p = byId.get(id)!;
    const flags = p.injury.flag === "gtd" ? ["GTD"] : [];
    starters.push({ ...row(p), slot: slots[i], value: weightedValue(p, w), prob: probs.get(p.id)!, flags, reason: helpsText(p, w) });
  });
  const order = (s: string) => ["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL"].indexOf(s);
  starters.sort((a, b) => order(a.slot) - order(b.slot) || b.value - a.value);

  const benchCands = cands.filter((p) => !startIds.has(p.id)).sort((a, b) => weightedValue(b, w) - weightedValue(a, w));
  for (const p of benchCands) bench.push({ ...row(p), hasGame: true, flags: p.injury.flag === "gtd" ? ["GTD"] : [], reason: "Has a game but every slot he can fill goes to a higher-value player" });
  const emptySlots = slots.filter((_, i) => !placed[i]);
  if (emptySlots.length) notes.push(`${emptySlots.length} slot(s) empty (${emptySlots.join(", ")}): nobody eligible plays today${ctx.schedule ? "" : " (schedule unknown)"}`);

  // GTD: name the best healthy alternative that is not starting.
  for (const s of starters.filter((x) => x.flags.includes("GTD"))) {
    const alt = benchCands.find((b) => b.injury.flag === "healthy");
    if (alt) {
      s.reason += `; GTD, bench option ${alt.name}`;
      notes.push(`${s.name} is a game-time decision: start him, but have ${alt.name} ready (${alt.positions.join("/")}).`);
    } else s.reason += "; GTD, no healthy bench option";
  }

  // IL moves: injured players who are not on IL while a slot is free.
  const ilFree = Math.max(0, ctx.settings.ilSlots - ilEntries.length);
  let free = ilFree;
  const ilMoves: IlMove[] = [];
  for (const p of known.filter(isIlEligible)) {
    const out = p.injury;
    const back = out.estReturn ? `back ${out.estReturn}` : out.flag === "ofs" ? "out for the season" : "no return date";
    const longTerm = out.flag === "ofs" || !out.estReturn || out.estReturn > ctx.today;
    if (!longTerm) continue;
    ilMoves.push({ playerId: p.id, name: p.name, ilSlotFree: free > 0, reason: free > 0 ? `Move ${p.name} to IL (${out.injury ?? out.flag}, ${back}) to free a roster spot` : `${p.name} is out (${back}) but both IL slots are full` });
    if (free > 0) free--;
  }

  // Differences from the lineup currently set on Yahoo.
  const changes: LineupChange[] = [];
  const cur = new Map(entries.map((e) => [e.playerId, e.slot]));
  const slotKnown = entries.some((e) => e.slot);
  if (slotKnown) {
    for (const s of starters) {
      const cs = cur.get(s.playerId);
      if (cs && !ACTIVE(cs)) changes.push({ type: "start", playerId: s.playerId, name: s.name, toSlot: s.slot, reason: `${s.reason} (now on ${cs})` });
    }
    for (const p of known) {
      const cs = cur.get(p.id);
      if (ACTIVE(cs) && !startIds.has(p.id)) {
        const b = bench.find((x) => x.playerId === p.id);
        changes.push({ type: "sit", playerId: p.id, name: p.name, reason: b?.reason ?? "Not in the best lineup" });
      }
    }
  }
  return { date: ctx.today, gamesToday: known.filter((p) => (ctx.schedule ? hasGame(ctx.schedule, p.team, ctx.today) : true)).length, starters, bench, il, emptySlots, changes, ilMoves, notes };
}
