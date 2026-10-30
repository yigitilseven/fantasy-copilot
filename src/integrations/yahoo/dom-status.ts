import type { DomIngestResult } from "./dom-ingest";

/** Last browser-userscript delivery per draft, kept in memory (shared via globalThis across route bundles) for the top-bar indicator. */
export interface DomStatus {
  /** Epoch ms of the last POST (even with no new picks: the userscript sends a heartbeat). */
  receivedAt: number;
  /** Epoch ms of the last POST that wrote at least one pick. */
  lastIngestAt: number | null;
  received: number;
  highestPick: number;
  totalIngested: number;
  unmapped: DomIngestResult["unmapped"];
  mismatches: DomIngestResult["mismatches"];
  stoppedReason: DomIngestResult["stoppedReason"];
  conflict: DomIngestResult["conflict"];
  /** Accumulated non-blocking resolutions this session (guessed namesakes, placeholders, held slots), newest last. */
  autoResolved: DomIngestResult["autoResolved"];
  lastCorrection: DomIngestResult["corrected"];
  /** Reported by the userscript: is Yahoo's Picks feed in the DOM ("hidden" = side panel on Queue etc.; "n/a" = no live pick). null = old script. */
  panel: "picks" | "hidden" | "n/a" | null;
  /** Reported by the userscript: document.visibilityState === "visible". null = old script. */
  pageVisible: boolean | null;
}

export interface DomReport {
  panel?: "picks" | "hidden" | "n/a";
  pageVisible?: boolean;
}

/** A Yahoo tab delivering within this window means the board is driven from Yahoo: bots must not pick. */
export const DOM_ACTIVE_WINDOW_MS = 60_000;

const g = globalThis as unknown as { __domStatus?: Map<number, DomStatus> };
const store = () => (g.__domStatus ??= new Map());

export function recordDomStatus(draftId: number, r: DomIngestResult, now = Date.now(), report: DomReport = {}): DomStatus {
  const prev = store().get(draftId);
  const s: DomStatus = {
    receivedAt: now,
    lastIngestAt: r.ingested > 0 ? now : (prev?.lastIngestAt ?? null),
    received: r.received,
    highestPick: r.highestPick,
    totalIngested: (prev?.totalIngested ?? 0) + r.ingested,
    unmapped: r.unmapped,
    mismatches: r.mismatches,
    stoppedReason: r.stoppedReason,
    conflict: r.conflict,
    autoResolved: [...(prev?.autoResolved ?? []), ...r.autoResolved].slice(-20),
    lastCorrection: r.corrected ?? prev?.lastCorrection ?? null,
    panel: report.panel ?? null,
    pageVisible: report.pageVisible ?? null,
  };
  store().set(draftId, s);
  return s;
}

export const getDomStatus = (draftId: number): DomStatus | null => store().get(draftId) ?? null;

export const isDomSyncActive = (draftId: number, now = Date.now()): boolean => {
  const s = getDomStatus(draftId);
  return !!s && now - s.receivedAt < DOM_ACTIVE_WINDOW_MS;
};
