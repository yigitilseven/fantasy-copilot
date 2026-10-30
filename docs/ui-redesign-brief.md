# Fantasy Copilot: UI Redesign Brief (for Figma AI)

## 1. What the product is

A personal assistant for **one Yahoo Fantasy Basketball team** ("Copilot Grizzlies") in a 14-team, head-to-head, 9-category league.
It syncs the league from Yahoo every ~2 hours, runs a statistics engine and tells the manager **what to do**: which free agents to add, whom to drop, who to start today, and how to win this week's matchup.

- **Goal of the manager:** win 5–6 of the 9 categories every week.
- **Categories:** FG%, FT%, 3PM, PTS, REB, AST, STL, BLK, TO (turnovers: lower is better).
- **One user.** No sign-up, no social features, no multi-team switching.
- **Main use:** on an **iPhone, installed as a Home-Screen web app (PWA)** with push notifications. Desktop is secondary (wider layout of the same screens).
- **Tone:** a sharp sports analyst, not a stats spreadsheet. The answer comes first, the numbers prove it.

## 2. Design principles

1. **Decision first.** Every screen opens with "what should I do" (one clear action), then the supporting numbers.
2. **Two horizons on every move:** *this week* vs *rest of season*. They often disagree; the design must show both side by side (e.g. `+9.2 wk` green, `−4.8 season` red).
3. **Win probability is the core metric.** Changes are shown in percentage points (pp): `+5.2pp`.
4. **Categories are the language.** Use a consistent 9-category strip everywhere (same order, same colors for win / toss-up / lose).
5. **Freshness is visible but quiet.** A small "synced 12 min ago" indicator; turns amber/red only when data is old or a sync failed.
6. **Glanceable on a phone.** Big numbers, short labels, thumb-reachable bottom navigation, no horizontal scrolling of the page (wide tables scroll inside their card).
7. **Dark mode first** (used at night during games), light mode supported.

## 3. Design system

- **Theme:** dark, near-black background, slightly lighter cards, 1px subtle borders. Light theme as a variant.
- **Accent:** one brand color (suggestion: electric blue or court orange) for primary actions and the user's own team.
- **Semantic colors:**
  - Win / positive / strength: green
  - Toss-up / swing / warning: amber
  - Lose / negative / weakness / injury: red
  - Neutral / no game today: gray
- **Typography:** clean sans-serif, **tabular numbers** for all stats. Large display style for the headline probability (e.g. `47%`).
- **Components to design:**
  - Category chip (`REB 44%` with a colored mini bar)
  - 9-category strip (row of chips)
  - Player row (photo/initials, name, NBA team, positions, status badge, "game today" dot)
  - Move card (see 5.3)
  - Probability gauge / big number
  - Delta pill (`+5.2pp`, colored)
  - Status badge (Healthy, GTD, Out, IL, back date)
  - Freshness chip (Roster, FA pool, Matchup, News, Sync: each ok / stale / failed)
  - Bottom tab bar, top app bar, segmented control, empty state, loading skeleton, error banner
- **Injury status vocabulary:** `GTD` (game-time decision), `Out`, `IL`, `Out (Shoulder) · back 2027-03-02`.

## 4. Navigation (mobile)

Bottom tab bar with 4 tabs:

| Tab | Purpose |
|---|---|
| **Today** | Morning brief + today's lineup + top move (home screen) |
| **Moves** | All add/drop suggestions and the free-agent pool |
| **Matchup** | This week's head-to-head, category by category |
| **League** | How the team compares with the other 13 teams |

Top app bar: team name, day selector (date), freshness indicator (tap for details), settings icon.
The **Draft** room and **History** are secondary screens reached from Settings (used once a year).

## 5. Screens

### 5.1 Today (home)

**Purpose:** in 5 seconds the manager knows the single most important action today.

Sections, top to bottom:

1. **Hero card**
   - This week's win probability, big: `47% to win this matchup` vs `Rival Team`
   - Line under it: `Week 2 · Oct 26 – Nov 1 · 6 days left · Adds 1/4 used (3 left)`
   - Primary action: the top move in one line: `Add Jeremiah Fears, drop Daniss Jenkins · +5.2pp`
2. **Daily brief** (written by Claude AI every morning, ~1,500 characters, plain text in blocks)
   - Blocks: **MOVES**, **PLAN**, **LINEUP**, **RISKS** (on Mondays a longer **Weekly plan**: STANDING, CATEGORIES, THIS WEEK, MOVES, ROSTER, WATCH)
   - Collapsed by default to the first 3 lines, "Read full brief" expands
   - Badge: `Claude analysis` or `Engine only` (fallback when AI is unavailable)
   - Timestamp: `Today 08:30`
3. **Lineup changes to make on Yahoo** (actionable list)
   - Rows like `SIT Jamal Murray · No game today`, `START Donovan Clingan at C · helps REB, BLK`, `Move Cason Wallace to IL · frees a roster spot`
   - Each row has a checkbox "done"
4. **Today's lineup** (the roster in slots)
   - 10 active slots: PG, SG, G, SF, PF, F, C, C, UTIL, UTIL + bench + 2 IL slots
   - Each slot: position label, player row, short reason (`best available for the slot`, `helps REB, BLK`) or `empty: nobody eligible has a game`
   - Header: `2 of your players play today · 2/10 slots`
5. **Alerts** (only when present): injured player on roster, a teammate's injury giving a free agent more minutes
   - Example: `Kris Dunn (LAC PG/SG): minutes up, Bradley Beal out (Knee), back 2026-11-08 (≈ +10% production while it lasts)`
6. **News for my players** (collapsible): per player, 1–3 headlines with source and date, injury badge
   - Example: `Cason Wallace · OKC · Out Shoulder · back 2027-03-02: "Cason Wallace to have surgery, could miss rest of season" (Yahoo Sports, Oct 27)`

### 5.2 Notifications onboarding (inside Today, first visit only)

- Card: "Get your morning brief and move alerts" + button **Enable notifications**
- States: not supported (must be added to Home Screen first, show 3-step iOS instructions: Share → Add to Home Screen → open from icon), enabled (small "Notifications on · Send test" link), denied (how to re-enable in iOS Settings)

### 5.3 Moves

**Purpose:** decide which free agent to pick up and whom to drop.

Header: `199 free agents from Yahoo · 405 combos checked · 3 of 4 adds left this week`

**Move card** (the key component; list sorted by value):
- Type tag: `Season add` (green) / `Stream this week (3 games)` (blue) / `Injury replacement (PG)` (amber)
- Main line: **Add** `Jeremiah Fears` (NOP · PG · 29% owned) → **Drop** `Daniss Jenkins` (or `Open spot` / `Move Cason Wallace to IL`)
- Two deltas side by side: `This week +5.2pp` · `Season +3.9pp` (each colored by sign)
- Category effect chips: gains `PTS +7.2 · STL +7.0 · REB +6.3` (green), costs `TO −4.8 · FT% −1.4` (red)
- News lines when relevant (blue, small): `minutes up: Shaedon Sharpe out (Knee), back 2027-03-02` · `Henderson questionable Tuesday (ankle)`
- Blocker when it cannot be done now: `Add limit reached this week`
- Actions: **I did this** (records the add), expand for details

Below the list:
- **Drop candidates:** the roster sorted by "cheapest to cut" with the win-probability cost (`Daniss Jenkins −0.3pp`) and a note
- **Hold:** players never to drop, with the reason
- **Free-agent pool** (search + filter by position, sort by value / games this week / % owned)

Example data (real, current):

| Type | Add | Drop | Week | Season |
|---|---|---|---|---|
| Season add | Jeremiah Fears (NOP PG) | Daniss Jenkins | +5.2 | +3.9 |
| Season add | Scoot Henderson (POR PG) | Daniss Jenkins | +3.3 | +4.3 |
| Stream (3 games) | De'Andre Hunter (SAC SF/PF) | Royce O'Neale | +9.2 | −4.8 |

### 5.4 Matchup (this week)

**Purpose:** see which categories are won, lost or still in play.

- Header: `You vs Rival Team · 47%` with a horizontal bar, `Player-games left: you 27.7 vs 27.1 · 6 days left`
- **Category table**, one row per category:
  - Category · You (now → projected end of week) · Opponent (now → projected) · P(win) bar · tag
  - Example rows: `FG% .392 → .466 | .510 → .490 | 27%`, `REB 31 → 200 | 48 → 206 | 44% swing`, `TO 13 → 58.5 | 24 → 76.8 | 97% won`
  - Tags: `won` (green, ≥ 85%), `swing` (amber, 35–65%), `lost` (red, ≤ 15%)
- **Plan box:** "Chase: REB, AST, BLK · Protect: TO, STL · Concede: PTS, FG%"
- Adds used this week (editable number, 0–4)

### 5.5 League

**Purpose:** strengths and weaknesses versus the other 13 teams.

1. **Summary bullets** (3–6 sentences from the engine)
2. **Your categories:** per category: value, rank `#3 of 14`, best, median, avg P(win), label (`strength` / `weakness` / `swing` / `punt`). A radar or bar chart of ranks works well here
3. **Power ranking:** all 14 teams, power = average win% vs everyone, rank, weekly games; user's team highlighted
4. **League table:** teams × 9 categories, top-3 cells green, bottom-3 red (scrolls horizontally inside the card on mobile)
5. **Head to head:** each opponent: win %, expected categories, "they lead in", "toss-ups"; sorted hardest first
6. **Depth & injuries:** per position: eligible players, slots, league median, games next week, `thin` warning; IL usage `1/2`
7. **League activity:** recent adds/drops of other teams (from Yahoo transactions)

### 5.6 Settings

- Data status (expanded freshness): Roster synced · FA pool count & age · Matchup · Teams synced 14/14 · News · Schedule · last sync result, next sync time
- **Remote Yahoo browser:** status (`Logged in` / `Needs login`) + button "Open remote browser" (used only when Yahoo asks to log in again)
- Notifications: on/off, send test
- Morning brief time (default 08:30), weekly plan day (default Monday)
- League settings: adds per week, IL slots, roster slots
- Links: Draft room, Draft history

### 5.7 Draft room (secondary, desktop-first, used on draft day)

Live helper during the Yahoo snake draft (user picks #13 of 14):
- Top bar: round/pick, "your pick in N picks", status of the live Yahoo sync
- **Recommendation bar:** best pick now with state `DRAFT` / `TAKE` / `WAIT` / `RISKY WAIT` / `AVOID` and survival chance to the next pick
- Player table (sortable): rank, name, team, positions, ADP, value, risk, category contributions, survival %
- My roster by position, category profile of the team so far, recent picks feed, head-to-head outlook vs other teams
- Pre-draft checklist (projections captured, news refreshed)

### 5.8 Draft history (secondary)

List of past (mock) drafts with: date, slot, final team strength, reaches and steals by opponents, calibration of the opponent model.

## 6. States to design for every screen

- **Loading:** skeletons ("Computing lineup and moves…")
- **Empty:** no moves clear the bar → "Hold: no move beats your current roster"; no games today → "None of your players play today"
- **Stale data:** amber banner "Roster last synced 26 h ago"
- **Sync problem:** red banner "Yahoo needs you to log in again · Open remote browser"
- **Error:** inline red banner with a Retry button
- **Pre-season:** info banner "Season has not started (first game Oct 20)"

## 7. Push notifications (iOS)

Design the notification text styles (title + 1–2 lines) and the in-app screen they open:

| Notification | Example | Opens |
|---|---|---|
| Daily brief (Tue–Sun 08:30) | `47% this week · Start: Clingan · Move: add Jeremiah Fears` | Today → brief |
| Weekly plan (Monday 08:30) | `Weekly plan: chase REB/AST, protect TO · 2 season adds suggested` | Today → brief |
| Yahoo login needed | `Yahoo needs you to log in again` | Remote browser |
| Claude token expiry | `Claude token expires 2027-10-27` | Settings |

App icon + splash for the Home-Screen app (name: **Fantasy Copilot**; short name **Copilot**).

## 8. Real sample data to use in the mockups

- Team: **Copilot Grizzlies** · League: **Sample League** (14 teams) · Week 2 opponent: **Rival Team**
- Roster: Jamal Murray, Scottie Barnes, Trey Murphy III, Naz Reid, Dyson Daniels, Jaime Jaquez Jr., Saddiq Bey, Donovan Clingan, Ayo Dosunmu, Grayson Allen, Isaiah Stewart, Royce O'Neale, Daniss Jenkins, Cason Wallace (IL, Out Shoulder, back 2027-03-02)
- Matchup win probability 47%, adds 1/4 used, player-games left 27.7 vs 27.1
- Top moves: see the table in 5.3

## 9. Out of scope

- Login / accounts / multiple users or teams
- Making moves on Yahoo from the app (the app only advises; the manager acts in the Yahoo app)
- Trades, chat, social features
- Marketing pages

## 10. Deliverables wanted from Figma

1. Design system page (colors light/dark, type scale, components from section 3)
2. Mobile screens (iPhone 15/16 size, 393 × 852): Today, Moves, Matchup, League, Settings, notification onboarding, empty / stale / error states
3. Desktop versions (1440 wide) of Today (three columns: Lineup · Matchup · Moves) and League
4. Draft room (desktop 1440)
5. App icon and push notification examples
