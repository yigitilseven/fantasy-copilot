import type { Db } from "../../db/client";
import { ensureDraftMeta, recordStandings, recordTeams, type StandingsRowInput } from "../../db/history";
import { getDraft, DraftError } from "../../db/repository";
import { ingestDomPicks, type DomIngestResult, type DomPickInput } from "./dom-ingest";

/** Post-draft data read from the Yahoo draft room's Board / Standings / Results tabs (userscript or snapshot importer). */

export const STANDINGS_VIEWS = ["proj-2026-27", "total-2025-26", "avg-2025-26"] as const;
export type StandingsView = (typeof STANDINGS_VIEWS)[number];

export interface PostdraftInput {
  standings?: { view: string; rows: StandingsRowInput[] }[];
  board?: { teams: { slot: number; name: string; isUser?: boolean }[]; picks: DomPickInput[] };
  results?: { picks: DomPickInput[] };
  roomKey?: string | null;
  leagueName?: string | null;
  capturedAt?: string;
}

export interface PostdraftResult {
  standingsViews: string[];
  teams: number;
  boardIngest: Pick<DomIngestResult, "ingested" | "mismatches" | "corrected" | "stoppedReason" | "warnings"> | null;
  resultsIngest: Pick<DomIngestResult, "ingested" | "mismatches" | "corrected" | "stoppedReason" | "warnings"> | null;
  draftComplete: boolean;
  currentPick: number;
}

const slim = (r: DomIngestResult) => ({ ingested: r.ingested, mismatches: r.mismatches, corrected: r.corrected, stoppedReason: r.stoppedReason, warnings: r.warnings });

/**
 * Stores standings (per view), team names (Board columns) and ingests the Board / Results picks through the normal DOM path
 * (source "yahoo-dom"; the Board lists every pick, so a pick the live feed missed, such as the last one, is added).
 * Throws DraftError DRAFT_NOT_FOUND for an unknown draft.
 */
export function applyPostdraft(db: Db, draftId: number, input: PostdraftInput): PostdraftResult {
  if (!getDraft(db, draftId)) throw new DraftError("DRAFT_NOT_FOUND", `Draft ${draftId} not found`);
  let teams = 0;
  if (input.board?.teams.length) {
    recordTeams(db, draftId, input.board.teams);
    teams = input.board.teams.length;
  }
  let boardIngest: PostdraftResult["boardIngest"] = null;
  if (input.board?.picks.length) boardIngest = slim(ingestDomPicks({ db, draftId, picks: input.board.picks, history: { roomKey: input.roomKey, leagueName: input.leagueName } }));
  let resultsIngest: PostdraftResult["resultsIngest"] = null;
  if (input.results?.picks.length) resultsIngest = slim(ingestDomPicks({ db, draftId, picks: input.results.picks, history: { roomKey: input.roomKey, leagueName: input.leagueName } }));
  const views: string[] = [];
  for (const s of input.standings ?? []) {
    if (!(STANDINGS_VIEWS as readonly string[]).includes(s.view) || s.rows.length < 2) continue;
    recordStandings(db, draftId, s.view, s.rows, input.capturedAt);
    views.push(s.view);
  }
  ensureDraftMeta(db, draftId, { yahooRoomKey: input.roomKey ?? null, leagueName: input.leagueName ?? null });
  const d = getDraft(db, draftId)!;
  return { standingsViews: views, teams, boardIngest, resultsIngest, draftComplete: d.status === "complete", currentPick: d.currentPick };
}
