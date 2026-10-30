import { ROTO_CATEGORIES, type RotoCategory } from "../evaluation/standings";
import { CORE_P, h2hTable } from "./h2h";
import { NF, OPT_VIEWS, VIEW_COUNT, type OptView } from "./lines";
import { NCAT, makeScratch, rotoView } from "./rank";

/**
 * Draft replay harness (pure). The recorded draft is replayed with the USER's picks replaced by a chooser (e.g. the engine's DRAFT player)
 * while every opponent keeps the recorded pick. Conflict rule: when an opponent's recorded player has already been taken by the user, that
 * opponent gets the best-ADP player that is still undrafted AND not recorded at any later pick (so the substitution never cascades; it
 * is the minimal perturbation of the real draft). Picks the user did not own are never changed otherwise.
 */
export interface ReplayPick {
  pick: number;
  teamSlot: number;
  playerId: string;
}
export interface ReplayState {
  /** Pick on the clock (the user's). */
  currentPick: number;
  /** Replayed rosters so far, index = slot - 1. */
  rosters: string[][];
  draftedIds: string[];
  userRosterIds: string[];
}
export interface ReplayInput {
  teams: number;
  rounds: number;
  userSlot: number;
  /** Recorded picks (possibly incomplete); the replay covers picks 1..max(pick). */
  picks: ReplayPick[];
  /** Every player id that may be drafted (for conflict substitutions). */
  universe: string[];
  adpOf: (id: string) => number;
  /** The user's choice at his pick; must return an undrafted player id. */
  choose: (state: ReplayState) => string;
}
export interface ReplayResult {
  rosters: string[][];
  userPicks: string[];
  /** Opponent picks that had to be substituted: pick number, the recorded player, the substitute. */
  conflicts: { pick: number; slot: number; wanted: string; gave: string }[];
}

export function replayDraft(inp: ReplayInput): ReplayResult {
  const byPick = new Map(inp.picks.map((p) => [p.pick, p]));
  const last = Math.max(0, ...inp.picks.map((p) => p.pick));
  const rosters: string[][] = Array.from({ length: inp.teams }, () => []);
  const taken = new Set<string>();
  const later = new Map<string, number>(); // recorded player -> pick
  for (const p of inp.picks) later.set(p.playerId, p.pick);
  const byAdp = [...inp.universe].sort((a, b) => inp.adpOf(a) - inp.adpOf(b) || (a < b ? -1 : 1));
  const conflicts: ReplayResult["conflicts"] = [];
  const userPicks: string[] = [];
  for (let q = 1; q <= last; q++) {
    const rec = byPick.get(q);
    if (!rec) continue;
    let id: string;
    if (rec.teamSlot === inp.userSlot) {
      id = inp.choose({ currentPick: q, rosters: rosters.map((r) => [...r]), draftedIds: [...taken], userRosterIds: [...rosters[inp.userSlot - 1]] });
      if (taken.has(id)) throw new Error(`chooser returned drafted player ${id} at pick ${q}`);
      userPicks.push(id);
    } else if (!taken.has(rec.playerId)) id = rec.playerId;
    else {
      const sub = byAdp.find((c) => !taken.has(c) && !(later.has(c) && later.get(c)! > q));
      if (!sub) throw new Error(`no substitute at pick ${q}`);
      id = sub;
      conflicts.push({ pick: q, slot: rec.teamSlot, wanted: rec.playerId, gave: sub });
    }
    taken.add(id);
    rosters[rec.teamSlot - 1].push(id);
  }
  return { rosters, userPicks, conflicts };
}

export interface TeamReport {
  /** Roto rank / points of the user per view (the real evaluator semantics, see rank.ts). */
  roto: Record<OptView, { rank: number; points: number }>;
  /** H2H per view: average matchup win probability, expected categories per week, opponents beaten, rank among all teams (round robin). */
  h2h: Record<OptView, { winProb: number; catsWon: number; beats: number; rank: number; catP: Record<RotoCategory, number> }>;
  /** Means over the views. */
  winProb: number;
  catsWon: number;
  h2hRank: number;
  core: RotoCategory[];
  punted: RotoCategory[];
  worstRotoRank: number;
  allTop5: boolean;
}

/** Final evaluation of rosters: roto ranks and the H2H round robin for team `user` (slot - 1). `lineOf` = viewLinesOf(record) per id. */
export function evaluateRosters(rosters: string[][], user: number, lineOf: (id: string) => Float64Array | null, topK = 5): TeamReport {
  const teams = rosters.length;
  const stride = VIEW_COUNT * NF;
  const T = new Float64Array(teams * stride);
  rosters.forEach((ids, t) => {
    for (const id of ids) {
      const l = lineOf(id);
      if (l) for (let k = 0; k < stride; k++) T[t * stride + k] += l[k];
    }
  });
  const scratch = makeScratch(teams);
  const roto = {} as TeamReport["roto"];
  const h2h = {} as TeamReport["h2h"];
  OPT_VIEWS.forEach((view, v) => {
    const rank = rotoView(T, teams, v, user, scratch);
    roto[view] = { rank, points: scratch.total[user] };
    const rows = h2hTable(T, teams, v);
    const me = rows[user];
    const catP = {} as Record<RotoCategory, number>;
    ROTO_CATEGORIES.forEach((c, i) => (catP[c] = me.catP[i]));
    h2h[view] = { winProb: me.winProb, catsWon: me.catsWon, beats: me.beats, rank: me.rank, catP };
  });
  const mean = (f: (v: OptView) => number) => OPT_VIEWS.reduce((a, v) => a + f(v), 0) / VIEW_COUNT;
  const catP = {} as Record<RotoCategory, number>;
  for (const c of ROTO_CATEGORIES) catP[c] = mean((v) => h2h[v].catP[c]);
  const worst = Math.max(...OPT_VIEWS.map((v) => roto[v].rank));
  void NCAT;
  return {
    roto, h2h,
    winProb: mean((v) => h2h[v].winProb),
    catsWon: mean((v) => h2h[v].catsWon),
    h2hRank: Math.round(mean((v) => h2h[v].rank) * 10) / 10,
    core: ROTO_CATEGORIES.filter((c) => catP[c] >= CORE_P),
    punted: ROTO_CATEGORIES.filter((c) => catP[c] < 0.3),
    worstRotoRank: worst,
    allTop5: worst <= topK,
  };
}
