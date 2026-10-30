import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { DraftError, getDraft, recordPick, undoToPick } from "../../db/repository";
import { draftPicks, playerMarket, players } from "../../db/schema";
import { deleteContextFrom, recordIngestHistory, type RankPeek } from "../../db/history";
import { seedFromRecords } from "../../db/seed";
import type { DraftState, PlayerRecord, Position } from "../../types";
import { nameKey } from "../projections/names";
import { lookupCachedStats } from "../projections/stats-lookup";

/**
 * Read-only ingestion of picks scraped from the Yahoo draft room page (browser userscript in extension/).
 * Nothing here talks to Yahoo; the userscript only reads the DOM. Picks are written with source "yahoo-dom".
 */

export interface DomPickInput {
  pick: number;
  playerName: string;
  nbaTeam?: string;
  /** "PG,SG" / "PG/SG" / "PG SG" */
  positions?: string;
  teamName?: string;
  /** Yahoo's player id (`.ys-player[data-id]`); resolved through players.yahoo_player_key ("nba.p.<id>") before any name matching. */
  yahooId?: string;
  /**
   * "header": derived from Yahoo's always-visible header ("Last: ..."), the weakest source. May only FILL new picks at
   * currentPick: never triggers autoCorrect rewinds or mismatch reports, and is dropped when the payload has a real
   * (feed/board/results) pick for the same number.
   */
  via?: "header";
  /** Internal: replay this already-recorded local player (picks Yahoo's payload doesn't show survive a rewind). */
  keepId?: string;
}

/** Gap filling only for small holes (Yahoo virtualising a few rows), never for a filtered list such as "my team only". */
const MAX_FILL_COVERAGE = 0.8;

/** Share of pick numbers present between the payload's first and last pick. */
function coverage(sorted: DomPickInput[]): number {
  if (sorted.length < 2) return 1;
  return sorted.length / (sorted[sorted.length - 1].pick - sorted[0].pick + 1);
}

/** Recorded picks >= fromPick that the payload doesn't show and that Yahoo doesn't place elsewhere: replayed after a rewind. */
function carryOver(recorded: { pick: number; playerId: string }[], fromPick: number, shownPicks: Set<number>, yahooIds: Set<string>, names: Map<string, string>, exclude?: string): DomPickInput[] {
  return recorded
    .filter((r) => r.pick >= fromPick && !shownPicks.has(r.pick) && !yahooIds.has(r.playerId) && r.playerId !== exclude)
    .map((r) => ({ pick: r.pick, playerName: names.get(r.playerId) ?? r.playerId, keepId: r.playerId }));
}

export interface UnmappedDomPick {
  pick: number;
  name: string;
  reason: "unmatched" | "ambiguous";
  /** Names of the candidates when ambiguous. */
  candidates?: string[];
}

export interface DomMismatch {
  pick: number;
  /** Player recorded locally for this pick. */
  ours: string;
  /** Name seen on the Yahoo page. */
  seen: string;
}

export interface DomIngestResult {
  /** New picks written by this call. */
  ingested: number;
  draft: DraftState;
  /** Distinct pick numbers in the payload. */
  received: number;
  /** Highest pick number in the payload (0 when empty). */
  highestPick: number;
  /** Set when ingestion stopped at an unmapped/ambiguous name; the draft is left intact up to the previous pick. */
  unmapped: UnmappedDomPick | null;
  /** Already-recorded picks (< currentPick) whose name maps to a different local player. Never auto-corrected. */
  mismatches: DomMismatch[];
  /** Why ingestion stopped early, if it did (unmapped is reported separately). */
  stoppedReason: "gap" | "conflict" | "draft_complete" | null;
  /** Detail for stoppedReason "conflict": the player is already drafted at another pick. */
  conflict: { pick: number; name: string; alreadyAtPick: number } | null;
  /** Non-fatal oddities (e.g. the same pick number reported with two different names). */
  warnings: string[];
  /** Set when local picks disagreed with Yahoo and were rewound so Yahoo's picks could be replayed. */
  corrected: { fromPick: number; removed: number; replaced: { pick: number; ours: string; yahoo: string }[] } | null;
  /**
   * Picks recorded without a clean match so a live draft never stalls (autoCorrect mode):
   *  guessed     – namesakes; took the best-ADP candidate
   *  placeholder – player unknown locally; added from what Yahoo shows (no projections)
   *  unknown     – Yahoo's list skipped this pick; slot held until Yahoo shows it (auto-corrected then)
   */
  autoResolved: { pick: number; name: string; resolution: "guessed" | "placeholder" | "unknown"; playerId: string }[];
}

/** Yahoo / NBA.com / ESPN abbreviation variants → one canonical code. */
const TEAM_ALIASES: Record<string, string> = {
  GS: "GSW", GSW: "GSW", NO: "NOP", NOR: "NOP", NOP: "NOP", NY: "NYK", NYK: "NYK", SA: "SAS", SAS: "SAS",
  PHO: "PHX", PHX: "PHX", UTAH: "UTA", UTH: "UTA", UTA: "UTA", WSH: "WAS", WAS: "WAS", BRK: "BKN", BKN: "BKN", CHO: "CHA", CHA: "CHA",
};
export function canonTeam(t: string | undefined | null): string {
  const u = (t ?? "").trim().toUpperCase();
  return TEAM_ALIASES[u] ?? u;
}

const POS_SET = new Set(["PG", "SG", "SF", "PF", "C", "G", "F"]);
function posSet(s: string | undefined | null): Set<string> {
  const out = new Set<string>();
  for (const t of (s ?? "").toUpperCase().split(/[^A-Z]+/)) {
    if (!POS_SET.has(t)) continue;
    if (t === "G") for (const x of ["PG", "SG"]) out.add(x);
    else if (t === "F") for (const x of ["SF", "PF"]) out.add(x);
    else out.add(t);
  }
  return out;
}

interface LocalPlayer {
  id: string;
  name: string;
  nbaTeam: string;
  positions: string;
  /** Yahoo ADP; breaks ties between namesakes (Stephen vs Seth Curry). Missing = undraftable. */
  adp?: number | null;
}

/** players.yahoo_player_key for a Yahoo draft-room player id. */
export const yahooKeyFor = (yahooId: string): string => `nba.p.${yahooId}`;
/** Index key under which buildNameIndex registers players by Yahoo id (never collides with a name key). */
export const yidKey = (yahooId: string): string => `#yid:${yahooId}`;

export const PLACEHOLDER_PREFIX = "yahoo-";

/** When namesakes remain, the best-ADP one wins if the next one is at least this many picks later. */
const ADP_TIEBREAK_GAP = 30;

export type MapResult = { ok: true; player: LocalPlayer } | { ok: false; reason: "unmatched" | "ambiguous"; candidates: LocalPlayer[] };

/** Maps a scraped name (+ optional team/positions) to a local player. Pure; exported for tests. */
export function matchPlayer(index: Map<string, LocalPlayer[]>, input: Pick<DomPickInput, "playerName" | "nbaTeam" | "positions" | "yahooId">, taken?: ReadonlySet<string>): MapResult {
  // Exact Yahoo id first (set by the projections capture / earlier placeholders): no name guessing needed.
  if (input.yahooId) {
    const exact = index.get(yidKey(input.yahooId));
    if (exact?.length === 1) return { ok: true, player: exact[0] };
  }
  let cands = index.get(nameKey(input.playerName)) ?? [];
  // Yahoo's draft room abbreviates first names ("K. Durant"); fall back to first initial + last name.
  if (cands.length === 0) cands = index.get(initialKey(input.playerName)) ?? [];
  if (cands.length === 0) return { ok: false, reason: "unmatched", candidates: [] };
  // A real player beats a yahoo-… placeholder created earlier for the same name (e.g. before the stats-only import
  // added them), even when the placeholder's team is the one Yahoo shows now and the real row has an older team.
  if (cands.length > 1 && cands.some((c) => !c.id.startsWith(PLACEHOLDER_PREFIX))) cands = cands.filter((c) => !c.id.startsWith(PLACEHOLDER_PREFIX));
  if (cands.length > 1 && input.nbaTeam) {
    const t = canonTeam(input.nbaTeam);
    const byTeam = cands.filter((c) => canonTeam(c.nbaTeam) === t);
    if (byTeam.length >= 1) cands = byTeam;
  }
  if (cands.length > 1 && input.positions) {
    const want = posSet(input.positions);
    if (want.size) {
      const byPos = cands.filter((c) => {
        const have = posSet(c.positions);
        return [...want].some((p) => have.has(p));
      });
      if (byPos.length >= 1) cands = byPos;
    }
  }
  if (cands.length > 1 && taken) {
    const free = cands.filter((c) => !taken.has(c.id));
    if (free.length >= 1) cands = free;
  }
  if (cands.length > 1 && input.positions) {
    const want = [...posSet(input.positions)].sort().join("/");
    const exact = cands.filter((c) => [...posSet(c.positions)].sort().join("/") === want);
    if (exact.length === 1) cands = exact;
  }
  if (cands.length > 1) {
    const byAdp = [...cands].sort((a, b) => (a.adp ?? Infinity) - (b.adp ?? Infinity));
    const [best, next] = byAdp;
    if (best.adp != null && (next.adp == null || next.adp - best.adp >= ADP_TIEBREAK_GAP)) cands = [best];
  }
  return cands.length === 1 ? { ok: true, player: cands[0] } : { ok: false, reason: "ambiguous", candidates: cands };
}

export function buildNameIndex(db: Db): Map<string, LocalPlayer[]> {
  const index = new Map<string, LocalPlayer[]>();
  const rows = db
    .select({ id: players.id, name: players.name, nbaTeam: players.nbaTeam, positions: players.positions, adp: playerMarket.yahooAdp, yahooKey: players.yahooPlayerKey })
    .from(players)
    .leftJoin(playerMarket, eq(playerMarket.playerId, players.id))
    .all();
  for (const { yahooKey, ...p } of rows) {
    for (const k of [nameKey(p.name), initialKey(p.name)]) index.set(k, [...(index.get(k) ?? []), p]);
    const m = /^nba\.p\.(\d+)$/.exec(yahooKey ?? "");
    if (m) index.set(yidKey(m[1]), [...(index.get(yidKey(m[1])) ?? []), p]);
  }
  return index;
}

/** "Karl-Anthony Towns" and "K. Towns" → "~k|towns". Prefixed so it never collides with a full-name key. */
function initialKey(name: string): string {
  const tokens = nameKey(name).split(" ").filter(Boolean);
  return tokens.length < 2 ? "" : `~${tokens[0][0]}|${tokens[tokens.length - 1]}`;
}

/**
 * Applies a full (or partial) list of picks read from the Yahoo draft room.
 *  - sorted by pick number; only picks >= draft.currentPick are ingested, strictly in order (stops at a gap)
 *  - picks < currentPick are verified against what is recorded. With autoCorrect (default) Yahoo is the source of
 *    truth: the draft is rewound to the first pick whose recorded player differs from Yahoo's, then Yahoo's picks are
 *    replayed. Without it, mismatches are only reported.
 *  - autoCorrect (default, live drafts): NEVER stalls. Ambiguous names take the best-ADP candidate, unknown players are
 *    added as placeholders, skipped pick numbers are held by "unknown" placeholders, and a Yahoo player already
 *    drafted locally at another pick rewinds to that pick. Every such case is listed in autoResolved / corrected.
 *  - report-only (autoCorrect: false): an unmatched/ambiguous name, gap or conflict stops ingestion there
 *  - idempotent: re-sending the same list ingests 0
 * Mapping uses nameKey() (accents/suffixes/punctuation/aliases), tie-broken by NBA team, then positions, then undrafted.
 */
export function ingestDomPicks(opts: { db: Db; draftId: number; picks: DomPickInput[]; statsCacheDir?: string; index?: Map<string, LocalPlayer[]>; autoCorrect?: boolean; depth?: number; history?: { peek?: RankPeek; roomKey?: string | null; leagueName?: string | null } | false }): DomIngestResult {
  const { db, draftId } = opts;
  const auto = opts.autoCorrect !== false;
  let initial = getDraft(db, draftId);
  if (!initial) throw new DraftError("DRAFT_NOT_FOUND", `Draft ${draftId} not found`);
  const index = opts.index ?? buildNameIndex(db);
  const warnings: string[] = [];

  // Distinct pick numbers; a repeated number with a different name keeps the last one seen.
  const byPick = new Map<number, DomPickInput>();
  for (const p of opts.picks) {
    const prev = byPick.get(p.pick);
    if (p.via === "header" && prev && prev.via !== "header") continue; // a real pick for this number always wins
    if (prev && prev.via !== "header" && p.via !== "header" && nameKey(prev.playerName) !== nameKey(p.playerName)) warnings.push(`pick ${p.pick} reported twice with different names ("${prev.playerName}" / "${p.playerName}"); using "${p.playerName}"`);
    byPick.set(p.pick, p);
  }
  let sorted = [...byPick.values()].sort((a, b) => a.pick - b.pick);
  const dense = coverage(sorted.filter((p) => !p.keepId)) >= MAX_FILL_COVERAGE;

  const names = new Map<string, string>(db.select({ id: players.id, name: players.name }).from(players).all().map((p) => [p.id, p.name]));
  let ours = new Map(initial.picks.map((p) => [p.pick, p.playerId]));

  let corrected: DomIngestResult["corrected"] = null;
  if (opts.autoCorrect !== false) {
    const replaced: { pick: number; ours: string; yahoo: string }[] = [];
    const yahooIds = new Set<string>();
    for (const p of sorted) {
      if (p.keepId || p.via === "header") continue; // header-derived picks never trigger a rewind
      const m = matchPlayer(index, p);
      if (m.ok) yahooIds.add(m.player.id);
      const recorded = ours.get(p.pick);
      if (recorded === undefined) continue;
      if (m.ok && m.player.id !== recorded) replaced.push({ pick: p.pick, ours: names.get(recorded) ?? recorded, yahoo: p.playerName });
    }
    if (replaced.length) {
      const fromPick = replaced[0].pick;
      const removed = initial.picks.filter((p) => p.pick >= fromPick).length;
      const kept = carryOver(initial.picks, fromPick, new Set(sorted.map((p) => p.pick)), yahooIds, names);
      sorted = [...sorted, ...kept].sort((a, b) => a.pick - b.pick);
      initial = undoToPick(db, draftId, fromPick);
      try { deleteContextFrom(db, draftId, fromPick); } catch { /* history is best-effort */ }
      ours = new Map(initial.picks.map((p) => [p.pick, p.playerId]));
      corrected = { fromPick, removed, replaced };
      warnings.push(`rewound to pick ${fromPick} (${removed} local picks removed) to follow Yahoo`);
    }
  }
  const takenAll = (): Set<string> => new Set(getDraft(db, draftId)!.picks.map((p) => p.playerId));

  const result: DomIngestResult = {
    ingested: 0,
    draft: initial,
    received: sorted.length,
    highestPick: sorted.length ? sorted[sorted.length - 1].pick : 0,
    unmapped: null,
    mismatches: [],
    stoppedReason: null,
    conflict: null,
    warnings,
    corrected,
    autoResolved: [],
  };

  let stopped = false;
  for (const p of sorted) {
    const recorded = ours.get(p.pick);
    if (recorded !== undefined) {
      // Verification only. An unmapped name on a recorded pick is expected after a manual fix, so it is not a mismatch.
      if (p.via === "header") continue;
      const m = matchPlayer(index, p);
      if (m.ok && m.player.id !== recorded) result.mismatches.push({ pick: p.pick, ours: names.get(recorded) ?? recorded, seen: p.playerName });
      continue;
    }
    if (stopped) continue; // keep verifying later picks, but ingest nothing more
    let current = getDraft(db, draftId)!;
    if (current.status === "complete" || p.pick > current.teams * current.rounds) {
      result.stoppedReason = "draft_complete";
      stopped = true;
      continue;
    }
    if (p.pick < current.currentPick) continue;
    if (p.pick > current.currentPick) {
      // Hold small holes only; a big or sparse gap means Yahoo shows a partial/filtered list: wait for the full one.
      if (!auto || !dense || p.pick - current.currentPick > current.teams) {
        result.stoppedReason = "gap";
        stopped = true;
        continue;
      }
      // Yahoo's list skipped some picks: hold those slots so we stay in step; corrected once Yahoo shows them.
      while (current.currentPick < p.pick && current.status === "active") {
        const id = ensurePlaceholder(db, { playerName: `Unknown (Yahoo pick #${current.currentPick})` }, `yahoo-unknown-d${draftId}-p${current.currentPick}`, opts.statsCacheDir);
        result.autoResolved.push({ pick: current.currentPick, name: "unknown", resolution: "unknown", playerId: id });
        current = recordPick(db, draftId, id, "yahoo-dom");
        result.ingested++;
      }
    }
    let m: MapResult = p.keepId ? { ok: true, player: { id: p.keepId, name: p.playerName, nbaTeam: "", positions: "" } } : matchPlayer(index, p, takenAll());
    if (!m.ok) {
      if (!auto) {
        result.unmapped = { pick: p.pick, name: p.playerName, reason: m.reason, ...(m.reason === "ambiguous" ? { candidates: m.candidates.map((c) => `${c.name} (${c.nbaTeam})`) } : {}) };
        stopped = true;
        continue;
      }
      const taken = takenAll();
      const pool = m.candidates.filter((c) => !taken.has(c.id)).sort((a, b) => (a.adp ?? Infinity) - (b.adp ?? Infinity));
      if (m.reason === "ambiguous" && pool.length) {
        result.autoResolved.push({ pick: p.pick, name: p.playerName, resolution: "guessed", playerId: pool[0].id });
        m = { ok: true, player: pool[0] };
      } else {
        const id = ensurePlaceholder(db, p, placeholderId(p.playerName, p.nbaTeam), opts.statsCacheDir);
        result.autoResolved.push({ pick: p.pick, name: p.playerName, resolution: "placeholder", playerId: id });
        m = { ok: true, player: { id, name: p.playerName, nbaTeam: p.nbaTeam ?? "", positions: p.positions ?? "" } };
      }
    }
    try {
      recordPick(db, draftId, m.player.id, "yahoo-dom");
      result.ingested++;
    } catch (e) {
      if (e instanceof DraftError && e.code === "PLAYER_ALREADY_DRAFTED") {
        const at = db.select({ pick: draftPicks.pick }).from(draftPicks).where(and(eq(draftPicks.draftId, draftId), eq(draftPicks.playerId, m.player.id))).get();
        if (auto && at && p.via !== "header" && (opts.depth ?? 0) < 3) {
          // Our earlier pick of this player must be wrong (Yahoo didn't show that pick, or we guessed): rewind and replay.
          const snapshot = getDraft(db, draftId)!.picks;
          const before = snapshot.length;
          const kept = carryOver(snapshot, at.pick, new Set(sorted.map((x) => x.pick)), new Set([m.player.id]), names, m.player.id);
          undoToPick(db, draftId, at.pick);
          try { deleteContextFrom(db, draftId, at.pick); } catch { /* history is best-effort */ }
          warnings.push(`${m.player.name} was already at local pick ${at.pick}; rewound to follow Yahoo`);
          const again = ingestDomPicks({ ...opts, picks: [...sorted.filter((x) => !x.keepId || x.pick < at.pick), ...kept], index: undefined, depth: (opts.depth ?? 0) + 1 });
          return {
            ...again,
            warnings: [...warnings, ...again.warnings],
            corrected: { fromPick: at.pick, removed: before - (at.pick - 1), replaced: [...(corrected?.replaced ?? []), ...(again.corrected?.replaced ?? [])] },
            autoResolved: [...result.autoResolved, ...again.autoResolved],
          };
        }
        result.stoppedReason = "conflict";
        result.conflict = { pick: p.pick, name: m.player.name, alreadyAtPick: at?.pick ?? 0 };
        stopped = true;
        continue;
      }
      throw e;
    }
  }
  result.draft = getDraft(db, draftId)!;
  // Draft history (team names, per-pick context, kind): append-only and never allowed to fail the ingestion.
  if (opts.history !== false) recordIngestHistory(db, draftId, sorted.filter((x) => !x.keepId).map((x) => ({ pick: x.pick, yahooId: x.yahooId, teamName: x.teamName })), opts.history || {});
  return result;
}

const POSITION_SET = new Set<Position>(["PG", "SG", "SF", "PF", "C"]);

/** Id of a player created from a Yahoo sighting (picks and projections share it, so both converge on one row). */
export const placeholderId = (name: string, nbaTeam?: string): string => `yahoo-${slug(name)}-${canonTeam(nbaTeam).toLowerCase() || "fa"}`;

export function slug(name: string): string {
  return nameKey(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "player";
}

/**
 * Adds a player Yahoo shows that we have no row for, so the pick can be recorded. The stats come from the cached NBA.com
 * season files when the player is found there (initial + last name, then team; real per-game line, positions, age); the
 * Yahoo-shown team/positions win when present. Otherwise (or on any error) all-zero stats. ADP stays far-off (999):
 * placeholders are drafted on arrival and never recommended. Never throws on lookup problems; idempotent by id.
 */
function ensurePlaceholder(db: Db, p: Pick<DomPickInput, "playerName" | "nbaTeam" | "positions" | "yahooId">, id: string, statsCacheDir?: string): string {
  return createPlayerRow(db, p, id, statsCacheDir, false)!;
}

/**
 * A free agent Yahoo lists that we have no row for: created only when the cached NBA.com stats know him (real per-game line),
 * so the add/drop engine can score him. Null = no stats found (nothing created). Idempotent by id.
 */
export function ensureFreeAgentFromStats(db: Db, p: Pick<DomPickInput, "playerName" | "nbaTeam" | "positions" | "yahooId">, statsCacheDir?: string): string | null {
  return createPlayerRow(db, p, placeholderId(p.playerName, p.nbaTeam), statsCacheDir, true);
}

function createPlayerRow(db: Db, p: Pick<DomPickInput, "playerName" | "nbaTeam" | "positions" | "yahooId">, id: string, statsCacheDir: string | undefined, requireStats: boolean): string | null {
  if (db.select({ id: players.id }).from(players).where(eq(players.id, id)).get()) return id;
  const found = lookupCachedStats({ playerName: p.playerName, nbaTeam: p.nbaTeam }, statsCacheDir);
  if (requireStats && !(found && found.games > 0 && found.minutes > 0)) return null;
  const yahooPos = [...posSet(p.positions)].filter((x): x is Position => POSITION_SET.has(x as Position));
  const positions = yahooPos.length ? yahooPos : found?.positions.length ? found.positions : ["SF" as Position];
  const l = found?.line;
  const record: PlayerRecord = {
    player: { id, yahooPlayerKey: p.yahooId ? yahooKeyFor(p.yahooId) : null, name: found?.name ?? p.playerName, nbaTeam: canonTeam(p.nbaTeam) || found?.team || "FA", positions, age: found?.age ?? 25 },
    projection: {
      playerId: id, games: found?.games ?? 0, minutes: found?.minutes ?? 0, pts: l?.pts ?? 0, fgm: l?.fgm ?? 0, fga: l?.fga ?? 0, ftm: l?.ftm ?? 0, fta: l?.fta ?? 0,
      threePm: l?.threePm ?? 0, reb: l?.reb ?? 0, ast: l?.ast ?? 0, stl: l?.stl ?? 0, blk: l?.blk ?? 0, tov: l?.tov ?? 0,
    },
    market: { playerId: id, yahooAdp: 999, adpStdDev: 22, rank: 999 },
    risk: { playerId: id, projectedGames: found?.games ?? 0, currentStatus: "healthy", injuryHistoryScore: 0, restRisk: 0, availabilityScore: 1, majorInjuryHistory: false, updatedAt: new Date().toISOString() },
  };
  seedFromRecords(db, [record]);
  return id;
}
