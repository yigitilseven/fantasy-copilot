import type { Db } from "../../db/client";
import { DraftError, getDraft, recordPick } from "../../db/repository";
import type { DraftState } from "../../types";
import { buildKeyMapper } from "./draft-provider";
import type { YahooDraftResult } from "./normalize";

export interface DraftResultsFetcher {
  fetchDraftResults(leagueKey: string): Promise<YahooDraftResult[]>;
}

export interface SyncResult {
  /** Number of new picks written this call. */
  ingested: number;
  draft: DraftState;
  /** Yahoo player keys with no internal mapping. Ingestion stops before the first one (pick order must stay contiguous). */
  unmapped: { pick: number; yahooPlayerKey: string }[];
  /** Picks already in our draft whose player differs from Yahoo's (e.g. a wrong manual entry). Not auto-corrected. */
  mismatches: { pick: number; ours: string; yahoo: string }[];
  /** Highest contiguous pick Yahoo reports (0 if none). */
  yahooPicks: number;
  /** Set when ingestion stopped early for a reason other than unmapped players. */
  stoppedReason: "gap" | "conflict" | "draft_complete" | null;
}

/**
 * Pulls Yahoo draft results and appends only picks >= draft.currentPick, in order, via recordPick(source "yahoo").
 * Idempotent: a second call with the same Yahoo state ingests 0. Stops (without throwing) at the first unmapped player,
 * a gap in Yahoo's pick numbers, or a player that is already drafted in our state, leaving the draft consistent.
 * Yahoo/network errors propagate from the fetcher before anything is written.
 */
export async function syncYahooDraft(opts: { db: Db; draftId: number; leagueKey: string; fetcher: DraftResultsFetcher; mapKey?: (k: string) => string | null }): Promise<SyncResult> {
  const { db, draftId, leagueKey, fetcher } = opts;
  const initial = getDraft(db, draftId);
  if (!initial) throw new DraftError("DRAFT_NOT_FOUND", `Draft ${draftId} not found`);

  const results = (await fetcher.fetchDraftResults(leagueKey)).filter((r) => r.yahooPlayerKey).sort((a, b) => a.pick - b.pick);
  const mapKey = opts.mapKey ?? buildKeyMapper(db);

  // Highest contiguous pick reported.
  let contiguous = 0;
  for (const r of results) if (r.pick === contiguous + 1) contiguous = r.pick;

  const unmapped: SyncResult["unmapped"] = [];
  const mismatches: SyncResult["mismatches"] = [];
  const ours = new Map(initial.picks.map((p) => [p.pick, p.playerId]));
  let ingested = 0;
  let stoppedReason: SyncResult["stoppedReason"] = null;

  for (const r of results) {
    const playerId = mapKey(r.yahooPlayerKey!);
    const existing = ours.get(r.pick);
    if (existing !== undefined) {
      if (playerId && playerId !== existing) mismatches.push({ pick: r.pick, ours: existing, yahoo: playerId });
      continue;
    }
    const current = getDraft(db, draftId)!;
    if (current.status === "complete") {
      stoppedReason = "draft_complete";
      break;
    }
    if (r.pick !== current.currentPick) {
      stoppedReason = "gap";
      break;
    }
    if (!playerId) {
      unmapped.push({ pick: r.pick, yahooPlayerKey: r.yahooPlayerKey! });
      break;
    }
    try {
      recordPick(db, draftId, playerId, "yahoo");
      ingested++;
    } catch (e) {
      if (e instanceof DraftError && e.code === "PLAYER_ALREADY_DRAFTED") {
        stoppedReason = "conflict";
        break;
      }
      throw e;
    }
  }

  return { ingested, draft: getDraft(db, draftId)!, unmapped, mismatches, yahooPicks: contiguous, stoppedReason };
}
