import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  yahooPlayerKey: text("yahoo_player_key"),
  name: text("name").notNull(),
  nbaTeam: text("nba_team").notNull(),
  /** Slash-separated, e.g. "PG/SG". */
  positions: text("positions").notNull(),
  age: real("age").notNull(),
});

export const playerProjections = sqliteTable("player_projections", {
  playerId: text("player_id")
    .primaryKey()
    .references(() => players.id, { onDelete: "cascade" }),
  games: real("games").notNull(),
  minutes: real("minutes").notNull(),
  pts: real("pts").notNull(),
  fgm: real("fgm").notNull(),
  fga: real("fga").notNull(),
  ftm: real("ftm").notNull(),
  fta: real("fta").notNull(),
  threePm: real("three_pm").notNull(),
  reb: real("reb").notNull(),
  ast: real("ast").notNull(),
  stl: real("stl").notNull(),
  blk: real("blk").notNull(),
  tov: real("tov").notNull(),
});

export const playerMarket = sqliteTable("player_market", {
  playerId: text("player_id")
    .primaryKey()
    .references(() => players.id, { onDelete: "cascade" }),
  yahooAdp: real("yahoo_adp").notNull(),
  adpStdDev: real("adp_std_dev").notNull(),
  rank: integer("rank").notNull(),
  timestamp: text("timestamp").notNull(),
});

export const playerRisk = sqliteTable("player_risk", {
  playerId: text("player_id")
    .primaryKey()
    .references(() => players.id, { onDelete: "cascade" }),
  projectedGames: real("projected_games").notNull(),
  currentStatus: text("current_status").notNull(),
  injuryHistoryScore: real("injury_history_score").notNull(),
  restRisk: real("rest_risk").notNull(),
  availabilityScore: real("availability_score").notNull(),
  majorInjuryHistory: integer("major_injury_history", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull(),
});

export const drafts = sqliteTable("drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teams: integer("teams").notNull(),
  userSlot: integer("user_slot").notNull(),
  rounds: integer("rounds").notNull(),
  currentPick: integer("current_pick").notNull().default(1),
  status: text("status", { enum: ["active", "complete"] }).notNull().default("active"),
  /** JSON-encoded Strategy; null = balanced / conservative default. */
  strategy: text("strategy"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const draftPicks = sqliteTable(
  "draft_picks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    draftId: integer("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    pick: integer("pick").notNull(),
    round: integer("round").notNull(),
    teamSlot: integer("team_slot").notNull(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id),
    source: text("source", { enum: ["manual", "yahoo", "yahoo-dom", "simulation"] }).notNull(),
    timestamp: text("timestamp").notNull(),
  },
  (t) => [unique("draft_picks_draft_pick_uq").on(t.draftId, t.pick), unique("draft_picks_draft_player_uq").on(t.draftId, t.playerId)],
);

/** Append-only injury/status history from the news ingestion (src/integrations/news). The latest row per player wins. */
export const playerStatusUpdates = sqliteTable(
  "player_status_updates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    injury: text("injury"),
    /** ISO date (YYYY-MM-DD) or null. */
    estReturnDate: text("est_return_date"),
    comment: text("comment"),
    /** "ESPN" | "CBS" | "RotoWire" | "cleared". */
    source: text("source").notNull(),
    reportedAt: text("reported_at").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => [index("player_status_updates_player_idx").on(t.playerId, t.id)],
);

export const playerNews = sqliteTable(
  "player_news",
  {
    /** Hash of player id + link + title. */
    id: text("id").primaryKey(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    link: text("link").notNull(),
    source: text("source").notNull(),
    publishedAt: text("published_at").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => [index("player_news_player_idx").on(t.playerId, t.publishedAt)],
);

/** Per-provider outcome of the last news/injury fetch (spec 28: last good data stays, with timestamps). */
export const newsSourceStatus = sqliteTable("news_source_status", {
  source: text("source").primaryKey(),
  kind: text("kind").notNull(),
  lastAttemptAt: text("last_attempt_at").notNull(),
  lastSuccessAt: text("last_success_at"),
  lastError: text("last_error"),
  itemCount: integer("item_count").notNull().default(0),
});

/**
 * Yahoo's own 2026-27 projections, captured from the draft room's Players tab by the userscript (POST /api/projections/yahoo).
 * Season TOTALS as Yahoo shows them (gp, pts, ...; fg_pct/ft_pct are fractions). Separate from player_projections so a CSV
 * reseed never clobbers them; the repository overlays them on the PlayerRecord. player_id is null when no local player matched.
 */
export const yahooProjections = sqliteTable(
  "yahoo_projections",
  {
    yahooId: text("yahoo_id").primaryKey(),
    playerId: text("player_id"),
    name: text("name").notNull(),
    nbaTeam: text("nba_team"),
    positions: text("positions"),
    gp: real("gp"),
    fgPct: real("fg_pct"),
    ftPct: real("ft_pct"),
    threePm: real("three_pm"),
    pts: real("pts"),
    reb: real("reb"),
    ast: real("ast"),
    stl: real("stl"),
    blk: real("blk"),
    tov: real("tov"),
    xrank: real("xrank"),
    rank: real("rank"),
    adp: real("adp"),
    season: text("season").notNull(),
    capturedAt: text("captured_at").notNull(),
  },
  (t) => [index("yahoo_projections_player_idx").on(t.playerId)],
);

// ---------------------------------------------------------------------------------------------------------------
// Draft history (additive): per-draft metadata, Yahoo team names, per-pick context, standings snapshots, fitted model.
// ---------------------------------------------------------------------------------------------------------------

export const DRAFT_KINDS = ["yahoo-live", "mock-bots", "manual", "damaged"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export const draftMeta = sqliteTable("draft_meta", {
  draftId: integer("draft_id")
    .primaryKey()
    .references(() => drafts.id, { onDelete: "cascade" }),
  /** "yahoo-live" | "mock-bots" | "manual" | "damaged"; derived from the picks unless set explicitly (kindLocked). */
  kind: text("kind").notNull(),
  yahooRoomKey: text("yahoo_room_key"),
  leagueName: text("league_name"),
  finishedAt: text("finished_at"),
});

export const draftTeam = sqliteTable(
  "draft_team",
  {
    draftId: integer("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    teamSlot: integer("team_slot").notNull(),
    yahooTeamName: text("yahoo_team_name").notNull(),
    isUser: integer("is_user", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [unique("draft_team_uq").on(t.draftId, t.teamSlot)],
);

export const draftPickContext = sqliteTable(
  "draft_pick_context",
  {
    draftId: integer("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    pick: integer("pick").notNull(),
    /** Yahoo ADP of the player taken, as stored when the pick was ingested. */
    adpAtPick: real("adp_at_pick"),
    /** Our recommendation rank of the player at that moment (null when no cached recommendations existed). */
    ourRankAtPick: integer("our_rank_at_pick"),
    ourStateAtPick: text("our_state_at_pick"),
    availableCount: integer("available_count"),
    yahooId: text("yahoo_id"),
    teamName: text("team_name"),
  },
  (t) => [unique("draft_pick_context_uq").on(t.draftId, t.pick)],
);

export const draftStandings = sqliteTable(
  "draft_standings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    draftId: integer("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    /** "proj-2026-27" | "total-2025-26" | "avg-2025-26" */
    view: text("view").notNull(),
    teamName: text("team_name").notNull(),
    /** Fractional ranks happen (ties: 10.5). */
    rank: real("rank").notNull(),
    fg: real("fg"),
    ft: real("ft"),
    threePm: real("three_pm"),
    pts: real("pts"),
    reb: real("reb"),
    ast: real("ast"),
    stl: real("stl"),
    blk: real("blk"),
    tov: real("tov"),
    total: real("total"),
    capturedAt: text("captured_at").notNull(),
  },
  (t) => [unique("draft_standings_uq").on(t.draftId, t.view, t.teamName)],
);

/** Fitted opponent-model parameters (key = "opponent"; value = JSON {k, autopickShare, ...}). */
export const modelParams = sqliteTable("model_params", {
  name: text("name").primaryKey(),
  value: text("value").notNull(),
  /** When false the fitted values are stored but not applied by the simulator. */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  fittedAt: text("fitted_at").notNull(),
});

// ---------------------------------------------------------------------------------------------------------------
// Season mode (additive): the league as it is played (rosters, lineup slots), captured free agents, matchup, brief.
// ---------------------------------------------------------------------------------------------------------------

export const league = sqliteTable("league", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Yahoo league key / draft room id (e.g. "100001/9" from the draft room, or "nba.l.12345"). */
  yahooLeagueKey: text("yahoo_league_key"),
  name: text("name").notNull(),
  teams: integer("teams").notNull(),
  /** The draft this league was bootstrapped from (rosters = its picks). */
  sourceDraftId: integer("source_draft_id"),
  /** JSON SeasonSettings (rosterSlots, ilSlots, weeklyAddLimit, lineupLock, playoffWeeks, ...). */
  settings: text("settings").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const leagueTeam = sqliteTable(
  "league_team",
  {
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    slot: integer("slot").notNull(),
    yahooName: text("yahoo_name").notNull(),
    isUser: integer("is_user", { mode: "boolean" }).notNull().default(false),
    /** Yahoo team id from the URL (/nba/<league>/<team>), when seen. */
    yahooTeamId: text("yahoo_team_id"),
  },
  (t) => [unique("league_team_uq").on(t.leagueId, t.slot)],
);

export const leagueRoster = sqliteTable(
  "league_roster",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    teamSlot: integer("team_slot").notNull(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id),
    /** Lineup slot as Yahoo shows it (PG, SG, G, SF, PF, F, C, UTIL, BN, IL, IL+), null when unknown. */
    lineupSlot: text("lineup_slot"),
    status: text("status", { enum: ["active", "bench", "il"] }).notNull().default("active"),
    acquiredAt: text("acquired_at").notNull(),
    source: text("source", { enum: ["draft", "yahoo-page", "manual", "transaction"] }).notNull(),
  },
  (t) => [unique("league_roster_player_uq").on(t.leagueId, t.playerId), index("league_roster_team_idx").on(t.leagueId, t.teamSlot)],
);

/** Append-only history of what a roster looked like each time it was synced (JSON array of {playerId, lineupSlot, status}). */
export const rosterSnapshots = sqliteTable(
  "roster_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    teamSlot: integer("team_slot").notNull(),
    capturedAt: text("captured_at").notNull(),
    source: text("source").notNull(),
    payload: text("payload").notNull(),
  },
  (t) => [index("roster_snapshots_team_idx").on(t.leagueId, t.teamSlot, t.id)],
);

/** Free agents captured from Yahoo's Players list (what the user viewed + same-origin page reads). */
export const leagueFreeAgents = sqliteTable(
  "league_free_agents",
  {
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    yahooId: text("yahoo_id").notNull(),
    playerId: text("player_id"),
    name: text("name").notNull(),
    nbaTeam: text("nba_team"),
    positions: text("positions"),
    pctOwned: real("pct_owned"),
    injuryTag: text("injury_tag"),
    /** JSON of whatever Yahoo stats columns were visible (key -> number). */
    stats: text("stats"),
    capturedAt: text("captured_at").notNull(),
  },
  (t) => [unique("league_fa_uq").on(t.leagueId, t.yahooId)],
);

/** Small per-league key/value state: matchup, adds-used override, schedule meta, last-sync times. */
export const leagueState = sqliteTable(
  "league_state",
  {
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique("league_state_uq").on(t.leagueId, t.key)],
);

/** One generated brief per league per game day (JSON). */
export const seasonBriefs = sqliteTable(
  "season_briefs",
  {
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    payload: text("payload").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [unique("season_briefs_uq").on(t.leagueId, t.day)],
);

/** Adds / drops / trades read from Yahoo's transactions page. `key` is stable per transaction (date + actions), so re-reading the page never duplicates. */
export const leagueTransactions = sqliteTable(
  "league_transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** add | drop | add/drop | claim | trade */
    kind: text("kind").notNull(),
    /** ISO date (YYYY-MM-DD) as shown by Yahoo, plus HH:MM when shown. */
    occurredOn: text("occurred_on"),
    occurredTime: text("occurred_time"),
    /** JSON [{ action, yahooId, name, playerId|null, teamSlot|null, teamName }] */
    actions: text("actions").notNull(),
    /** true once the actions were applied to league_roster. */
    applied: integer("applied", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => [unique("league_txn_uq").on(t.leagueId, t.key), index("league_txn_date_idx").on(t.leagueId, t.occurredOn)],
);

/** Web Push subscriptions of the installed PWA (one row per browser/device; endpoint is unique). */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: text("created_at").notNull(),
  lastOkAt: text("last_ok_at"),
  failures: integer("failures").notNull().default(0),
});
