# Fantasy Copilot

A personal command center for a **Yahoo Fantasy Basketball** team (head-to-head, 9 categories), built as a hobby project and shared as **inspiration and a reference architecture**. The idea: *decision first, numbers as proof*. Every screen opens with what to do, then the win-probability math that backs it.

- **Draft room:** live recommendations during a snake draft (Monte Carlo survival odds per pick, DRAFT / TAKE / WAIT states, category fit), with a Safari userscript that reads the Yahoo draft room.
- **Season mode:** today's lineup, add/drop suggestions scored as *change in weekly win probability* (this week vs rest of season), matchup odds per category, league analysis (power ranking, head-to-head, depth), a trade finder that keeps only trades both teams gain from.
- **Morning brief:** the engine's numbers are turned into a short plan by Claude (Claude Code CLI, headless) and pushed to the phone as a Web Push notification. The prompt forbids inventing numbers; Claude only prioritises what the engine computed.
- **iPhone PWA:** Home Screen app with push, dark/light themes.

> **Not affiliated with Yahoo, the NBA or Anthropic.** This project reads Yahoo pages of a league *you* are in, with *your* own login, at a human pace, read-only. Automated access may conflict with Yahoo's terms of service: read them and decide for yourself. Prefer the official Yahoo Fantasy Sports API (OAuth) if you build something for other people. No warranty: see the license.

## How it works

```
Yahoo league pages ──(userscript / headless Chromium you log in to yourself)──► Next.js API ──► SQLite
                                                                                   │
            NBA.com stats · schedule · injury news feeds ──────────────────────────┤
                                                                                   ▼
                           Engine (pure TypeScript): projections blend → lineup optimizer →
                           Poisson-binomial weekly win probability → add/drop & trade search
                                                                                   │
                       Next.js UI (Today · Moves · Matchup · League)   Scheduler → Claude brief → Web Push
```

- `src/engine/` is framework-free TypeScript: valuation, draft simulator, season model (`season/evaluate.ts`, `addDrop.ts`, `trades.ts`, `report.ts`).
- `src/app/(copilot)/` and `src/ui/` are the season UI; `src/app/draft` is the draft room.
- `extension/` is the read-only Yahoo reader (Safari *Userscripts*), also injected by the always-on browser worker (`scripts/browser-worker.ts`).
- `deploy/` + `docker-compose.yml`: app, scheduler (Claude briefs, push), browser worker (Chromium + noVNC for a manual Yahoo login), Caddy.
- ~740 unit tests (vitest) and Playwright end-to-end tests.

## Quick start (local, no Yahoo needed)

```bash
pnpm install
pnpm db:seed        # loads the bundled sample data into data/fantasy.sqlite
pnpm dev            # http://localhost:3000/draft  (start a mock draft against bots)
```

After a draft, `pnpm season:init --draft=<id>` creates a season league from it; the season screens are at `/today`.

## Bundled data

`data/projections.csv` is a projection built from public NBA box-score stats. `data/yahoo-adp.csv` is **synthetic**: a ranking derived from those projections (kept under the original file name so the importer works); it is *not* Yahoo's ADP. Team and manager names in the test fixtures are anonymised.

## License

MIT, see `LICENSE`.

# Technical notes

Draft-day decision support for Yahoo 14-team H2H 9-cat snake drafts.
The draft room works fully offline: no Yahoo, internet, or LLM required.

```bash
pnpm install
pnpm db:seed        # loads data/*.csv into data/fantasy.sqlite (migrations auto-apply)
pnpm dev            # http://localhost:3000/draft
```

Keyboard: ↑/↓ select · Enter draft · U undo · S search · Esc leave search.

| Command | What |
|---|---|
| `pnpm test` | engine + DB unit tests (vitest) |
| `pnpm test:e2e` | Playwright draft flow (uses data/e2e.sqlite on port 3100) |
| `pnpm blend:backtest` / `pnpm blend:evaluate` / `pnpm data:fp-projections` | projection-blend evidence table / draft what-if / FantasyPros projections cache (see below) |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | checks |

Layout: `src/engine` (pure TS: valuation, roster, draft/simulator, risk, recommendation — no React/Next/DB imports),
`src/db` (SQLite source of truth), `src/app/api` (draft/pick/undo routes), `src/store` (Zustand), `src/workers` (Monte Carlo Web Worker).
League defaults and Draft Score weights live in `src/config/default-league.ts`.
Seed data generator + validator: `scripts/data/` (`python3 scripts/data/gen.py`, `python3 scripts/data/validate.py`).

## Real data without Yahoo (`pnpm data:import`)

Yahoo's Fantasy API now needs manual app approval, so `pnpm data:import` (`scripts/import-real-data.ts`, code in `src/integrations/projections/`) builds the same four CSVs from public sources. Previous CSVs are backed up to `data/backup-<timestamp>/`; raw responses are cached in `data/cache/` (gitignored).

| Step | Source (tried in order) |
|---|---|
| Stats (per game, latest + prior season) | NBA.com `leaguedashplayerstats` (+ `playerindex` for POSITION) with browser-like headers, 30 s timeout, 3 retries → Basketball-Reference per-game tables → your own file (`--stats-file`) |
| ADP | FantasyPros NBA ADP (Yahoo column, else AVG) → Hashtag Basketball (Yahoo ADP, else blend) → your own file (`--adp-file`) |

```bash
pnpm data:import                 # cache-first; add --refresh to refetch, --offline for cache/files only
pnpm data:import --dry-run       # parse + report, write nothing
pnpm data:import --no-include-unranked   # ADP universe only (no stats-only players); also --min-gp=10 --min-min=12
pnpm data:import --stats-source=bbref            # skip NBA.com
pnpm data:import --stats-file=nba-2025-26.json --prior-stats-file=nba-2024-25.json --adp-file=adp.html
python3 scripts/data/validate_yahoo.py           # relaxed validator
pnpm db:seed                     # upsert only
pnpm db:seed --replace           # upsert, then delete players that are not in the CSVs (and their projection/market/risk rows); players referenced by any draft pick are kept and listed. Safe while `pnpm dev` runs (SQLite WAL)
```

Manual stats fallback if NBA.com and Basketball-Reference both fail: open the URL printed by `nbaStatsUrl("2025-26")` (or https://stats.nba.com/stats/leaguedashplayerstats?Season=2025-26&SeasonType=Regular%20Season&PerMode=PerGame&MeasureType=Base&LeagueID=00 plus the empty params) in a normal browser and save the JSON, or on https://www.nba.com/stats/players/traditional choose Per Game / Regular Season / the season, then use the table's CSV download. Pass the file as `--stats-file` (and the 2024-25 equivalent as `--prior-stats-file`). Headers PLAYER_NAME|PLAYER, TEAM_ABBREVIATION|TEAM, AGE, GP, MIN, FGM, FGA, FG3M|3PM, FTM, FTA, REB, AST, STL, BLK, TOV, PTS. For ADP, save the FantasyPros or Hashtag page as HTML (or a CSV with `name,adp[,team,pos]`) and pass `--adp-file`.

Rules: players join by normalized name (accents, punctuation, Jr./Sr./II/III stripped, alias table in `names.ts`, e.g. Nic/Nicolas Claxton); existing ids/positions/ages-fallback are reused when names match; universe = top 250 by ADP (FantasyPros lists ~223). Projection = 0.7 × latest + 0.3 × prior per-game (prior GP ≥ 20; latest alone if prior is short; prior alone if latest GP < 15). Positions: previous CSV, else ADP-site eligibility, else NBA.com index (G→PG/SG, F→SF/PF, G-F→SG/SF, F-C→PF/C…). Availability = (0.6·GP latest + 0.4·GP prior)/82 (a veteran missing from the latest season counts 0 GP). ADP-ranked players without stats (rookies) use the previous CSV row, else the ADP-template line (`projection-sources.csv` source ∈ `nba_stats_blend|nba_stats_latest|nba_stats_prior|existing_csv|adp_template`). **Injury status is not live**: current status, major-injury flag, rest risk and injury history are carried from the previous CSV (new players: healthy / 1 − availability / false / 0.1).

**Stats-only players (`--include-unranked`, default on).** In a deep league (14 teams × 13 rounds) many late picks are outside FantasyPros' list, so after the ADP universe the importer appends every player in the cached/fetched NBA.com stats with GP ≥ `--min-gp` (10) and MPG ≥ `--min-min` (12) in the latest *or* prior season who is not already in the universe (same name normalization/aliases). They use the same blend/source labels, positions (previous CSV, else NBA.com index), and team = latest-season team (prior season if absent from the latest). Their ADP is max(universe ADP) + 1.0 × k, ordered by the blended per-game 9-category z-sum (FG%/FT% as volume-weighted impact, TO negative) computed over the combined pool; `adp_std_dev` follows the usual formula. Players with too few games for a projection (latest < 15 GP and prior < 20 GP) are skipped and reported. Disable with `--no-include-unranked`.

**Live-sync placeholders.** When the Yahoo draft room shows a player we still do not have, `ensurePlaceholder` (`src/integrations/yahoo/dom-ingest.ts`) first looks the player up in `data/cache/nba-stats-<season>.json` (latest, then prior; initial + last name, then team; ambiguous namesakes are not guessed; parsed once per process, see `stats-lookup.ts`) and builds a real per-game projection, age and positions (Yahoo's team/positions win when shown), keeping the `yahoo-…` id and ADP 999. No cache or no match falls back to zeros; it never throws. `matchPlayer` prefers a real player over a `yahoo-…` placeholder for the same name, so re-importing data later converts placeholders to the real rows on the next sync.

## Yahoo integration (optional, V1.5)

Note: Yahoo now requires manual approval for Fantasy API apps (all endpoints return 403 otherwise); use the real-data importer above if you do not have access.

Everything Yahoo-specific lives in `src/integrations/yahoo/`; the engine never sees Yahoo ids. Without credentials the app is unaffected (manual mode).

1. Register an app at https://developer.yahoo.com/apps/ (Fantasy Sports: Read; redirect URI `oob` for a copy/paste code).
2. Copy `.env.example` to `.env.local` and set `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, `YAHOO_REDIRECT_URI` (default `oob`).
3. `pnpm yahoo:auth` — prints the consent URL, asks for the code, stores tokens in `data/yahoo-tokens.json` (gitignored, auto-refreshed).

| Command | What |
|---|---|
| `pnpm yahoo:import --probe` | Tests whether `stats;type=projected_season` works for 3 players; prints raw stat ids |
| `pnpm yahoo:import [--source=auto\|projected\|last_season] [--limit=300] [--dry-run]` | Writes `data/projections.csv`, `yahoo-adp.csv`, `injuries.csv` (previous ones backed up to `data/backup-<timestamp>/`). Then run `pnpm db:seed` (delete `data/fantasy.sqlite*` first to drop stale players) |
| `python3 scripts/data/validate_yahoo.py` | Relaxed validator for imported data (`validate.py` assumes the 220-row seed set) |
| `pnpm yahoo:leagues` | Lists your NBA league keys, draft status and your draft slot |

API: `GET /api/yahoo/status`, `GET /api/yahoo/leagues[?leagueKey=]`, `POST /api/yahoo/sync {draftId, leagueKey}` (ingests only new picks as source `yahoo`; Yahoo errors or unmapped players return 502 with a `code` and never alter the draft).

Import heuristics (Yahoo gives no variance/injury history/age): ADP std dev = min(22, 0.8 + 0.12·ADP); players with "-" ADP are placed after the last drafted one (max + 1.5·k); availability = lastSeasonGP/82; projected games = round(min(76, GP·0.6 + 70·0.4)) × status factor; injury history = 1 − availability (averaged with the old CSV value if the player existed); age/major-injury/rest-risk carried over from the old CSV (else 27/false/0.1). 
Rookies / players without usable stats are kept if Yahoo has an ADP for them: (a) the matching row of the previous `data/projections.csv` is reused (`existing_csv`), else (b) a conservative line is generated from the per-stat median of players with ADP within ±10 (nearest 3 if sparse), scaled ×0.9 (`adp_template`). Players with neither stats nor ADP are skipped and listed. Every written player's origin is recorded in `data/projection-sources.csv` (`player_id,source` with source ∈ `yahoo_projected|last_season|existing_csv|adp_template`) and the counts are printed.

### Live sync in the draft page (V1.5)

The top bar has a **Yahoo** control. Not authenticated (`pnpm yahoo:auth` not run) → "Yahoo: not connected" (tooltip: run pnpm yahoo:auth); manual mode is unaffected. Authenticated → pick a league, optionally "New draft: N teams, slot S" to create a matching local draft, and turn on **Live sync**: it switches to Manual (bots off; "Mock vs bots" is locked while syncing) and polls `POST /api/yahoo/sync` every 2.5 s; new picks refresh the board, recompute and re-run the simulation. RATE_LIMIT/NETWORK → "Yahoo delayed" and 10 s retries; 3 consecutive failures (or AUTH) pause sync with a Resume button. An unmapped Yahoo player (`UNMAPPED_PLAYER`) shows its name with a search box to pick the matching local player, which is drafted manually and sync continues. Logic: `src/store/yahoo-sync.ts` (poller/fetch, unit-tested with fake timers), `src/store/yahoo-store.ts`, `src/components/draft-board/yahoo-control.tsx`.

### Browser sync: Yahoo draft room in Safari (read-only, no Yahoo API)

`extension/yahoo-draft-reader.user.js` (build: `pnpm ext:build`; install steps in `extension/README.md`) reads picks off the Yahoo draft room page and POSTs them to `POST /api/draft/[id]/external-picks` (source `yahoo-dom`, CORS for `https://*.yahoo.com`, 409 `UNMAPPED_PLAYER` with `name` when a name cannot be mapped). `GET /api/draft/active-id` tells the script which draft to feed; `POST /api/debug/draftroom-snapshot` (dev only, 5 MB cap) stores page snapshots in `data/cache/` to calibrate selectors. In the top bar, **Browser sync** shows when picks were last received; enabling it switches to Manual and locks "Mock vs bots" (like Yahoo live sync); unmapped names get the same manual-fix banner. Code: `src/integrations/yahoo/dom-ingest.ts`, `src/store/browser-sync*.ts`, `src/components/draft-board/browser-sync-control.tsx`, `extension/parser.js`.

## Yahoo 2026-27 projections (captured from the draft room)

Yahoo's own projections drive the valuations once captured; without them the app uses last season's NBA.com blend. The userscript reads the Players tab (read-only: it only scrolls its own view of the list, never clicks, selects or drafts) and POSTs `{ season: "2026-27", view: "proj", rows }` to `POST /api/projections/yahoo` (CORS for `https://*.yahoo.com`, zod-validated; `GET /api/projections/yahoo/status` -> `{ count, matched, created, usable, season, capturedAt }`).

* **How**: in Yahoo's Players tab choose **2026-27 Proj Stats** (turn on **Drafted** to include drafted players), then click **Capture projections** in the Draft Copilot overlay. It scrolls the list (80% of the viewport per step, ~0.5 s per render, stops when the list end is reached with no new rows or at 1500 rows), sends batches of <= 200 and scrolls back to the top. Whenever that view is on screen during normal use, newly seen rows are also sent automatically (debounced, deduped).
* **Storage**: additive migration `0003_yahoo_projections` -> table `yahoo_projections` (Yahoo id PK, season totals as Yahoo shows them, ADP, ranks). Separate from `player_projections`, so `pnpm db:seed [--replace]` never touches it. `getAllPlayerRecords` overlays it (like the news status): per game = Yahoo totals / GP (`games` = GP), `projection.projectionSource` = `"yahoo-2026-27"` (else `"nba-stats"`). Recommendation caches are invalidated after an ingest; `GET /api/players` carries the merged line, so the app recomputes valuations (top-bar chip "Projections: Yahoo 2026-27 (412 players, captured 3m ago)" reloads the board when a new capture lands).
* **Attempts** (Yahoo only gives FG%/FT%): from the points identity `PTS = 2*FGM + 3PM + FTM` with `FGM = FGA*FG%`, `FTM = FTA*FT%`, `FTA = r*FGA` (r = last season's FTA/FGA from our line, else 0.30) -> `FGA = (PTS - 3PM) / (2*FG% + r*FT%)`. If that gives an implausible volume (outside 0.4-1.4 FGA per point) the attempts-per-point ratio of our existing line (else 0.8) is used. Code and math: `src/integrations/yahoo/projection-merge.ts`.
* **Market**: if Yahoo shows an ADP and ours is missing/a placeholder (`yahoo-...` id or ADP >= 999) the Yahoo ADP is used; created players without a Yahoo ADP get `300 + Yahoo rank`.
* **Matching**: `players.yahoo_player_key = "nba.p.<yahooId>"` first (set on the first match), else `matchPlayer` (initial + last name, team, positions, ADP tie-break; an initial-only match must agree on team or a position). Players Yahoo lists that we do not have (rookies, ...) are created as real rows `yahoo-<slug>-<team>` (same ids as pick placeholders), so they appear on the board. Ambiguous rows stay unlinked.
* The same Yahoo id now rides along with picks (`yahooId` in the `external-picks` payload) and is resolved through `yahoo_player_key` before any name matching.

## Projection mix (Yahoo 2026-27 vs real stats) and Team outlook

**Auto (per player, the default)** replaces the single global mix with a per-player rate/volume split (`src/engine/projection/blend.ts`, "Auto blend"). **Fixed 0/40/60/80/100** (top-bar **Mix** select, `strategy.projectionMode = "fixed"` + `projectionWeight`) is the old global behaviour, kept as an override: `w * projection + (1 - w) * real 2025-26` per game, FGM/FGA/FTM/FTA blended separately, games `w*GP_proj + (1-w)*(0.7*GP25 + 0.3*68)`, players with < 25 GP in 2025-26 or no NBA.com stats (rookies) on the projection only, players with no projection on 2025-26 only (a Yahoo-less player whose only real sample is < 25 GP gets no blended line).

*Projection side.* "Yahoo" below is the **projection side**: Yahoo's 2026-27 projections — the league is scored on Yahoo, so **Yahoo only is the default**. FantasyPros is opt-in (`getAllPlayerRecords(..., { fantasyPros: true })` / `pnpm blend:evaluate`): then the side is `average(Yahoo, FantasyPros)` per stat when both exist (cache: `pnpm data:fp-projections`, not refreshed automatically). `components.yahoo` stays the pure Yahoo line (the evaluator's "Yahoo proj" view reproduces Yahoo's own standings table).

*Auto blend.*
```
volume = games and minutes per game      -> w_vol (0.80; 0.85 for injury returns)
rates  = per-36 production (PTS 3PM REB AST STL BLK TO, and FGM FGA FTM FTA separately so FG%/FT% stay Σmakes/Σattempts) -> w_rate per player
rate   = w_rate * projection_per36 + (1 - w_rate) * real_per36
min    = w_vol * projection_min + (1 - w_vol) * real MPG;   games = w_vol * GP_proj + (1 - w_vol) * availability(GP25)
line   = rate * min / 36
```
* *Real per-36*: 2025-26 rates; when that sample is under 1500 minutes it is topped up with 2024-25 rates (weight 0.5 per minute, never more than the missing minutes).
* *Projected minutes*: Yahoo's table has no minutes. We scale an anchor that has them (the player's real MPG; FantasyPros `MIN/GP` only when FantasyPros is opted in) by the projection's production (NBA.com fantasy-points formula) relative to the anchor's, to the power 0.85: `min = anchor_mpg * (prod_proj / prod_anchor)^0.85`, clamped 8..40. The exponent is measured (backtest: 0.86 of a between-season production change is a minutes change, r = 0.95), so "Yahoo projects +20% production" is read as mostly "+17% minutes", not as a pure rate change.
* *w_rate rules* (`playerBlendWeights(player, stats25, stats24, projection)` -> `{wRate, wVol, reasons[]}`; lean-projection rules combine as the **max**, the veteran rule only applies when none does): rookie / age <= 23 / <= 2nd NBA season **0.75**; team change (2025-26 team != Yahoo's 2026-27 team) or implied role change (|projected MPG - real MPG| >= 5) **0.70**; injury return (2025-26 GP < 40) **0.75** (volume 0.85); age >= 32 **0.65**; stable veteran (two seasons with GP >= 60, same team, age 24-31) **0.45**; everyone else **0.60**. Ages use the NBA.com convention (age at season end; DB age + 1 for 2026-27).
* *Calibration* (`pnpm blend:backtest`, `scripts/blend-backtest.ts`, math in `src/engine/projection/backtest.ts`): the agreed prior weights (0.85 / 0.80 / 0.80 / 0.70 / 0.40 / 0.60) were mixed 50/50 with an evidence-based figure and rounded to 0.05 (bounds 0.3..0.9). The evidence comes from NBA.com 2024-25 -> 2025-26 (358 players with >= 20 GP in both): per group, how well last season's per-36 z-values (rates) and MPG/GP (volume) predict the next season, measured as the squared error of one pooled regression relative to the next-season variance; with inverse-variance weighting and Yahoo's error assumed `kappa` x the pooled error, `Yahoo weight = 1 - kappa_err/(kappa_err + err_group)`. **Yahoo's own historical accuracy cannot be measured offline**, so kappa is anchored (pooled group = the agreed 0.60 for rates, 0.80 for volume) and the evidence only decides how groups differ: rates are far more predictable than volume (mean R^2 0.64 vs 0.29), stable veterans are the most predictable group (rates R^2 0.72), injury returners the least (0.49). The spread between groups is modest (0.52-0.68 vs the agreed 0.40-0.85), hence the 50/50 mix. The adopted values live in `DEFAULT_BLEND_WEIGHTS`; the script prints prior / evidence / adopted for audit.
* *UI*: the detail panel's projection line reads "Blend 75% Yahoo - young (age 20)" with "rates 75% - volume 80%" and extra reasons; hovering shows the projection line (and FantasyPros), the minutes used, and the 2025-26 and 2024-25 lines. The **Team outlook** panel has an Auto row and an Auto chip next to the fixed-weight sweep.

**Source disagreement** (`strategy.robustnessMode`, top-bar select "Disagreement: auto / penalize / ignore"; the old Robust checkbox is `penalize` = `always`, `strategy.robustness` = lambda, default 0.25; `always` keeps the older distance `|Σz_proj - Σz_real|`). `d = (1/3) * sum_c emphasis_c * |z_proj,c - z_real,c|` (the projection and real 9-cat z vectors, each standardized in its own pool; `src/engine/projection/disagreement.ts`). **Auto** (default) is round-aware: rounds 1-6 `value - 0.4 * d` (median d of the top 100 is 0.57 -> -0.23 z, p90 -0.37 z); rounds >= 10 upside `max(value, 0.5*value + 0.5*max(z_proj, z_real))`; rounds 7-9 interpolate linearly. Older drafts keep their meaning (a saved non-default weight -> fixed mix; a saved `robustness` > 0 -> penalize; otherwise auto).

`GET /api/draft/[id]/evaluation?view=proj|total|avg|blend|auto&w=0.6` returns Yahoo-style roto standings (14 for best ... 1 for worst, ties averaged, TO lower is better;
`src/engine/evaluation/standings.ts`); `?view=outlook` returns your rank under every view plus the fixed-weight sweep w = 0, 0.2 ... 1 and the auto blend (the **Team outlook** panel).
Known gap vs Yahoo's standings page: our rosters come from recorded picks (a mis-synced pick or the missing last pick changes opponents' totals), and NBA.com
2025-26 totals differ from Yahoo's by ~1-2% per category. A Yahoo-created placeholder (`yahoo-...` id, abbreviated name) only takes a real-stats row from the same team (an initial + last-name match alone used to give "J. Butler Jr." Jimmy Butler's line).

`pnpm blend:evaluate [--draft=7] [--no-fp]` scores a recorded draft under every view and replays the recommender at each of your picks (old global 0.6 vs auto), then scores the two hypothetical rosters (you take the recommendation, everyone else as recorded). It works on a read-only snapshot of the database.

### FantasyPros consensus projections (optional third source)

`pnpm data:fp-projections` fetches https://www.fantasypros.com/nba/projections/overall.php (season totals for PTS REB AST BLK STL FG% FT% 3PM GP MIN TO, ~266 players) into `data/cache/fantasypros-projections-2026-27.html` (columns located by header label; a page without the table is rejected and not cached). It is refreshed in the background (single-flight, > 12 h old) when a new draft starts (`NEWS_AUTO_REFRESH=0` disables). Per player the projection side is the per-stat average of Yahoo and FantasyPros (attempts derived like Yahoo's, so makes/attempts average separately); FantasyPros' MIN/GP anchors the projected minutes. Only the components path uses it (`getAllPlayerRecords(..., { withComponents })`, i.e. `/api/players` and the recommendations); the plain overlay, the top-level `projection` of every record, the fixed `Yahoo 100%` mix and the `Yahoo proj` evaluation view stay pure Yahoo, and `fantasyPros: false` switches it off. Code: `src/integrations/projections/fantasypros-projections.ts`.

## Before every draft

Starting a draft (NEW DRAFT / NEW MOCK) refreshes news and injuries in the background when the last update is older than
60 min (single-flight, never delays the response; `NEWS_AUTO_REFRESH=0` turns it off). In `/draft`, a **Pre-draft** checklist
shows at pick 1 (and any time from the top-bar **Pre-draft ✓/✗** chip), polling every 3 s: news < 60 min, Yahoo projections
captured < 12 h, Yahoo tab heartbeat < 15 s, Picks panel visible, Browser sync on, draft setup. It hides after pick 1.
Projections need no click: open the Yahoo draft room, Players tab, choose "2026-27 Proj Stats"; the userscript (0.3.0+)
captures automatically once per draft room (re-captures after 12 h; waits while you are on the clock).

## News & injuries (`pnpm news:update`)

Daily, deterministic (no LLM) ingestion of injury reports and headlines; failures never break the app (the last good data stays in SQLite with timestamps, spec 28).

| Source | Kind | Status (probed 2026-10-07) |
|---|---|---|
| ESPN injuries JSON (`site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries`) | status, injury, est. return, report time | works (primary). The HTML page `espn.com/nba/injuries` and `espn.com/espn/rss/nba/news` are behind a WAF challenge (HTTP 202, empty) and are not used |
| CBS injuries HTML (`cbssports.com/nba/injuries/`) | status, injury, "out until at least <date>" | works |
| RotoWire injury JSON (`rotowire.com/basketball/tables/injury-report.php`) | status only (return dates are subscriber-only) | works, partial list; lowest priority |
| Yahoo Sports RSS (`sports.yahoo.com/nba/rss.xml`), ESPN news JSON, CBS RSS, RotoWire RSS | headlines | work |

Browser UA, 20 s timeout, 2 retries; raw responses are cached in `data/cache/news/<source>.<ext>` + `.meta.json` (timestamp). Parsers are pure and fixture-tested (`tests/fixtures-news/`).

- **Merge**: per player the most recent report (by day) wins; same day -> more severe status, then ESPN > CBS > RotoWire; missing return date/injury are filled from agreeing sources. A player absent from every successful injury report (and whose last status came from a source that answered) is recorded as `healthy` with source `cleared`. An "out" whose return date passed is day-to-day.
- **Storage** (additive migration `0002_news_status`): `player_status_updates` (append-only; a row is written only when status/return changes), `player_news` (hash id, <= 30 days), `news_source_status` (per-source ok/error). `getAllPlayerRecords` overlays the latest update on `PlayerRecord.risk` (`currentStatus`, `injuryNote`, `estReturn`, `statusSource`, `statusUpdatedAt`, `gamesMissed`, `latestNews` <= 3), so a CSV reseed never clobbers news. `projectedGames` is reduced by the regular-season games missed until the return date (Oct 20 2026 - Apr 11 2027, 3.45 games/week, `engine/risk/calendar.ts`); out-for-season = 0.
- **News matching**: full names only (accent/suffix/possessive-insensitive, alias table from `names.ts`) or a unique "F. Last"; bare surnames never match; only players in the DB.
- **Engine**: risk gets a small recency bonus (<= +5, decays over 7 days) for fresh non-healthy reports; the explanation names the injury ("Out - est. return Nov 15 (ESPN, Oct 6)").
- **Out is not blanket AVOID**: "out" with a known return within ~4 months has no flat risk floor (risk follows the share of the season missed). Outside the stash window it is still AVOID (conservative). **IL stash**: in the last 3 rounds (or with <= 2 open roster spots) and while you have a free IL slot (`ilSlots: 2` in `src/config/default-league.ts` - match your league), injured-with-return players get a x0.3 risk penalty and value scaled by season share (1 - 0.75 * gamesMissed/82); the reason reads "IL stash: out until ~Dec 10 (ESPN), ~70% of season left - strong value for a late pick." Out-for-season is always AVOID.
- **Runner / API**: `pnpm news:update` prints sources ok/failed, status changes (before -> after), news counts. The server refreshes in the background (single-flight, never on a request's critical path) when an API call finds the last success older than 6 h (`NEWS_AUTO_REFRESH=0` disables). `GET /api/news/status` (last run, per-source ok/error), `POST /api/news/refresh`. Recommendation caches are invalidated after an update.
- **UI**: status pill (O / DTD / OFS, tooltip with injury, return, source, date) and a newspaper icon in the player table; latest headline link (new tab) and injury line in the detail panel; top-bar "News: updated 2h ago" chip with refresh button and per-source error tooltip. The Yahoo overlay shows a red `O` / amber `DTD` marker next to names in its list and in the Players-table badges (`status`, `injuryNote` are additive fields on `top`/`board`).

## Draft strategy

The top bar has a **Strategy** preset dropdown (Balanced, Punt FT%/FG%/TO/AST/3PM/PTS) and a risk dropdown (Conservative 0.3 default, Balanced 0.15, Aggressive 0.05). The choice is stored per draft (`drafts.strategy`, JSON; null = balanced/conservative), drives the app's table, and is what the Yahoo overlay reads. A change made through the API (e.g. from the overlay) shows up in the app within ~3 s (the draft page re-fetches the draft every 3 s and on focus; Browser sync polling also carries it).

Engine (`src/engine/recommendation/strategy.ts`, pure): `Strategy = { preset, riskTolerance (0..1), categoryEmphasis }`, emphasis = multiplier per category, 0 = punted. Presets (everything not listed stays 1):

| Preset | Emphasis |
|---|---|
| balanced | all 1 |
| punt-ft | FT% 0, FG% 1.15, REB 1.1, BLK 1.1 |
| punt-fg | FG% 0, 3PM 1.15, FT% 1.1 |
| punt-to | TO 0, AST 1.15, PTS 1.1 |
| punt-ast | AST 0, TO 0.7, BLK 1.1, REB 1.1 |
| punt-3pm | 3PM 0, FG% 1.1, REB 1.1, BLK 1.1 |
| punt-pts | PTS 0, STL 1.1, AST 1.1 |
| custom | your own `categoryEmphasis` (API only) |

`scorePlayers({ ..., strategy })`: the nineCat dimension becomes sum(z_c x emphasis_c) (normalized with the same static anchors, computed over the strategy-adjusted universe); rosterFit uses needWeight_c x emphasis_c, where need weights ignore punted categories (so a punted category never shows up as a need); `strategy.riskTolerance` overrides the config. Without a strategy (or balanced + conservative) results are identical to before. Explanations add "Fits punt-FT build" for players that are weak in a punted category. The Category profile panel greys punted categories out.

### Endpoints (CORS for `https://*.yahoo.com`, OPTIONS preflight incl. `Access-Control-Allow-Private-Network`)

- `PATCH /api/draft/[id]/strategy` body `{ preset?, riskTolerance?, categoryEmphasis? }` (partial; a non-custom `preset` resets the emphasis, `categoryEmphasis` alone switches to `custom`) -> the `DraftState` incl. `strategy`.
- `GET /api/draft/[id]/recommendations?limit=10` (1-100) and `GET /api/draft/active/recommendations` (latest active draft). Computed server-side with the same engine, strategy and simulation seed as the app (25k sims, memoized per draft/pick/picks/strategy; `top`/`board` use the same ranking as the app table). 404 `DRAFT_NOT_FOUND` otherwise. Body:

```
{ draftId, currentPick, totalPicks, status: "active"|"complete", teams, userSlot,
  onClock, userNextPick: number|null /* == currentPick while on the clock */, picksUntilUser: number|null /* 0 on the clock */,
  strategy: { preset, riskTolerance, puntedCategories: string[] },
  needs: [{ category, weight }]            // 9, desc by weight; = need weight x emphasis, punted = 0
  roster: [{ pick, playerId, name, positions: "PG/SG", nbaTeam }],
  top: [{ playerId, name, nbaTeam, positions, adp, state: "DRAFT"|"TAKE"|"WAIT"|"RISKY WAIT"|"AVOID",
          score /* risk-adjusted, 1 decimal */, nineCat, rosterFit, survival: number|null, riskLabel: "Low"|"Medium"|"High", reason }],
  board: [{ playerId, name, nbaTeam, state, score, rank }],   // ALL available players, rank 1 = best score
  generatedAt: ISO string, simMs: number|null }              // simMs/survival null if the sim fails or the draft is complete
```

Code: `src/server/recommendations.ts` (unit-tested with an in-memory DB), routes under `src/app/api/draft/`.

## Standings optimizer (H2H weekly wins, roto top-5) — `src/engine/standings-opt/**`

The z-sum ranks players one by one; the league is won by the TEAM: Yahoo H2H 9-cat (a week is won with >= 5 of 9 categories) and the three Yahoo standings views (2026-27 projected totals, 2025-26 totals, 2025-26 averages). Since v0.5 every recommendation is checked against an **expected final standings model** and the Draft Score gets a **Roto** dimension (weight 0.45, the other six weights scale by 0.55; it only exists while the standings analysis is available, otherwise the classic score is unchanged).

**Objective** (strategy setting, top-bar dropdown and overlay select, default "H2H weekly wins"; `PATCH .../strategy { objective }`):

| objective | what the Roto dimension maximizes |
|---|---|
| `h2h` (default) | `J = 100·(mean_v W_v + 0.5·min_v W_v) − 0.5·Σ_v max(0, rank_v − 5)`; W_v = the user's average weekly matchup win probability vs the 13 opponents' final rosters in view v; roto rank outside the top 5 is only a light tiebreak |
| `robust` | `J = Σ_v p_v + 1·min_v p_v − 2·Σ_v max(0, rank_v − 5)` (roto points p_v, worst Yahoo view prioritized) |
| `max-total` | `J = Σ_v p_v` |
| `classic` | pre-standings behavior: z-score score only (also plain TO z) |

**Expected final standings** (`expected.ts`): from the current picks, R = 120 seeded completions of the whole draft. Opponents follow the survival simulator's model (sampled `adp + k·sd·N(0,1) − 0.01·value`, lowest key available; fitted `k`/autopick share when enabled; no positional need). The user's future picks are greedy under a cheap surrogate of the objective (among the next 10 undrafted by ADP; roto kinds: Σ Φ((x−μ)/σ); h2h: P(>=5 cat wins) vs the average opponent). A candidate c is "the user takes c at his next pick" (conditional on getting him; survival stays in the recommendation layer); all candidates share the same random draws, so differences are much less noisy than levels. Final evaluation per completion is exact (the Yahoo roto evaluator, ties averaged, TO lower is better; the weekly model below). Candidates = top 18 by classic score + top 10 ADP + top 10 by surrogate gain. ~190 ms for ~22 candidates x 3 views at pick 1 (less later; memoized per draft state).

**Views**: proj = Yahoo 2026-27 season totals (`yahoo_projections`; a player Yahoo has no line for counts nothing, exactly like Yahoo; `fallbackProj` option uses the record's own projection), total = 2025-26 per-game x GP, avg = sum of 2025-26 per-game averages (FG%/FT% from per-game makes/attempts).

**Weekly H2H model** (`h2h.ts`): weekly mean = Σ per-game x 3.5 games x availability (GP/82; built into the season-total views, "avg" assumes healthy). Weekly sd (documented approximation, not a fit): counting stat `mean·sqrt(cv²/35 + 0.05²)` with game-to-game CV PTS .38, REB .50, AST .55, 3PM .75, STL .80, BLK 1.0, TO .55 (35 player-games per team-week, 5% shared schedule noise); percentages `sqrt(p(1−p)/attempts_week)·1.25`. P(win category) = Φ(Δmean/sqrt(sd_A²+sd_B²)) (TO: lower wins), P(win matchup) = Poisson-binomial P(>= 5 of 9) (independent categories, ties ignored; Yahoo counts them 0.5). A category far out of reach has a flat Φ tail, so improving it barely moves the matchup odds: punting emerges instead of being forced. Core category = average P(win) >= 60%, hopeless < 30%.

**Usage-neutral TO** (`valuation/value.ts`, on unless the objective is `classic`): `z_TO = −0.6·(tov − (a + b·(pts+ast)))/sd_resid` (OLS over the valuation pool). A low-usage big no longer gets a free +2 z from turnovers he never had the chance to commit, which used to hide weak PTS/AST in the z-sum.

**UI**: top bar second row "Weekly outlook: wins ~6.1 cats · beats 9/13 teams" + "Projected finish: Proj #4 · Total #3 · Avg #5" + category chips (green core, struck-through grey hopeless); the detail panel shows the selected player's Roto score, weekly win odds before -> after, the categories he moves and the roto rank per view without -> with him; the draft summary adds the round-robin H2H table. Reasons lead with the standings sentence ("Strengthens your core (REB, BLK): weekly win odds 58% -> 62%.", roto kinds: "Lifts your weakest view (Proj: #7 -> #5): +PTS, +AST."). Overlay (userscript 0.5.0) shows the same lines/chips, `roto`/`win` in the expanded row and an Objective select.

**API (additive)**: `GET /api/draft/[id]/recommendations` gains `objective`, `standings` (`{ kind, sims, userPicksLeft, views:{proj,total,avg:{rank,points,winProb,catsWon,beats,pTop5}}, weakest, h2h:{winProb,minWinProb,catsWon,beats,opponents,core,punted,catP}, finishLine, weeklyLine }`) and per `top[]` `roto` (0-100) and `dWinProb`. `GET /api/draft/[id]/standings` returns `{ analysis (all evaluated candidates with per-view and per-category deltas), outlook }`; `?table=1` the round-robin H2H table of the current rosters.

### Backtest (`pnpm standings:backtest [--drafts=7,9] [--variants=...] [--sims=120] [--seed=N] [--verbose]`)

Replay of the recorded Yahoo-live drafts (user slot 13): everyone else's picks stay as recorded; at each user pick the engine's DRAFT player of the full pipeline (classic scores + Roto + survival) is taken from the replayed state. If a later recorded opponent pick was already taken by the user, that opponent gets the best-ADP player that is undrafted and not recorded at any later pick (minimal perturbation, no cascade). The final team is judged against the 13 real opponent rosters by the Yahoo roto evaluator per view and the weekly H2H model (round robin). Seed 0, 120 completions, mean over drafts 7, 9, 8, 6 (8 and 6 are untuned holdouts; 6 stops at pick 158):

| variant | mean H2H win | cats/wk | all three views top 5 | mean worst roto rank | mean H2H rank |
|---|---|---|---|---|---|
| actually drafted | 71.7% | 5.40 | 1/4 | 6.0 | 3.25 |
| classic (previous engine) | 81.8% | 5.81 | 4/4 | 3.0 | 1.60 |
| max-total | 87.8% | 6.24 | 4/4 | 1.5 | 1.0 |
| robust top-5 | 87.2% | 6.19 | 4/4 | 1.0 | 1.0 |
| **h2h (default)** | **89.3%** | 6.21 | 4/4 | 1.0 | 1.0 |
| h2h, no TO fix | 88.7% | 6.18 | 4/4 | 1.5 | 1.07 |
| h2h Roto weight .2 / .6 / .85 / 1 | 88.6 / 89.8 / 89.8 / 89.8 | | 4/4 | | |

A second seed (1000) gives the same picture (h2h 89.4%, classic 81.8%, robust 87.0%, max-total 86.9%). Differences between the standings variants (about 1 point of win probability) are inside the seed noise; the robust conclusions are classic << any standings objective and the TO fix helping a little. Sensitivity of mu (0-1), nu (0-2) and the Roto weight (.3-1) is flat, so the defaults were NOT fitted to the 4 drafts (kept mu .5, nu .5, weight .45, the round numbers chosen before looking).

**Honest limits**: the optimizer and the judge use the same projections (Yahoo 2026-27 lines, 2025-26 stats), so this proves the engine does what the model says, not that the real season goes that way; the weekly H2H numbers rest on the documented variance approximation. Replays keep the opponents' recorded picks fixed, but real opponents react to what the user takes. Positions and roster slots are not modelled in the rollouts (the classic scarcity/flexibility dimensions still score them at 55% weight). The user's later picks are modelled greedily, not perfectly.

## Draft history, opponent analytics and model fit (`/history`)

Every draft keeps its data. `draft_meta.kind` ("yahoo-live" | "mock-bots" | "manual" | "damaged"; damaged = >10% unknown placeholders) decides which drafts the analytics use (clean yahoo-live only). Live ingestion also records Yahoo team names per snake slot (`draft_team`) and per-pick context (`draft_pick_context`: ADP at pick, cached recommendation rank when the app had one, yahoo id, team); these writes are best-effort and never fail ingestion. After "Draft Complete" the userscript (v0.4.0) sends the visible Standings (any of the 3 stat views), Board and Results > Teams tabs to `POST /api/draft/[id]/postdraft`; `pnpm history:import-snapshots --draft=7 [--room=<league>/<team>]` backfills the same from `data/cache/draftroom-*.html`. Header-derived picks (`via: "header"`) are the weakest source: they only fill the next pick and never rewind or report mismatches.

`pnpm history:report [--draft=6,7] [--fit] [--enable]` prints per-round pick-vs-ADP deviation, autopick-like share per team, positional runs, survival calibration (reliability table + Brier) and, with `--fit`, fits the opponent model (ADP-sigma multiplier k + autopick mixture) by maximum likelihood and stores it in `model_params`. The fit is applied by the simulator and mock bots only when enabled (/history > Model > "Apply fitted model"); default behaviour is unchanged. Engine code: `src/engine/analysis/**`.

## Season mode: daily start/sit and add/drop (`/season`)

Suggestions only: you make every move on Yahoo yourself. The app never writes to Yahoo, and the userscript only reads (see `extension/README.md`, "Season mode").

```
pnpm season:init --draft=12     # league + 14 teams (Yahoo names) + all rosters from the finished draft (idempotent; --reset re-seeds rosters)
pnpm season:schedule            # NBA schedule -> data/cache/nba-schedule.json (also auto-refreshed daily while the app runs); --file=... imports a saved copy
pnpm season:brief               # prints today's brief (start/sit, matchup, moves, alerts); --refresh regenerates, --json, --date=YYYY-MM-DD, --no-fetch
```

* **State (additive migration 0005)**: `league` (settings JSON), `league_team`, `league_roster` (slot, active/bench/il, acquired_at, source draft | yahoo-page | manual), `roster_snapshots` (history of every sync), plus `league_free_agents`, `league_state` (matchup, page tags, weekly adds) and `season_briefs`. Settings default to Yahoo standard (PG SG G SF PF F C C UTIL UTIL + 3 BN + 2 IL, 4 adds/week, daily lineups, Pacific day roll-over) and are editable under Settings on `/season` or `PUT /api/season/settings`.
* **Before opening night** (no explicit date) the page, the overview and the brief are an *opening-day preview* for the first game day (draft rosters + current injury news); briefs are stored only for the real game day.
* **Schedule** (`src/integrations/schedule`, `src/engine/season/schedule.ts`): `https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json` -> games per team and date (regular season only), cached 24 h. cdn.nba.com can answer 403 to scripts; then the cached copy is used, or, with none, every team is assumed to play 3.5 games per week and every player to have a game today (the page and brief say so). Fantasy weeks are Monday-Sunday.
* **Engines** (`src/engine/season/**`, pure and tested): per-player lines are the existing per-player "auto" blend; weekly category noise and the Poisson-binomial "win >= 5 of 9" come from the H2H model of `standings-opt`.
  * *Daily lineup*: players with a game are seated by maximum leverage-weighted category value under the slot eligibility (G = PG/SG, F = SF/PF, UTIL = anyone; exact via augmenting paths). Leverage per category = `0.2 + 0.8 * min(1, p(1-p) / 0.1875)` where p is this week's win probability in that category (toss-ups weigh most, won or lost categories least). Out / out-for-season players never start (and are offered an IL move while an IL slot is free), game-time decisions start flagged with the best healthy bench option named. If the roster page was read, the output lists START/SIT differences from what Yahoo currently shows.
  * *This week*: both teams' banked totals (Matchup page, when read) plus projected remaining games (daily lineups on the real schedule; the opponent's roster when his team is identified) -> P(win) per category and for the matchup.
  * *Add/drop*: candidates = the captured free-agent pool (else every player on no league roster); droppable = your players except the top 8 by value (unless out long-term). For each add/drop pair it recomputes (i) this week's win probability from the remaining games (streaming) and (ii) the average weekly win probability over the next 3 full weeks vs all 13 opponents' rosters; score = dWeek + 4 x dRos when dRos >= 0 (a hold: "Season add", or "Injury replacement (C)" when it replaces an injured player / uses the IL slot), else dWeek ("Stream this week (4 games)"). With no weekly adds left every move is marked blocked; with one left a stream warns.
  * *News rules*: an out rotation player (>= 22 min) lifts same-position teammates by up to 30% until his return (flags free agents "minutes up"), your long-term injured -> "move to IL" + best replacement, an IL player back -> "activate" + who to drop.
* **API** (all with CORS for `https://*.yahoo.com`, private-network preflight): `GET /api/season[?date=&moves=]` overview, `GET /api/season/status` (light, for the overlay), `POST /api/season/roster | free-agents | matchup` (userscript), `PATCH /api/season/roster` ("I did this" after you made a move on Yahoo; counts an add), `GET|PUT /api/season/settings`, `GET /api/season/brief[?refresh=1&format=text]`, `POST /api/season/refresh`, `POST /api/season/init`.
* **Daily upkeep** while the app runs (`src/instrumentation.ts`, needs a server restart once): every 30 min, only when due, the schedule (24 h), news (6 h, the existing updater) and the day's brief (stored once per game day in `season_briefs`) are refreshed. `SEASON_AUTO_REFRESH=0` turns it off. No OS scheduler is installed; run `pnpm season:brief` from your own job if you want terminal output.
* **Weekly adds**: counted from roster syncs (a new player on your Yahoo roster after the first sync, once the season has started) or set by hand (Adds used on `/season`).
* **Known limits**: other teams' rosters are the draft rosters until their Yahoo roster pages are viewed (or a free-agent list shows a player as available); the Yahoo pages are read by best-effort readers that still need real snapshots; Yahoo's first-week length, playoff weeks and IL-eligibility rules are approximations (`playoffWeeks` is stored for display only).

### Autonomous league sync, transactions and the League tab (0.7.0)

Reload one Yahoo league tab with the userscript: it discovers the league, reads your team, the matchup, the available players, the transactions and all 13 other rosters with paced same-origin GETs (read-only, see `extension/README.md`), and the app updates itself: `/season` chips (League sync, Teams n/14, Moves, Parser) come from `GET /api/season/sync-status`. Rosters = draft baseline + Yahoo transactions (`league_transactions`, deduped; your adds count toward the weekly limit) + the latest roster page of each team (authoritative when newer). Pages the parsers cannot read are saved automatically as `data/cache/season-<kind>-<ts>.html` (dev); replay one with `pnpm season:ingest-file <file>`.

**League tab** (`/season` -> League, `GET /api/season/report`, `pnpm season:report [--date=] [--json]`): every team's projected weekly categories (per-game blended projection x games from the NBA schedule, best legal daily lineup), your rank in each of the 9 categories (strengths = top-4 in the league, weaknesses = bottom-4, swing = about a coin flip), a power ranking, the head-to-head grid against all 13 opponents (win probability and expected categories in an average week, which categories they lead), positional depth (eligible players per position vs the league median), injuries and IL use, the best adds from the captured free-agent pool with the drop for each (average-week and this-week deltas, which categories move, why), cheapest drops and hold notes (punted categories count zero), and a plain-language summary. Actual 2026-27 stats-to-date are not used yet (the season is days old); projections carry the numbers.

## Always-on deployment (VPS, Docker)

`docker-compose.yml` + `deploy/` run the app, a logged-in Yahoo browser worker (league sync every ~2 h), the morning Claude brief, injury alerts and iPhone push notifications (installable PWA with Web Push) on a VPS. Step-by-step for a beginner: `deploy/README.md`. All variables: `.env.example`. New scripts: `pnpm push:vapid`, `pnpm notify --test`, `pnpm ops:scheduler [brief|injury|token]`.
