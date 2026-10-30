# Yahoo draft room reader (Safari userscript)

Read-only bridge: while you draft in the Yahoo draft room in Safari, a userscript reads the picks off the page and sends
them to your local Draft Copilot (`http://localhost:3000`). The board advances by itself. **It never clicks, drafts or
types on Yahoo** and uses no Yahoo API.

```
Yahoo draft room (Safari) --userscript--> POST localhost:3000/api/draft/<id>/external-picks --> /draft board
```

## Install (Safari, free "Userscripts" app by quoid)

1. Build the script (only needed after changing `extension/parser.js` or `userscript.src.js`; a built copy is checked in):
   `pnpm ext:build` -> `extension/yahoo-draft-reader.user.js`.
2. Install **Userscripts** from the Mac App Store (by Justin Wasack / quoid).
3. Safari -> Settings -> Extensions -> tick **Userscripts**. Click **Always Allow...** / "Edit Websites" and allow it on
   `yahoo.com` (or "Always Allow on Every Website"). Safari may insist on **Allow on every website** for
   `basketball.fantasysports.yahoo.com`; pick "Allow" for that host when prompted.
4. Open the **Userscripts** app, **Set Userscripts Directory** (any folder, e.g. `~/Userscripts`), then copy
   `extension/yahoo-draft-reader.user.js` into it. (Alternative: open the `.user.js` file in Safari and use the Userscripts
   toolbar button -> install prompt.)
5. Start the app (`pnpm dev`), open <http://localhost:3000/draft>, click **Browser sync** in the top bar and tick
   **Follow Yahoo draft room** (switches to Manual; "Mock vs bots" is locked while it is on).
6. Test with a Yahoo **mock draft** first: join one, and the Draft Copilot panel appears bottom-right
   (draggable, collapsible). It should say "Connected to localhost:3000"; click **⋯** for the draft id and "Parsed on page: N".
   Safari -> Develop -> Show JavaScript Console helps if nothing appears (the script must be enabled for the page).

Using a different port? Edit `APP.origin` in `extension/userscript.src.js` (and rebuild).

## Before every draft (automatic projections capture)

Since 0.3.0 the overlay captures Yahoo's 2026-27 projections by itself, once per draft room (URL `/draftclient/nba/<leagueId>/<team>`;
remembered in `localStorage` as `fdc:projCapture` and cross-checked with `GET /api/projections/yahoo/status`; again after 12 h):

* Players tab on **2026-27 Proj Stats** and this room not captured yet -> the same scroll-only capture as the button runs (never clicks or selects anything on Yahoo).
* Another stat view selected -> the overlay shows "Pre-draft: select '2026-27 Proj Stats' in Yahoo's Players tab to refresh projections" until captured.
* You are on the clock (header without "You're up in N Picks", or the app says `onClock`) -> deferred until after your pick.
* Afterwards: "Projections captured for this draft ✓ (733 players, 2m ago)". A failed attempt retries after 60 s.

The app's **Pre-draft** checklist (`/draft`) mirrors this and the heartbeat (`panel`, `pageVisible`).

## The overlay (~320px, dark, draggable, collapsible, max 70vh with scroll)

* **Header**: `PICK 41 · YOU'RE UP` (green, pulsing) or `Your pick in N (#44)`, plus a strategy chip (e.g. "Punt FT%").
* **Status line**: Connected / Not connected to localhost:3000, "updated Xs ago", and a **⋯** button that opens the sync
  details: draft id, last pick sent, picks parsed (and which extraction layer matched), **Send snapshot**, **Pause / Resume**.
  Sync errors (amber) stay visible, e.g. `Unmapped player "X" (pick 7) - fix in app`.
* **Recommended** (top 8 of `GET /api/draft/<id>/recommendations?limit=10`): state badge (DRAFT green, TAKE teal, WAIT grey,
  RISKY WAIT amber, AVOID red), name, team and positions, score, `Surv N%` (chance the player is still there at your next pick)
  and a risk dot. Click a row for the reason and 9-cat / fit / ADP numbers. The single DRAFT (or, when not on the clock, TAKE)
  row is pinned on top with its reason always shown.
* **Needs**: 9 mini bars (category weights); punted categories are grey and struck through.
* **My roster (n/13)**: compact list. Section titles collapse.
* **Strategy**: preset select (Balanced, Punt FT%/FG%/TO/AST/3PM/PTS) and risk select (Conservative 0.3 / Balanced 0.15 /
  Aggressive 0.05) -> `PATCH /api/draft/<id>/strategy`, then an immediate refetch.
* Refresh: right after our ingest moves `currentPick`, otherwise every 3 s (local, cheap). Out-of-order responses are dropped.
  If the app is unreachable: "Copilot app not running (pnpm dev)".

## Badges in Yahoo's Players table

For each `.ys-player[data-id]` that is not a picks-feed row and whose player is on the recommendation `board`, a small
`<span data-fdc-badge data-fdc-ignore>` is appended right after the name: `DRAFT 74` or `#3 WAIT 66` (rank shown for the top 10).
Yahoo's "K. Towns / NYK" is matched to the server's "Karl-Anthony Towns" by first initial + last name (accents, Jr/Sr/II-IV,
punctuation folded), disambiguated by NBA team (aliases GS/NO/NY/SA/PHO/UTAH/WSH/BRK/CHO folded) - see `matchBoardPlayer` in
`extension/parser.js`. A name that is still ambiguous gets no badge. Badges are updated in place (one per player),
re-applied (300 ms debounce + every 3 s) after Yahoo re-renders, and our own DOM changes never trigger re-scans. Nothing else
on the Yahoo page is touched: the script only appends its own nodes and never clicks, drafts or types.

## If picks are not detected

Yahoo's draft-room markup is not documented, so extraction is layered (`CONFIG` at the top of `extension/parser.js`):

1. likely row selectors (draft results / pick history rows) with field selectors (pick number, player link, `TEAM - POS`,
   fantasy team name);
2. a text heuristic over the pick-history area (or the whole page): `Rd 1 Pick 3`, `Pick 3`, `3.`, `1.03`, followed by a
   player name and `BOS - PG,SG`; rows containing `Draft` buttons / ADP are ignored (those are the available-players list);
3. re-scan 500 ms after the DOM changes plus every 3 s.

Open the Yahoo "Draft Results"/pick-history tab so the picks are in the DOM, click **Send snapshot**, and send us the
`data/cache/draftroom-*.html`. The board layout (team columns x round rows, no pick numbers) is **not** supported yet.

## How the app treats the data

* Server: `POST /api/draft/<id>/external-picks { source: "yahoo-dom", picks: [{ pick, playerName, nbaTeam?, positions?, teamName? }] }`,
  CORS only for `https://*.yahoo.com` (preflight incl. `Access-Control-Allow-Private-Network`). Picks are sorted, only
  picks >= the draft's current pick are written (source `yahoo-dom`), strictly in order (stops at a gap), earlier picks are only
  compared with what is recorded (differences are shown, never changed), and re-sending the same list is a no-op.
* Names are matched with the same normalization as the data importer (accents, Jr./III, nicknames like Nic/Nicolas); ties on
  same-named players are broken by NBA team (Yahoo's `GS/NO/NY/SA/PHO/UTAH` are folded), then positions. No match or an ambiguous
  match answers **409 `UNMAPPED_PLAYER`** (with `name`), ingestion stops before that pick, and the app shows a fix banner.
* The userscript resends the whole parsed list when it changes and every 15 s as a heartbeat (the top bar shows
  "Browser: live - 3s ago"; "quiet" after 30 s). UNDO in the app while syncing is overridden by the next delivery: Yahoo is the truth.
* Recommendations / strategy calls use the same transport. `GM.xmlHttpRequest` (declared with `@connect localhost`) is used so Safari's mixed-content and CORS rules do not apply;
  plain `fetch` is only a fallback (browsers that gate public-page -> localhost requests will ask for permission).

## Capture Yahoo's 2026-27 projections

1. In the Yahoo draft room open the **Players** tab and choose **2026-27 Proj Stats** in the stat-type dropdown (tick **Drafted** if you also want drafted players).
2. In the Draft Copilot overlay click **Capture projections** (the "Data" row). If another stat view is selected it answers "Select '2026-27 Proj Stats' in Yahoo's Players tab first".
3. It scrolls Yahoo's list (only its own scroll position, nothing is clicked, selected or typed), shows "Captured 312 players...", sends the rows to the app and scrolls back to the top. The app's top bar then reads "Projections: Yahoo 2026-27 (N players, ...)".

While the projection view is on screen during normal use, newly seen rows are sent automatically too. Parsing (`parsePlayersTable` in `parser.js`) maps columns by header text (Player, XRank, Rank, ADP, GP, FG%, FT%, 3PTM, PTS, REB, AST, ST, BLK, TO), treats "-" as missing and ignores the picks feed. The view is read from the stat-type `<select>` (falls back to the `values:projected_stats` header ids). Note: the numeric cells of the *projection* view have not been seen in a snapshot yet (only the header and the select), so the first real capture is the verification.

## Alerts and robustness during a live draft

* **Header fallback**: the header ("Round 13, Pick 182" = overall pick on the clock, "Last: O. Ighodaro (C . PHX)" = the previous pick) is always in the DOM, so every pick seen there is remembered and merged into each payload (the Picks feed wins on conflicts). A Yahoo side panel left on **Queue** therefore no longer stops the sync (that is how a draft was lost at pick 158); small holes are held and auto-corrected later by the existing ingest.
* **"Copilot can't see picks" alert**: a pick is on the clock and the Picks feed has been missing for > 3 s -> full-width red pulsing banner at the top of the Yahoo page ("switch Yahoo's side panel to PICKS", x = dismiss for 60 s), red overlay border, tab title prefixed with a warning sign, optional beep (the **Sound** checkbox in the dots section; WebAudio only works after you clicked the overlay once). The script reports `panel` ("picks" / "hidden" / "n/a") and `pageVisible` in every delivery, and the app shows a matching banner on /draft. Both clear as soon as the feed is back. The script never switches the panel itself.
* **Quiet warning**: the script heartbeats every 5 s; with Browser sync on and the draft active the app shows an amber (>15 s) / red (>45 s) banner "Yahoo tab not reporting - keep the Yahoo draft window visible (Safari pauses background tabs)". When the Yahoo tab becomes visible again it rescans and sends immediately.
* **Results tab**: Results > Teams (calibrated from a real snapshot of a finished draft) shows ONE team at a time (Yahoo's team dropdown) with Slot | Player | Pick (overall number). `parseResultsTeams` reads it and the picks are sent like feed picks through `external-picks`, so open Results > Teams and step through every team in Yahoo's dropdown to backfill a finished draft. Round by Round is only handled by a generic, unverified reader (`parseResultsTab`): it needs a snapshot of that view to be calibrated.

## Season mode (0.7.0): autonomous league sync, read-only

On `basketball.fantasysports.yahoo.com/nba/<league>/...` (not the draft room, top window only) the script runs a **league sync** by itself. **Reload one Yahoo league tab and leave it**: nothing else to open or press.

What it reads (plain same-origin `GET` `fetch()` with your cookies, i.e. the pages you could open yourself; never a click, a submit or a POST to Yahoo; every URL must be under `/nba/<league>/`):

1. **Discovery** from the page you are on: league id, your team id (the "My Team" nav link), and every team's id + name (the team switcher / standings / matchup links). Posted to `POST /api/season/discover`, which maps Yahoo team ids to the league's teams (my id -> your team, names -> the rest, a shared word for renamed teams, your roster overlap as the last resort).
2. **My Team** `/nba/<league>/<myTeamId>` -> `POST /api/season/roster` (`mine`), and from that page the links to Matchup and Transactions.
3. **Matchup** (the page's own "Matchups" link) -> `POST /api/season/matchup`: both teams' FGM/A, FG%, FTM/A, FT%, 3PTM, PTS, REB, AST, ST, BLK, TO, games played/remaining.
4. **Available players** `/nba/<league>/players?status=A&pos=P&sort=AR`, then the page's own "Next 25" links, **max 8 pages** -> `POST /api/season/free-agents`.
5. **Transactions** (nav link, max 3 pages) -> `POST /api/season/transactions`: adds/drops/trades, deduped by a stable key, applied to every team's roster on top of the draft baseline (a roster page read *after* a transaction wins), your adds count toward the weekly limit.
6. **Every other team's roster** `/nba/<league>/<teamId>` (13 pages) -> `POST /api/season/roster`; each replaces that team's roster (history kept in `roster_snapshots`).
7. A report of the run -> `POST /api/season/sync-report`; `GET /api/season/sync-status` returns it (per part, time, counts) for the overlay and the `/season` chips.

Politeness and safety: pages **at least 2.5 s apart** (+ up to 1.5 s jitter), whole run <= ~30 requests (hard cap 60), **stops at the first HTTP 4xx/5xx or login redirect**, **single flight** across tabs (a `localStorage` lock `fdc:season:lock`, 150 s time-to-live; the Players-page "next pages" reader uses the same lock).

Triggers: first league page load (4 s after) and returning to the tab (`visibilitychange`) when the last full sync (here or on the server) is older than **2 h** and no attempt was made in the last 30 min, plus the overlay's **Sync now** button. The overlay line reads `League synced 3m ago · roster 13 ✓ · 14/14 teams ✓ · matchup vs X ✓ · 275 FAs ✓ · moves 12 ✓`.

**Self-calibration.** When a page that should have rows parses to nothing (a roster page without players, a matchup without category totals, a players page without rows, a transactions page without moves) - fetched or live - the script POSTs that page's HTML + text to `/api/debug/draftroom-snapshot` (dev only, `NODE_ENV !== production`) by itself, as `data/cache/season-<kind>-<ts>.html` (kinds: `roster`, `matchup`, `players`, `transactions`; <= 1.5 MB; **once per kind per 6 h**, enforced both in the browser and by the route), and shows `parser needs update (saved sample): <kinds>` in the overlay and a red Parser chip on `/season`. No click needed. To replay a saved page through the same code: `pnpm season:ingest-file data/cache/season-team-*.html`.

Parsers (`parser.js`, shared by live DOM and fetched HTML via `DOMParser`) are **calibrated on real snapshots of league 100001** (fixtures in `tests/fixtures-season-real/`): player ids come from the links `https://sports.yahoo.com/nba/players/<id>` (absolute, other host), the slot from `tr[data-pos]`, `TEAM - POS` from the player cell, columns by the last header row (`% Ros` = % owned), the team name from the roster caption ("<team>'s Players roster for ..."; the `<h1>` is not the team), the matchup from the category table (header `Team FGM/A* FG% ... TO`) and the `#remaining-games` strip. Fallbacks exist for div/list based layouts and category-row matchups (tests in `tests/extension-season-layouts.test.ts`). The Transactions parser has **no real snapshot yet** (structure based: player links + Add/Drop/Trade words + team links + date text); if it cannot read your page the sample is saved automatically.

* **Free-agent pagination of the live Players page** (toggle in the overlay, default ON): unchanged, at most 10 further pages, one per 2 s, at most once per 30 min per list, same lock as the sync.
* Errors show in the overlay (amber): unknown team name ("is not one of this league's teams"), your team missing from the matchup page, unmatched player names (a roster with unmatched names never drops anybody). The app is `http://localhost:3000` as before (`APP.origin`).

## Always-on deployment (0.7.1)

`deploy/` runs this same script on a VPS inside a Chromium that stays logged in to Yahoo (see `deploy/README.md`). It injects the built `yahoo-draft-reader.user.js` into one league page and sets two page globals before the script runs:

* `window.__FDC_ORIGIN` replaces `APP.origin` (the app's internal URL; the worker also supplies a `GM.xmlHttpRequest` shim that forwards to it).
* `window.__FDC_FORCE_SYNC = true` starts the league sync once per page load even when the 2 h / 30 min gate would skip it.

Without those globals nothing changes: Safari keeps using `http://localhost:3000` and the normal gate.
