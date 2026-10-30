import { isRealPlayer, teamLabel, type AnalysisDraft, type AnalysisPlayer } from "./types";

export interface AutopickPick {
  pick: number;
  teamSlot: number;
  /** The pick equals the best available by Yahoo ADP (ties: Yahoo rank). */
  adpTop: boolean;
  /** The pick equals the best available by Yahoo rank. */
  rankTop: boolean;
}

export interface TeamAutopick {
  teamSlot: number;
  teamName: string;
  isUser: boolean;
  picks: number;
  adpTop: number;
  /** adpTop / picks. */
  share: number;
  rankTop: number;
  rankShare: number;
  /** Likely bot / absent manager: share >= flagAt. */
  flagged: boolean;
}

/**
 * Autopick detection: Yahoo's autodraft takes the best available by its own ranking, so a pick equal to the top
 * available by ADP (or rank) is "autopick-like". Chalk picks by an engaged manager also match, so read the share
 * relative to the league (flag default 0.6).
 */
export function detectAutopicks(draft: AnalysisDraft, players: Map<string, AnalysisPlayer>, flagAt = 0.6): { byPick: AutopickPick[]; byTeam: TeamAutopick[] } {
  const pool = [...players.values()].filter(isRealPlayer);
  const byAdp = pool.slice().sort((a, b) => a.adp - b.adp || a.rank - b.rank);
  const byRank = pool.slice().sort((a, b) => a.rank - b.rank || a.adp - b.adp);
  const taken = new Set<string>();
  let ia = 0;
  let ir = 0;
  const byPick: AutopickPick[] = [];
  for (const k of draft.picks.slice().sort((a, b) => a.pick - b.pick)) {
    while (ia < byAdp.length && taken.has(byAdp[ia].id)) ia++;
    while (ir < byRank.length && taken.has(byRank[ir].id)) ir++;
    if (isRealPlayer(players.get(k.playerId))) {
      byPick.push({ pick: k.pick, teamSlot: k.teamSlot, adpTop: byAdp[ia]?.id === k.playerId, rankTop: byRank[ir]?.id === k.playerId });
    }
    taken.add(k.playerId);
  }
  const slots = [...new Set(byPick.map((b) => b.teamSlot))].sort((a, b) => a - b);
  const byTeam = slots.map((teamSlot) => {
    const xs = byPick.filter((b) => b.teamSlot === teamSlot);
    const adpTop = xs.filter((x) => x.adpTop).length;
    const rankTop = xs.filter((x) => x.rankTop).length;
    return {
      teamSlot, teamName: teamLabel(draft, teamSlot), isUser: teamSlot === draft.userSlot, picks: xs.length,
      adpTop, share: xs.length ? adpTop / xs.length : 0, rankTop, rankShare: xs.length ? rankTop / xs.length : 0,
      flagged: xs.length >= 5 && adpTop / xs.length >= flagAt,
    };
  });
  return { byPick, byTeam };
}
