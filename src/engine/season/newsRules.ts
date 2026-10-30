import { positionGroups } from "./slots";
import { isLongTermOut, type MoveSuggestion, type PlayerRef } from "./addDrop";
import { isIlEligible } from "./lineup";
import { addDays } from "./schedule";
import type { RosterEntry, SeasonPlayer } from "./types";

/** Minutes per game above which a player counts as a rotation starter whose absence matters to teammates. */
export const STARTER_MINUTES = 22;
const MAX_BOOST = 1.3;
/** Share of the absent player's minutes that flows to same-position-group teammates (rest goes elsewhere). */
const ABSORB = 0.55;
const ELASTICITY = 0.85;

export interface Boost {
  factor: number;
  until: string | null;
  reason: string;
}

/**
 * Teammate-of-injured-starter bump. For every injured rotation player (out / out for season, >= STARTER_MINUTES) the healthy teammates in
 * the same position group (G / F / C) share ABSORB of his minutes; a teammate's counting stats scale by 1 + 0.85 * extra / his minutes
 * (cap +30% in total). Applies until the injured player's estimated return (unknown: 14 days). Pure; the caller sets `boost` on the players.
 */
export function computeBoosts(all: readonly SeasonPlayer[], today: string): Map<string, Boost> {
  const byTeam = new Map<string, SeasonPlayer[]>();
  for (const p of all) (byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)!).push(p);
  const out = new Map<string, Boost>();
  for (const roster of byTeam.values()) {
    const injured = roster.filter((p) => (p.injury.flag === "out" || p.injury.flag === "ofs") && p.minutes >= STARTER_MINUTES && (!p.injury.estReturn || p.injury.estReturn > today));
    if (!injured.length) continue;
    for (const inj of injured) {
      const groups = positionGroups(inj.positions);
      const mates = roster.filter((q) => q.id !== inj.id && q.injury.flag !== "out" && q.injury.flag !== "ofs" && q.minutes >= 8 && [...positionGroups(q.positions)].some((g) => groups.has(g)));
      if (!mates.length) continue;
      const take = mates.sort((a, b) => b.minutes - a.minutes).slice(0, 4);
      const extra = (inj.minutes * ABSORB) / take.length;
      for (const q of take) {
        const gain = Math.min(0.3, (ELASTICITY * extra) / Math.max(q.minutes, 12));
        const prev = out.get(q.id);
        const factor = Math.min(MAX_BOOST, (prev?.factor ?? 1) * (1 + gain));
        const ret = inj.injury.estReturn ?? null;
        out.set(q.id, {
          factor,
          until: prev?.until && ret ? (prev.until > ret ? prev.until : ret) : (ret ?? prev?.until ?? null),
          reason: `minutes up: ${inj.name} out${inj.injury.injury ? ` (${inj.injury.injury})` : ""}${ret ? `, back ${ret}` : ""}${prev ? `; ${prev.reason}` : ""}`.slice(0, 220),
        });
      }
    }
  }
  return out;
}

export interface SeasonAlert {
  kind: "il-move" | "activate" | "fa-bump" | "gtd";
  priority: number;
  title: string;
  detail: string;
  playerId?: string;
}

/**
 * News -> actions for the user's roster:
 *  - an IL-eligible player of yours out long-term and not on IL -> "move to IL", plus the best replacement from `moves`;
 *  - a player on your IL who is healthy again / returns within a day -> "activate" (and who to drop);
 *  - free agents on a team whose same-position starter is out -> "minutes up" (flag);
 *  - your game-time decisions today.
 */
export function buildAlerts(args: {
  today: string;
  entries: readonly RosterEntry[];
  players: ReadonlyMap<string, SeasonPlayer>;
  freeAgentIds: readonly string[];
  moves: readonly MoveSuggestion[];
  ilSlots: number;
  droppable: readonly PlayerRef[];
}): SeasonAlert[] {
  const { today, entries, players } = args;
  const alerts: SeasonAlert[] = [];
  const mine = entries.map((e) => ({ e, p: players.get(e.playerId) })).filter((x): x is { e: RosterEntry; p: SeasonPlayer } => !!x.p);
  const ilUsed = mine.filter((x) => x.e.status === "il").length;

  for (const { e, p } of mine) {
    if (e.status !== "il" && isLongTermOut(p, today) && isIlEligible(p)) {
      const rep = args.moves.find((m) => m.ilMove?.playerId === p.id || m.drop?.playerId === p.id);
      const full = ilUsed >= args.ilSlots;
      alerts.push({
        kind: "il-move", priority: 1, playerId: p.id,
        title: `${p.name}: ${full ? "IL is full, consider dropping" : "move to IL"}`,
        detail: `${p.name} is out${p.injury.injury ? ` (${p.injury.injury})` : ""}${p.injury.estReturn ? `, back ${p.injury.estReturn}` : p.injury.flag === "ofs" ? " for the season" : ", no return date"}.${rep ? ` Best replacement: ${rep.add.name} (${rep.add.positions}, ${rep.label}).` : ""}`,
      });
    }
    if (e.status === "il") {
      const back = p.injury.flag === "healthy" || p.injury.flag === "gtd" || (p.injury.estReturn && p.injury.estReturn <= addDays(today, 1));
      if (back) {
        const worst = args.droppable.length ? args.droppable[args.droppable.length - 1] : null;
        alerts.push({
          kind: "activate", priority: 1, playerId: p.id,
          title: `${p.name}: activate from IL`,
          detail: `${p.name} is ${p.injury.flag === "healthy" ? "healthy again" : p.injury.estReturn ? `due back ${p.injury.estReturn}` : "listed day-to-day"}. Moving him to the roster needs a spot${worst ? `; weakest droppable: ${worst.name}` : ""}.`,
        });
      }
    }
    if (e.status !== "il" && p.injury.flag === "gtd") {
      alerts.push({ kind: "gtd", priority: 3, playerId: p.id, title: `${p.name}: game-time decision`, detail: `${p.injury.injury ?? "Questionable"}${p.injury.headline ? ` - ${p.injury.headline}` : ""}. Check status before lock.` });
    }
  }

  const faSet = new Set(args.freeAgentIds);
  const bumped = [...faSet].map((id) => players.get(id)).filter((p): p is SeasonPlayer => !!p && !!p.boost && p.injury.flag === "healthy");
  bumped.sort((a, b) => b.nineCat * b.boost!.factor - a.nineCat * a.boost!.factor);
  for (const q of bumped.slice(0, 5)) {
    alerts.push({ kind: "fa-bump", priority: 2, playerId: q.id, title: `FA ${q.name} (${q.team} ${q.positions.join("/")}): minutes up`, detail: `${q.boost!.reason.replace(/^minutes up: /, "")} (about +${Math.round((q.boost!.factor - 1) * 100)}% production while it lasts).` });
  }
  return alerts.sort((a, b) => a.priority - b.priority);
}
