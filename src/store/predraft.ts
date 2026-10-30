/** Pure logic for the pre-draft checklist (no React / Zustand): row states from raw statuses. */

/** News older than this is "stale" before a draft (the server refreshes on new drafts at the same threshold). */
export const PREDRAFT_NEWS_MAX_AGE_MS = 60 * 60_000;
/** Yahoo projections captured longer ago than this need a new capture. */
export const PREDRAFT_PROJ_MAX_AGE_MS = 12 * 3_600_000;
/** The userscript heartbeats every 5 s; silent for longer than this = Yahoo tab not reporting. */
export const PREDRAFT_HEARTBEAT_MAX_AGE_MS = 15_000;
export const PREDRAFT_POLL_MS = 3000;

export interface PredraftInputs {
  news: { lastSuccessAt: string | null; refreshing?: boolean } | null;
  proj: { usable: number; capturedAt: string | null } | null;
  /** Last userscript delivery for the active draft (null = none yet). */
  heartbeat: { receivedAt: number; panel?: "picks" | "hidden" | "n/a" | null } | null;
  browserSync: boolean;
  teams: number;
  userSlot: number;
  now: number;
}

export type RowState = "ok" | "bad" | "wait";
export interface PredraftRow {
  key: "news" | "projections" | "yahoo-tab" | "picks-panel" | "browser-sync" | "setup";
  label: string;
  state: RowState;
  text: string;
}

export function agoShort(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export function evaluatePredraft(i: PredraftInputs): PredraftRow[] {
  const rows: PredraftRow[] = [];

  if (!i.news) rows.push({ key: "news", label: "News", state: "wait", text: "checking…" });
  else if (i.news.lastSuccessAt && i.now - Date.parse(i.news.lastSuccessAt) <= PREDRAFT_NEWS_MAX_AGE_MS)
    rows.push({ key: "news", label: "News", state: "ok", text: `updated ${agoShort(i.now - Date.parse(i.news.lastSuccessAt))}` });
  else
    rows.push({ key: "news", label: "News", state: "bad", text: i.news.lastSuccessAt ? `stale (updated ${agoShort(i.now - Date.parse(i.news.lastSuccessAt))})` : "never updated" });

  if (!i.proj) rows.push({ key: "projections", label: "Projections", state: "wait", text: "checking…" });
  else if (i.proj.usable > 0 && i.proj.capturedAt && i.now - Date.parse(i.proj.capturedAt) <= PREDRAFT_PROJ_MAX_AGE_MS)
    rows.push({ key: "projections", label: "Projections", state: "ok", text: `Yahoo 2026-27 captured ${agoShort(i.now - Date.parse(i.proj.capturedAt))} (${i.proj.usable} players)` });
  else
    rows.push({ key: "projections", label: "Projections", state: "bad", text: "Open Yahoo draft room → Players → 2026-27 Proj Stats (captures automatically)" });

  const hbAge = i.heartbeat ? Math.max(0, i.now - i.heartbeat.receivedAt) : null;
  const reporting = hbAge !== null && hbAge < PREDRAFT_HEARTBEAT_MAX_AGE_MS;
  rows.push(
    reporting
      ? { key: "yahoo-tab", label: "Yahoo tab", state: "ok", text: `reporting (${Math.round(hbAge! / 1000)}s ago)` }
      : { key: "yahoo-tab", label: "Yahoo tab", state: "bad", text: "Join the draft room in Safari; reload it once" },
  );

  const panel = i.heartbeat?.panel ?? null;
  if (!reporting) rows.push({ key: "picks-panel", label: "Picks panel", state: "wait", text: "waiting for the Yahoo tab" });
  else if (panel === "picks") rows.push({ key: "picks-panel", label: "Picks panel", state: "ok", text: "visible" });
  else if (panel === "hidden") rows.push({ key: "picks-panel", label: "Picks panel", state: "bad", text: "Switch Yahoo's side panel to PICKS" });
  else rows.push({ key: "picks-panel", label: "Picks panel", state: "wait", text: "checked once the draft is live" });

  rows.push(
    i.browserSync
      ? { key: "browser-sync", label: "Browser sync", state: "ok", text: "on" }
      : { key: "browser-sync", label: "Browser sync", state: "bad", text: "Turn on Browser sync" },
  );

  rows.push({ key: "setup", label: "Draft setup", state: "ok", text: `${i.teams} teams · you pick #${i.userSlot}` });
  return rows;
}

export const predraftProblems = (rows: PredraftRow[]): number => rows.filter((r) => r.state === "bad").length;
