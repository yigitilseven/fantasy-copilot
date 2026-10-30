// Pure parsing helpers for the Yahoo draft room reader. ES module, no dependencies, no network, read-only.
// `pnpm ext:build` strips the `export` keywords and inlines this file into yahoo-draft-reader.user.js.
//
// We do NOT know Yahoo's draft-room DOM for certain, so extraction is layered:
//   1. CONFIG.rowSelectors: likely "pick row" selectors; per-row field selectors with a text fallback inside the row.
//   2. A text heuristic over the pick-history region (or the whole page) that looks for pick markers
//      ("Rd 1 Pick 3", "3.", "1.03") followed by a player name and "TEAM - POS".
// parseDraftRoom() runs both and keeps whichever finds more picks. Calibrate with the overlay's "Send snapshot" button.

/** Everything you may need to tweak for Yahoo's markup lives here. */
export const CONFIG = {
  /** Number of teams in the draft; needed to turn "Rd 2 Pick 3" into an overall pick. The userscript fills it from the app. */
  teams: /** @type {number | null} */ (null),
  /** Layer 1: elements that each represent ONE pick. Tried all; the selector that yields the most picks wins. */
  rowSelectors: [
    "#drafttables tr",
    "table[class*='draft' i] tr",
    "[data-tst*='pick' i]",
    "[data-testid*='pick' i]",
    "[class*='DraftPick' i]",
    "[class*='draftPick' i]",
    "[class*='PickHistory' i] li",
    "[class*='pick-history' i] li",
    "[class*='DraftResult' i] li",
    "[class*='draft-result' i] li",
    "[class*='DraftResult' i] tr",
    "[class*='draftresult' i] tr",
    "[class*='RecentPicks' i] li",
    "li[class*='pick' i]",
    "tr[class*='pick' i]",
  ],
  /** Layer 1 field selectors, relative to a row. Missing fields fall back to the text heuristic on the row. */
  fields: {
    pickNumber: ["[class*='pickNumber' i]", "[class*='pick-number' i]", "[class*='pickNo' i]", "[data-tst*='pick-number' i]", "[class*='PickNum' i]"],
    playerName: [
      "a[href*='/nba/players/']",
      "a[href*='/players/']",
      "[class*='playerName' i]",
      "[class*='player-name' i]",
      "[data-tst*='player-name' i]",
      "a.name",
      ".name",
    ],
    teamPos: ["[class*='teamPos' i]", "[class*='team-pos' i]", "[class*='ysf-player-detail' i]", "[class*='playerInfo' i]", "[class*='player-info' i]", "[class*='position' i]"],
    teamName: ["[class*='fantasyTeam' i]", "[class*='fantasy-team' i]", "[class*='teamName' i]", "[class*='team-name' i]", "[class*='ownerName' i]", "[class*='manager' i]"],
  },
  /** Attributes on a row that may carry the overall pick number. */
  pickAttrs: ["data-pick", "data-pick-number", "data-pickno", "data-pick-num", "data-overall"],
  /** Layer 2: containers holding the pick history (searched first); else heading text below; else the whole page. */
  regionSelectors: [
    "#drafttables",
    "[class*='PickHistory' i]",
    "[class*='pick-history' i]",
    "[class*='DraftResults' i]",
    "[class*='draft-results' i]",
    "[class*='RecentPicks' i]",
    "[aria-label*='draft results' i]",
    "[aria-label*='pick history' i]",
  ],
  regionHeadingPattern: /^(draft results|pick history|recent picks|draft history|picks|results)$/i,
  /** Blocks containing a button-ish word are available-player rows, not picks. */
  blockRejectPattern: /(^|\|)\s*(draft|queue|add|watch|auto)\s*(\||$)|\b(adp|proj(?:ected)?|rank|queue|watchlist)\b/i,
  /** Longest run of lines belonging to one pick in the text heuristic. */
  maxBlockLines: 8,
  maxPick: 600,
};

const NBA_CODES =
  "ATL|BKN|BOS|BRK|CHA|CHO|CHI|CLE|DAL|DEN|DET|GSW|GS|HOU|IND|LAC|LAL|MEM|MIA|MIL|MIN|NOP|NOR|NO|NYK|NY|OKC|ORL|PHI|PHX|PHO|POR|SAC|SAS|SA|TOR|UTAH|UTA|UTH|WAS|WSH";
const POS = "PG|SG|SF|PF|C|G|F|UTIL";
const TEAMPOS_RE = new RegExp(`(?:^|[^A-Za-z])(${NBA_CODES})\\s*[-\\u2013\\u2014\\u00b7]\\s*((?:${POS})(?:\\s*[,/]\\s*(?:${POS}))*)(?![A-Za-z])`);
const TEAM_ONLY_RE = new RegExp(`\\((${NBA_CODES})\\)`);
const NAME_RE = /^\p{Lu}[\p{L}.'’-]*(?:\s+[\p{L}.'’-]+){1,3}$/u;
const NAME_STOP = /^(drafted by|round|rd|pick|team|player|auto|queue|draft|results|available)\b/i;
const TEAMNAME_STOP = /^(round|rd|pick|draft|results|available|auto|inj)\b/i;
const TAGS = new Set(["INJ", "O", "Q", "DTD", "GTD", "NA", "IL", "IL+", "SUSP", "P", "D", "OUT"]);

// ----------------------------------------------------------------------------- DOM -> lines

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "TEMPLATE", "IFRAME", "INPUT", "SELECT", "TEXTAREA", "HEAD"]);
const BREAK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGURE", "FOOTER", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY",
  "THEAD", "TR", "TD", "TH", "UL", "BUTTON",
]);

function isHidden(el) {
  if (el.hasAttribute("hidden") || el.hasAttribute("data-fdc-ignore")) return true;
  const st = el.getAttribute("style");
  return !!st && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(st);
}

/** Visible text of an element as an array of lines (block elements and table cells start a new line). */
export function textLines(root) {
  const out = [];
  let cur = "";
  const flush = () => {
    const t = cur.replace(/\s+/g, " ").trim();
    if (t) out.push(t);
    cur = "";
  };
  const walk = (node) => {
    if (node.nodeType === 3) {
      cur += node.nodeValue;
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toUpperCase();
    if (SKIP.has(tag) || isHidden(node)) return;
    const brk = BREAK.has(tag);
    if (brk) flush();
    else cur += " ";
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
    if (brk) flush();
    else cur += " ";
  };
  walk(root);
  flush();
  return out;
}

// ----------------------------------------------------------------------------- text -> pick

/** "BOS - PG,SG" -> { nbaTeam: "BOS", positions: "PG,SG", index, length } | null */
export function parseTeamPos(s) {
  const m = TEAMPOS_RE.exec(s);
  if (!m) return null;
  const start = m.index + m[0].indexOf(m[1]);
  return {
    nbaTeam: m[1].toUpperCase(),
    positions: m[2].toUpperCase().split(/\s*[,/]\s*/).join(","),
    index: start,
    length: m[0].length - (start - m.index),
  };
}

const MARKERS = [
  // "Rd 1, Pk 3" / "Round 1 Pick 3" -> round + pick in round
  { re: /\b(?:Rd|Rnd|Round)\.?\s*(\d{1,2})\s*[,.:\-·|]?\s*(?:Pk|Pick|#)\s*\.?\s*(\d{1,2})\b/i, kind: "round", explicit: true },
  // "Pick 3" / "Pick #3" -> overall
  { re: /\bPick\s*#?\s*(\d{1,3})\b/i, kind: "overall", explicit: true },
  // "1.03" at line start -> round.pick-in-round
  { re: /^\W{0,3}(\d{1,2})\.(\d{2})(?=\s|\||$)/, kind: "round", explicit: false },
  // "3." / "3)" / "#3" / "3" at line start -> overall
  { re: /^\W{0,3}#?(\d{1,3})\s*[.)\]:]?(?=\s|\||$)/, kind: "overall", explicit: false },
];

/** Finds the pick marker in a line/block. Returns { kind, a, b?, explicit, index, length } | null. */
export function findMarker(s) {
  for (const m of MARKERS) {
    const r = m.re.exec(s);
    if (r) return { kind: m.kind, a: Number(r[1]), b: m.kind === "round" ? Number(r[2]) : undefined, explicit: m.explicit, index: r.index, length: r[0].length };
  }
  return null;
}

function cleanName(raw) {
  let s = raw.replace(/^[\s|(,.\-–—·:]+|[\s|(,\-–—·:]+$/g, "").trim();
  const toks = s.split(/\s+/);
  while (toks.length > 2 && TAGS.has(toks[toks.length - 1])) toks.pop();
  s = toks.join(" ");
  return s;
}

function looksLikeName(s) {
  return s.length >= 4 && s.length <= 40 && !/\d/.test(s) && !NAME_STOP.test(s) && NAME_RE.test(s);
}

/**
 * Parses one pick from the text of a row/block (lines joined with " | ").
 * Returns { pick, playerName, nbaTeam?, positions?, teamName?, explicit, hasTeamPos } or { error } when it is not a pick.
 * `teams` is only needed for round-relative markers.
 */
export function parsePickBlock(lines, teams) {
  const joined = (Array.isArray(lines) ? lines : [lines]).join(" | ");
  const marker = findMarker(joined);
  if (!marker) return { error: "no-marker" };
  let pick;
  if (marker.kind === "overall") pick = marker.a;
  else if (teams) pick = (marker.a - 1) * teams + marker.b;
  else return { error: "needs-teams", round: marker.a, inRound: marker.b };
  if (!(pick >= 1)) return { error: "bad-pick" };

  const rest = (joined.slice(0, marker.index) + " | " + joined.slice(marker.index + marker.length)).replace(/^\s*\|\s*/, "");
  const tp = parseTeamPos(rest);
  let before = rest;
  let after = "";
  if (tp) {
    before = rest.slice(0, tp.index);
    after = rest.slice(tp.index + tp.length);
  }
  // Name: the last segment before TEAM-POS that looks like a name; without TEAM-POS the first such segment.
  const segs = before.split(/\s*\|\s*|\s{2,}/).map(cleanName).filter(Boolean);
  // "Name (BOS - PG)" leaves a trailing "(": handled by cleanName.
  const candidates = segs.filter(looksLikeName);
  let name = candidates.length ? (tp ? candidates[candidates.length - 1] : candidates[0]) : null;
  if (!name && before.indexOf(" | ") < 0) {
    const one = cleanName(before);
    if (looksLikeName(one)) name = one;
  }
  if (!name) return { error: "no-name" };

  let teamPart = after;
  if (!tp) teamPart = segs.filter((s) => s !== name).join(" | ");
  const teamName = teamPart
    .split(/\s*\|\s*/)
    .map((s) => s.replace(/^[\s)(,.\-\u2013\u2014\u00b7:]+|[\s)(,.\-\u2013\u2014\u00b7:]+$/g, "").replace(/^(drafted\s+)?by\s+/i, "").trim())
    .find((s) => s && !/^\d+$/.test(s) && !TEAMNAME_STOP.test(s) && s.length <= 60 && s !== name);
  let nbaTeam = tp ? tp.nbaTeam : undefined;
  if (!nbaTeam) {
    const t = TEAM_ONLY_RE.exec(joined);
    if (t) nbaTeam = t[1].toUpperCase();
  }
  const out = { pick, playerName: name, explicit: marker.explicit, hasTeamPos: !!tp };
  if (nbaTeam) out.nbaTeam = nbaTeam;
  if (tp) out.positions = tp.positions;
  if (teamName) out.teamName = teamName;
  return out;
}

function toPick(p) {
  const o = { pick: p.pick, playerName: p.playerName };
  if (p.yahooId) o.yahooId = p.yahooId;
  if (p.nbaTeam) o.nbaTeam = p.nbaTeam;
  if (p.positions) o.positions = p.positions;
  if (p.teamName) o.teamName = p.teamName;
  if (p.via === "header") o.via = "header";
  return o;
}

// ----------------------------------------------------------------------------- layer 1

function firstText(row, selectors) {
  for (const sel of selectors) {
    let el = null;
    try {
      el = row.querySelector(sel);
    } catch {
      continue;
    }
    if (el) {
      const t = textLines(el).join(" ").trim();
      if (t) return t;
    }
  }
  return "";
}

function parseRow(row, cfg) {
  const lines = textLines(row);
  if (!lines.length) return null;
  // Field-based extraction first.
  const nameRaw = cleanName(firstText(row, cfg.fields.playerName));
  const name = looksLikeName(nameRaw) ? nameRaw : null;
  const tpText = firstText(row, cfg.fields.teamPos);
  const tp = parseTeamPos(tpText) || parseTeamPos(lines.join(" | "));
  let pick = null;
  const pn = firstText(row, cfg.fields.pickNumber);
  if (pn) {
    const m = findMarker(pn) || /^\W{0,3}(\d{1,3})\b/.exec(pn) && { kind: "overall", a: Number(/(\d{1,3})/.exec(pn)[1]) };
    if (m) pick = m.kind === "overall" ? m.a : cfg.teams ? (m.a - 1) * cfg.teams + m.b : null;
  }
  if (pick === null) {
    for (const a of cfg.pickAttrs) {
      const v = row.getAttribute && row.getAttribute(a);
      if (v && /^\d{1,3}$/.test(v)) {
        pick = Number(v);
        break;
      }
    }
  }
  const joined = lines.join(" | ");
  if (cfg.blockRejectPattern.test(joined)) return null;
  const text = parsePickBlock(lines, cfg.teams);
  if (text.error === "needs-teams") return { needsTeams: true };
  if (name && pick !== null) {
    const out = { pick, playerName: name };
    if (tp) {
      out.nbaTeam = tp.nbaTeam;
      out.positions = tp.positions;
    }
    const tn = firstText(row, cfg.fields.teamName);
    if (tn) out.teamName = tn.slice(0, 60);
    else if (!text.error && text.teamName) out.teamName = text.teamName;
    return out;
  }
  if (!text.error) {
    const out = toPick(text);
    // Prefer the dedicated name element when the text heuristic grabbed something else.
    if (name && name !== out.playerName && lines.join(" ").includes(name)) out.playerName = name;
    if (pick !== null) out.pick = pick;
    return out;
  }
  return null;
}

export function parseWithSelectors(root, cfg = CONFIG) {
  let best = { picks: [], selector: null, needsTeams: false };
  for (const sel of cfg.rowSelectors) {
    let rows;
    try {
      rows = root.querySelectorAll(sel);
    } catch {
      continue;
    }
    if (!rows.length) continue;
    const picks = [];
    let needsTeams = false;
    for (const row of rows) {
      const p = parseRow(row, cfg);
      if (p && p.needsTeams) needsTeams = true;
      else if (p) picks.push(p);
    }
    if (picks.length > best.picks.length || (!best.picks.length && needsTeams)) best = { picks, selector: sel, needsTeams };
  }
  return best;
}

// ----------------------------------------------------------------------------- layer 2

/** Splits lines into per-pick blocks at pick markers. */
export function splitBlocks(lines, cfg = CONFIG) {
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = findMarker(line);
    // A marker only starts a block when it is at the start of the line (bare/dotted numbers) or explicit.
    const starts = m && (m.explicit || m.index === 0 || m.index <= 3);
    if (starts) {
      cur = [line];
      blocks.push(cur);
    } else if (cur && cur.length < cfg.maxBlockLines) cur.push(line);
  }
  return blocks;
}

/** Text heuristic over already-extracted lines. */
export function parsePicksFromLines(lines, cfg = CONFIG) {
  const picks = [];
  let needsTeams = false;
  for (const block of splitBlocks(lines, cfg)) {
    if (cfg.blockRejectPattern.test(block.join(" | "))) continue;
    const p = parsePickBlock(block, cfg.teams);
    if (p.error === "needs-teams") needsTeams = true;
    if (p.error) continue;
    // A bare number needs corroboration (TEAM - POS) to avoid mistaking list ranks and counters for picks.
    if (!p.explicit && !p.hasTeamPos) continue;
    picks.push(p);
  }
  return { picks, needsTeams };
}

/** Plain-text entry point (tests, and a page's innerText). */
export function parsePicksFromText(text, cfg = CONFIG) {
  return parsePicksFromLines(String(text).split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean), cfg);
}

function findRegions(root, cfg) {
  const regions = [];
  for (const sel of cfg.regionSelectors) {
    try {
      regions.push(...root.querySelectorAll(sel));
    } catch {
      /* invalid selector in this browser */
    }
  }
  if (regions.length) return { regions, via: "selector" };
  // Heading text ("Draft Results") -> climb to the nearest ancestor that actually contains TEAM - POS strings.
  const heads = [];
  for (const el of root.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='tab'],[role='heading'],button,a,span,div,li")) {
    if (el.children.length > 1) continue;
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length <= 24 && cfg.regionHeadingPattern.test(t)) heads.push(el);
  }
  for (const h of heads) {
    let el = h.parentElement;
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      if (/^(BODY|HTML)$/i.test(el.tagName)) break;
      if (textLines(el).join(" | ").match(new RegExp(TEAMPOS_RE.source, "g"))?.length >= 2) {
        if (!regions.includes(el)) regions.push(el);
        break;
      }
    }
  }
  return regions.length ? { regions, via: "heading" } : { regions: [], via: "none" };
}

export function parseWithText(root, cfg = CONFIG) {
  const { regions, via } = findRegions(root, cfg);
  let best = { picks: [], via, needsTeams: false };
  for (const r of regions) {
    const res = parsePicksFromLines(textLines(r), cfg);
    if (res.picks.length > best.picks.length) best = { ...res, via };
    else if (!best.picks.length && res.needsTeams) best.needsTeams = true;
  }
  if (!best.picks.length) {
    const body = root.body || root.querySelector?.("body") || root;
    const res = parsePicksFromLines(textLines(body), cfg);
    best = { ...res, via: "body" };
  }
  return best;
}

// ----------------------------------------------------------------------------- layer 0: Yahoo draft client (calibrated)

const POS_LIST_RE = /^(PG|SG|SF|PF|C)(\s*,\s*(PG|SG|SF|PF|C))*$/;
const NBA_CODE_RE = new RegExp(`^(${NBA_CODES})$`);

/**
 * Yahoo's 2026 draft client (calibrated from a real snapshot). The "Picks" feed renders each pick as
 *   <div><span>13</span><div><span>FantasyTeam</span><div class="ys-player" data-id="..."> name, <li>POS</li><li>TEAM</li></div></div></div>
 * Join/leave messages in the same feed have no .ys-player, and the Players table has no bare pick-number sibling.
 */
/** Pick number of a `.ys-player` inside the picks feed: a bare 1-3 digit sibling at the start of an ancestor row. null = not a feed row. */
function feedPickNumber(pl) {
  let row = pl.parentElement;
  for (let i = 0; row && i < 4; i++, row = row.parentElement) {
    const first = row.firstElementChild;
    if (!first || first.contains(pl)) continue;
    const t = (first.textContent || "").trim();
    if (/^\d{1,3}$/.test(t)) return Number(t);
  }
  return null;
}

/** Name / NBA team / positions of one `.ys-player` element (feed or players table). Our own injected nodes are ignored. */
export function readYahooPlayer(pl) {
  const img = pl.querySelector("img[title]");
  let playerName = img ? img.getAttribute("title").trim() : "";
  let nameEl = null;
  for (const s of pl.querySelectorAll("span")) {
    if (s.closest("[data-fdc-ignore]")) continue;
    const t = (s.textContent || "").trim();
    if (t && !TAGS.has(t) && /\p{L}{2}/u.test(t) && !(s.closest("li") || s.closest("abbr"))) {
      nameEl = s;
      if (!playerName) playerName = t;
      break;
    }
  }
  let positions;
  let nbaTeam;
  for (const li of pl.querySelectorAll("li")) {
    const t = (li.textContent || "").replace(/\s+/g, "").trim().toUpperCase();
    if (!positions && POS_LIST_RE.test(t)) positions = t.split(",").join("/");
    else if (!nbaTeam && NBA_CODE_RE.test(t)) nbaTeam = t;
  }
  return { playerName, nameEl, nbaTeam, positions };
}

export function parseYahooFeed(root) {
  const picks = [];
  for (const pl of root.querySelectorAll(".ys-player[data-id]")) {
    const num = feedPickNumber(pl);
    if (num === null) continue;

    let teamName;
    for (const sib of pl.parentElement.children) {
      if (sib === pl) break;
      const t = (sib.textContent || "").replace(/\s+/g, " ").trim();
      if (t) teamName = t;
    }

    const { playerName, nbaTeam, positions } = readYahooPlayer(pl);
    if (!playerName) continue;
    const p = { pick: num, playerName };
    const yid = pl.getAttribute("data-id");
    if (yid) p.yahooId = yid;
    if (nbaTeam) p.nbaTeam = nbaTeam;
    if (positions) p.positions = positions;
    if (teamName) p.teamName = teamName.slice(0, 60);
    picks.push(p);
  }
  return picks;
}

// ----------------------------------------------------------------------------- Players tab: projections table (calibrated)

/**
 * Yahoo's Players tab (calibrated from real snapshots): a stat-type <select id="stat-mode-filter"> (options
 * "2026-27 Proj Stats" = value "projected", "2025-26 Average Stats" = "average", "2025-26 Total Stats" = "season",
 * "2025-26 Advanced Stats" = "advancedstats") above a <table> with headers Player | XRank | Rank | ADP | GP | FG% | FT% |
 * 3PTM | PTS | REB | AST | ST | BLK | TO. In the projected view the header cells carry data-id="values:projected_stats:N".
 * Totals for the Proj/Total views, per-game for Average. Only ~100 rows are rendered at a time (scroll to load more).
 */
const COLUMN_KEYS = {
  player: "player", xrank: "xrank", rank: "rank", adp: "adp", gp: "gp", "fg%": "fgPct", "ft%": "ftPct",
  "3ptm": "threePm", "3pm": "threePm", pts: "pts", reb: "reb", ast: "ast", st: "stl", stl: "stl", blk: "blk", to: "tov", tov: "tov",
};

function classifyStatView(text, value) {
  const t = String(text || "").toLowerCase();
  const v = String(value || "").toLowerCase();
  const yr = /(\d{4})\s*-\s*(\d{2})/.exec(t);
  const season = yr ? yr[1] + "-" + yr[2] : null;
  if (/proj/.test(t) || (!t && v === "projected")) return season && season !== "2026-27" ? "unknown" : "proj-2026-27";
  if (/advanced/.test(t) || (!t && v === "advancedstats")) return "advanced";
  if (/average/.test(t) || (!t && v === "average")) return season && season !== "2025-26" ? "unknown" : "avg-2025-26";
  if (/total/.test(t) || (!t && v === "season")) return season && season !== "2025-26" ? "unknown" : "total-2025-26";
  return "unknown";
}

/** Which stat view the Players tab shows: from the selected <option> of the stat-type select, else from the header ids. */
export function detectStatView(root) {
  let sel = root.querySelector("select#stat-mode-filter, select[name='stat-mode-filter']");
  if (!sel) {
    for (const s of root.querySelectorAll("select")) {
      if (/proj stats|average stats|total stats/i.test(s.textContent || "")) {
        sel = s;
        break;
      }
    }
  }
  if (sel) {
    const opt = (sel.selectedOptions && sel.selectedOptions[0]) || (sel.options && sel.options[sel.selectedIndex]) || null;
    if (opt) return classifyStatView(opt.textContent, opt.value);
  }
  if (root.querySelector("th[data-id*='projected_stats']")) return "proj-2026-27";
  return "unknown";
}

/** "1,125" -> 1125, ".714" -> 0.714, "-" / "" / "N/A" -> undefined. */
export function parseStatNumber(raw) {
  const s = String(raw == null ? "" : raw).replace(/[,\s ]/g, "");
  if (!s || /^[-–—]+$/.test(s) || /^n\/?a$/i.test(s)) return undefined;
  const n = Number(s.replace(/%$/, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** The Players table: the <table> whose header has a "Player" column plus GP/PTS; the one with most player rows wins. */
export function findPlayersTable(root) {
  let best = null;
  let bestRows = -1;
  for (const table of root.querySelectorAll("table")) {
    if (table.closest("[data-fdc-ignore]")) continue;
    const heads = [...table.querySelectorAll("thead th, tr:first-child th")].map((th) => (th.textContent || "").trim().toLowerCase());
    if (!heads.includes("player") || !(heads.includes("gp") || heads.includes("pts"))) continue;
    const n = table.querySelectorAll(".ys-player[data-id]").length;
    if (n > bestRows) {
      best = table;
      bestRows = n;
    }
  }
  return best;
}

function injuryTagOf(pl) {
  for (const el of pl.querySelectorAll("div,span,abbr")) {
    if (el.children.length || el.closest("li") || el.closest("[data-fdc-ignore]")) continue;
    const t = (el.textContent || "").trim();
    if (t && TAGS.has(t)) return t;
  }
  return undefined;
}

/**
 * Parses the Players-tab table: { statView, columns, rows }. Columns are mapped by header text (not position); "-" cells
 * are left out of the row; picks-feed rows (a bare pick number beside the player) are ignored.
 * rows[]: { yahooId, playerName, nbaTeam?, positions?, injuryTag?, xrank?, rank?, adp?, gp?, fgPct?, ftPct?, threePm?, pts?, reb?, ast?, stl?, blk?, tov? }
 */
export function parsePlayersTable(root) {
  const statView = detectStatView(root);
  const table = findPlayersTable(root);
  if (!table) return { statView, columns: [], rows: [] };
  const headCells = [...(table.querySelector("thead") || table).querySelectorAll("th")];
  const columns = headCells.map((th) => (th.textContent || "").replace(/\s+/g, " ").trim());
  const keys = columns.map((c) => COLUMN_KEYS[c.toLowerCase()] || null);
  const rows = [];
  for (const tr of table.querySelectorAll("tbody tr")) {
    const pl = tr.querySelector(".ys-player[data-id]");
    if (!pl || pl.closest("[data-fdc-ignore]") || feedPickNumber(pl) !== null) continue;
    const info = readYahooPlayer(pl);
    const yahooId = pl.getAttribute("data-id");
    if (!yahooId || !info.playerName) continue;
    const row = { yahooId, playerName: info.playerName };
    if (info.nbaTeam) row.nbaTeam = info.nbaTeam;
    if (info.positions) row.positions = info.positions;
    const tag = injuryTagOf(pl);
    if (tag) row.injuryTag = tag;
    const cells = tr.children;
    for (let i = 0; i < keys.length && i < cells.length; i++) {
      const k = keys[i];
      if (!k || k === "player") continue;
      let v = parseStatNumber(cells[i].textContent);
      if (v === undefined) continue;
      if ((k === "fgPct" || k === "ftPct") && v > 1) v = v / 100;
      row[k] = v;
    }
    rows.push(row);
  }
  return { statView, columns, rows };
}

// ----------------------------------------------------------------------------- Results tab (best effort, NOT verified)

/**
 * Results tab of a (finished) draft. No snapshot contains its content yet (only the tab button), so this is a generic,
 * unverified reader: rows (tr / li / role=row) that start with a bare pick number, followed by a player (a `.ys-player`
 * or "Name TEAM - POS" text) and the fantasy team name. Only runs while the Results tab is the selected tab.
 * Returns { active, picks }. Needs a Results-tab snapshot to calibrate.
 */
export function parseResultsTab(root, teams) {
  const tab = root.querySelector("[role='tab'][data-id='results'][aria-selected='true'], #results[role='tab'][aria-selected='true']");
  if (!tab) return { active: false, picks: [] };
  const picks = [];
  for (const row of root.querySelectorAll("tr, li, [role='row']")) {
    if (row.closest("[data-fdc-ignore], [role='tablist'], .ys-player")) continue;
    // leaf rows only (the position / team <li> inside a .ys-player do not count as nested rows)
    if (row.querySelector("tr, [role='row']") || [...row.querySelectorAll("li")].some((l) => !l.closest(".ys-player"))) continue;
    const cells = [...row.children];
    const lead = cells.length ? (cells[0].textContent || "").trim() : "";
    const leadNum = /^#?(\d{1,3})\.?$/.exec(lead);
    const pl = row.querySelector(".ys-player[data-id]");
    if (pl && leadNum && !pl.contains(cells[0])) {
      const info = readYahooPlayer(pl);
      if (!info.playerName) continue;
      const p = { pick: Number(leadNum[1]), playerName: info.playerName };
      const yid = pl.getAttribute("data-id");
      if (yid) p.yahooId = yid;
      if (info.nbaTeam) p.nbaTeam = info.nbaTeam;
      if (info.positions) p.positions = info.positions;
      for (const c of cells.slice(1)) {
        if (c.contains(pl)) continue;
        const t = (c.textContent || "").replace(/\s+/g, " ").trim();
        if (t && !/^\d+$/.test(t)) {
          p.teamName = t.slice(0, 60);
          break;
        }
      }
      picks.push(p);
      continue;
    }
    const res = parsePickBlock(textLines(row), teams);
    if (!res.error && (res.explicit || res.hasTeamPos)) picks.push(toPick(res));
  }
  return { active: true, picks: finalizePicks(picks) };
}

// ----------------------------------------------------------------------------- always-visible header + panel state (calibrated)

/**
 * Yahoo's draft header is visible whatever side panel is open: "00:30 Someone's Pick • Round 13, Pick 182" (Pick = OVERALL number of the
 * pick on the clock; 17 picks made at "Round 2, Pick 18") and "Last: O. Ighodaro (C · PHX)" = the pick before. When the side panel is on
 * Queue instead of Picks the feed rows are not in the DOM, so this is the fallback source.
 * Returns { active, currentPick, last: { pick, playerName, positions?, nbaTeam? } | null }; active = a pick is on the clock ("Draft Complete" = false).
 */
export function parseHeaderState(root) {
  const body = root.body || root.querySelector?.("body") || root;
  const lines = textLines(body).slice(0, 80);
  let currentPick = null;
  let lastLine = null;
  // Once the draft is over the header keeps a stale "Pick N" / "Last: ..." (it once turned the final pick into pick 181): derive nothing.
  const complete = lines.some((l) => /\bDraft Complete\b/i.test(l));
  for (const l of lines) {
    const m = /Round\s+\d+\s*,\s*Pick\s+(\d{1,3})\b/i.exec(l);
    if (m && currentPick === null) currentPick = Number(m[1]);
    if (lastLine === null && /^Last:\s*\S/.test(l)) lastLine = l;
  }
  let last = null;
  if (complete) return { active: false, complete: true, currentPick: null, last: null };
  // Only when "Pick N" and "Last: ..." are both present in the same live header state.
  if (currentPick !== null && currentPick > 1 && lastLine) {
    const m = /^Last:\s*(.+?)\s*(?:\(([^)]*)\))?\s*$/.exec(lastLine);
    if (m) {
      const playerName = m[1].replace(/\s+/g, " ").trim();
      const parts = (m[2] || "").split(/[·•|]/).map((x) => x.trim()).filter(Boolean);
      const positions = parts.find((x) => POS_LIST_RE.test(x.replace(/\s+/g, "")));
      const nbaTeam = parts.find((x) => NBA_CODE_RE.test(x.toUpperCase()));
      if (playerName) {
        last = { pick: currentPick - 1, playerName, via: "header" };
        if (positions) last.positions = positions.replace(/\s+/g, "").split(",").join("/");
        if (nbaTeam) last.nbaTeam = nbaTeam.toUpperCase();
      }
    }
  }
  return { active: currentPick !== null, complete: false, currentPick, last };
}

/** League name shown under "Yahoo Fantasy Basketball Draft" in the header ("Three Seconds - H2H"); null when not found. */
export function parseLeagueName(root) {
  const body = root.body || root.querySelector?.("body") || root;
  const lines = textLines(body).slice(0, 40);
  const i = lines.findIndex((l) => /^Yahoo Fantasy\b.*\bDraft$/i.test(l.trim()));
  const next = i >= 0 ? (lines[i + 1] || "").trim() : "";
  return next && next.length <= 80 ? next : null;
}

/**
 * Which side panel feeds us: "picks" (feed rows in the DOM or the Picks tab selected), "hidden" (a pick is on the clock but the Picks feed
 * is not there, e.g. Queue tab), "n/a" (no live pick on the clock).
 */
export function panelState(root) {
  const h = parseHeaderState(root);
  if (!h.active) return "n/a";
  if (root.querySelector("[role='tab'][data-id='picks'][aria-selected='true']")) return "picks";
  return parseYahooFeed(root).length ? "picks" : "hidden";
}

/**
 * Is the user on the clock according to Yahoo's header? The header reads "<team>'s Pick • You're up in 5 Picks • Round 1, Pick 8" while
 * someone else picks ("You're up in N Picks" = NOT on the clock). The on-the-clock variant has not been captured in a snapshot yet, so this
 * accepts "You're up" without "in N Picks", "Your Pick" / "Your Turn" / "You're on the clock" in the header line; callers should also
 * OR in the app's own `onClock`. Returns false when no header is found.
 */
export function headerOnClock(root) {
  const body = root.body || root.querySelector?.("body") || root;
  for (const l of textLines(body).slice(0, 80)) {
    if (!/Round\s+\d+\s*,\s*Pick\s+\d+/i.test(l) && !/Pick\s*•/i.test(l)) continue;
    if (/you'?re\s+up\s+in\s+\d+/i.test(l)) return false;
    return /you['\u2019]?re\s+up\b|\byour\s+(?:pick|turn)\b|on\s+the\s+clock|\bnow\s+picking\b/i.test(l);
  }
  return false;
}

/** Yahoo draft room id from the URL: /draftclient/nba/<leagueId>/<team> (or /nba/<leagueId>/draft) -> "<leagueId>/<team>", else null. */
export function draftRoomKey(url) {
  let path = String(url || "");
  try {
    path = new URL(path, "https://x.invalid").pathname;
  } catch {
    /* keep raw */
  }
  let m = /\/draftclient\/[a-z]+\/(\d+)(?:\/(\d+))?/i.exec(path);
  if (!m) m = /\/[a-z]+\/(\d+)\/draft/i.exec(path);
  return m ? m[1] + (m[2] ? "/" + m[2] : "") : null;
}

export const PROJ_MAX_AGE_MS = 12 * 3600000;

/**
 * Pure decision for the automatic pre-draft projections capture.
 * Inputs: statView (parsePlayersTable), roomKey (draftRoomKey), lastCapture ({ draftRoomKey, capturedAt (ms) } | null; this browser),
 * serverCapturedAt (ms | null; GET /api/projections/yahoo/status), onClock, now (ms).
 * -> { action: "capture" | "defer" | "hint" | "done" | "none", reason }
 *   done = this room was captured < 12 h ago (by this browser, or newer on the server); none = not a draft room;
 *   hint = needed but the proj view is not selected; defer = needed and visible but the user is on the clock.
 */
export function projectionCaptureDecision({ statView, roomKey, lastCapture, serverCapturedAt, onClock, now }) {
  if (!roomKey) return { action: "none", reason: "no-room" };
  const mine = lastCapture && lastCapture.draftRoomKey === roomKey && Number.isFinite(lastCapture.capturedAt) ? lastCapture.capturedAt : null;
  if (mine !== null) {
    const newest = Math.max(mine, Number.isFinite(serverCapturedAt) ? serverCapturedAt : 0);
    if (now - newest <= PROJ_MAX_AGE_MS) return { action: "done", reason: "captured" };
  }
  if (statView !== "proj-2026-27") return { action: "hint", reason: mine === null ? "not-captured" : "stale" };
  if (onClock) return { action: "defer", reason: "on-clock" };
  return { action: "capture", reason: mine === null ? "not-captured" : "stale" };
}

/** Merges pick lists by pick number; later lists win (call with memory first, feed last). */
export function mergePickLists(...lists) {
  const by = new Map();
  for (const l of lists) for (const p of l || []) by.set(p.pick, toPick(p));
  return [...by.values()].sort((a, b) => a.pick - b.pick);
}

/**
 * Pure alert logic for "Copilot can't see picks". `hiddenSince` = ms timestamp the condition began (null = not hidden).
 * Alert while a pick is on the clock and the Picks panel has been missing for more than graceMs, or the page itself is hidden.
 */
export function pickAlert({ panel, pageVisible, hiddenSince, now, graceMs = 3000 }) {
  if (pageVisible === false) return { show: true, reason: "page-hidden" };
  if (panel === "hidden" && hiddenSince != null && now - hiddenSince > graceMs) return { show: true, reason: "panel-hidden" };
  return { show: false, reason: null };
}

// ----------------------------------------------------------------------------- Results tab > Teams (calibrated)

/**
 * Finished draft, Results > Teams: ONE team's roster at a time (team-selector <select>), table Slot | Player | Pick where the player
 * cell is a `.ys-player[data-id]` and Pick is the OVERALL pick number. Returns { active, teamName, picks } (picks: { pick, playerName,
 * yahooId, nbaTeam?, positions?, teamName? }). Other teams appear only after the user selects them in Yahoo's dropdown.
 */
export function parseResultsTeams(root) {
  const out = { active: false, teamName: undefined, picks: [] };
  for (const table of root.querySelectorAll("table")) {
    if (table.closest("[data-fdc-ignore]")) continue;
    const heads = [...table.querySelectorAll("thead th")].map((th) => (th.getAttribute("data-id") || th.textContent || "").trim().toLowerCase());
    const si = heads.indexOf("slot");
    const pi = heads.indexOf("player");
    const ki = heads.indexOf("pick");
    if (si < 0 || pi < 0 || ki < 0) continue;
    out.active = true;
    const sel = root.querySelector("select#team-selector, select[name='team-selector']");
    const opt = sel && ((sel.selectedOptions && sel.selectedOptions[0]) || sel.options[sel.selectedIndex]);
    if (opt) out.teamName = (opt.textContent || "").trim().slice(0, 60) || undefined;
    for (const tr of table.querySelectorAll("tbody tr")) {
      const cells = tr.children;
      const pl = cells[pi] && cells[pi].querySelector(".ys-player[data-id]");
      const pick = Number(((cells[ki] && cells[ki].textContent) || "").trim());
      if (!pl || !(pick >= 1)) continue;
      const info = readYahooPlayer(pl);
      if (!info.playerName) continue;
      const p = { pick, playerName: info.playerName, yahooId: pl.getAttribute("data-id") };
      if (info.nbaTeam) p.nbaTeam = info.nbaTeam;
      if (info.positions) p.positions = info.positions;
      if (out.teamName) p.teamName = out.teamName;
      out.picks.push(p);
    }
  }
  out.picks = finalizePicks(out.picks);
  return out;
}

// ----------------------------------------------------------------------------- Standings + Board (calibrated on the finished draft room)

const STANDINGS_KEYS = { "fg%": "fg", "ft%": "ft", "3ptm": "threePm", "3pm": "threePm", pts: "pts", reb: "reb", ast: "ast", st: "stl", stl: "stl", blk: "blk", to: "tov", tov: "tov", total: "total", rank: "rank" };

/**
 * Which stat view a Standings table shows, from the printed numbers (the <select> state is lost in snapshots):
 * "proj-2026-27" = counting stats printed with ".0" (1635.0), "total-2025-26" = large integers without ".0" (1423),
 * "avg-2025-26" = per-game averages (19.5 / 228.3). `raw` = rows of { cat: "text" }.
 */
export function classifyStandingsView(raw) {
  const cats = ["threePm", "pts", "reb", "ast", "stl", "blk", "tov"];
  let dotZero = 0;
  let integers = 0;
  let fractional = 0;
  let n = 0;
  let maxPts = 0;
  for (const r of raw) {
    for (const c of cats) {
      const t = String(r[c] == null ? "" : r[c]).replace(/,/g, "").trim();
      if (!/^\d+(\.\d+)?$/.test(t)) continue;
      n++;
      if (c === "pts") maxPts = Math.max(maxPts, Number(t));
      if (/\.0+$/.test(t)) dotZero++;
      else if (t.includes(".")) fractional++;
      else integers++;
    }
  }
  if (!n) return "unknown";
  if (dotZero / n >= 0.9 && maxPts >= 1000) return "proj-2026-27";
  if (maxPts >= 1000 && fractional === 0) return "total-2025-26";
  if (maxPts > 0 && maxPts < 1000) return "avg-2025-26";
  return "unknown";
}

/**
 * Standings tab: { active, view, rows }. rows[]: { rank, teamName, fg, ft, threePm, pts, reb, ast, stl, blk, tov, total }; teamName is the
 * manager name (second line of the team cell, equal to the Board's column title), `label` the first line when different ("Your Team").
 * `view`: with opts.trustSelect (live DOM, default) the stat-type <select>'s selected option; otherwise (snapshots) inferred from the numbers.
 */
export function parseStandings(root, opts = {}) {
  const out = { active: false, view: "unknown", rows: [] };
  for (const table of root.querySelectorAll("table")) {
    if (table.closest("[data-fdc-ignore]")) continue;
    const heads = [...table.querySelectorAll("thead th")].map((th) => (th.getAttribute("data-id") === "teamname" ? "team" : (th.textContent || "").trim().toLowerCase()));
    if (!heads.includes("team") || !heads.includes("total") || !heads.includes("rank")) continue;
    out.active = true;
    const keys = heads.map((h) => STANDINGS_KEYS[h] || (h === "team" ? "team" : null));
    const raw = [];
    for (const tr of table.querySelectorAll("tbody tr")) {
      const cells = [...tr.children];
      const o = {};
      let label;
      for (let i = 0; i < keys.length && i < cells.length; i++) {
        const k = keys[i];
        if (!k) continue;
        if (k === "team") {
          const spans = [...cells[i].querySelectorAll("span")].map((x) => (x.textContent || "").trim()).filter(Boolean);
          const name = spans.length ? spans[spans.length - 1] : (cells[i].textContent || "").trim();
          o.teamName = name.slice(0, 60);
          if (spans.length > 1 && spans[0] !== name) label = spans[0].slice(0, 60);
        } else o[k] = (cells[i].textContent || "").trim();
      }
      if (o.teamName) raw.push({ ...o, label });
    }
    let view = "unknown";
    if (opts.trustSelect !== false) {
      const sel = root.querySelector("select#stat-mode-filter, select[name='stat-mode-filter']");
      const opt = sel && ((sel.selectedOptions && sel.selectedOptions[0]) || null);
      if (opt) view = classifyStatView(opt.textContent, opt.value);
    }
    if (view === "unknown" || view === "advanced" || opts.trustSelect === false) view = classifyStandingsView(raw);
    out.view = view;
    for (const r of raw) {
      const row = { rank: parseStatNumber(r.rank), teamName: r.teamName };
      if (r.label) row.label = r.label;
      for (const k of ["fg", "ft", "threePm", "pts", "reb", "ast", "stl", "blk", "tov", "total"]) {
        const v = parseStatNumber(r[k]);
        if (v !== undefined) row[k] = v;
      }
      if (row.rank !== undefined) out.rows.push(row);
    }
    break;
  }
  return out;
}

const BOARD_TITLE_RE = /^(.+?), ([A-Z]{2,4})-([A-Z,/ ]+), (\d{1,2})\.(\d{1,2})$/;

/**
 * Board tab: a CSS grid with one header per team (title = Yahoo team/manager name; the user's header text reads "You") followed by one
 * cell per pick, row by row; a cell's title is "Name, TEAM-POS, round.pickInRound" (even rounds count down, so the label is not the column).
 * Returns { active, teams: [{ slot, name, isUser }], picks: [{ pick, round, teamSlot, teamName, playerName, nbaTeam, positions }] }.
 * Empty cells (picks not made yet) are skipped; the column gives the team slot.
 */
export function parseBoard(root) {
  const out = { active: false, teams: [], picks: [] };
  const first = [...root.querySelectorAll("div[title]")].find((el) => BOARD_TITLE_RE.test(el.getAttribute("title") || "") && !el.closest("[data-fdc-ignore]"));
  if (!first) return out;
  let grid = first.parentElement;
  while (grid && ![...grid.children].some((k) => k.hasAttribute("title") && !BOARD_TITLE_RE.test(k.getAttribute("title") || ""))) grid = grid.parentElement;
  if (!grid) return out;
  const kids = [...grid.children];
  const headers = kids.filter((k) => k.hasAttribute("title") && !BOARD_TITLE_RE.test(k.getAttribute("title") || ""));
  const n = headers.length;
  if (n < 2) return out;
  out.active = true;
  out.teams = headers.map((h, i) => ({ slot: i + 1, name: (h.getAttribute("title") || "").trim().slice(0, 60), isUser: /^you$/i.test((h.textContent || "").trim()) }));
  const body = kids.filter((k) => !headers.includes(k));
  for (let idx = 0; idx < body.length; idx++) {
    const cell = body[idx].matches("[title]") ? body[idx] : body[idx].querySelector("[title]");
    const m = cell && BOARD_TITLE_RE.exec(cell.getAttribute("title") || "");
    if (!m) continue;
    const round = Math.floor(idx / n) + 1;
    const slot = (idx % n) + 1;
    out.picks.push({
      pick: (round - 1) * n + Number(m[5]),
      round,
      teamSlot: slot,
      teamName: out.teams[slot - 1].name,
      playerName: m[1].trim(),
      nbaTeam: m[2],
      positions: m[3].replace(/\s+/g, "").split(",").join("/"),
    });
  }
  return out;
}

// ----------------------------------------------------------------------------- recommendations matching (client side)

const TEAM_ALIASES = { GS: "GSW", NO: "NOP", NOR: "NOP", NY: "NYK", SA: "SAS", PHO: "PHX", UTAH: "UTA", UTH: "UTA", WSH: "WAS", BRK: "BKN", CHO: "CHA" };
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/** Yahoo / NBA.com abbreviation variants -> one canonical code (same table as the server). */
export function canonTeam(t) {
  const u = String(t == null ? "" : t).trim().toUpperCase();
  return TEAM_ALIASES[u] || u;
}

/** "Jaren Jackson Jr." -> ["jaren","jackson"]; accents, punctuation and generational suffixes removed (mirrors the server's normalizeName). */
export function nameTokens(name) {
  const parts = String(name == null ? "" : name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.'\u2019`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (parts.length > 2 && NAME_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  if (parts.length === 2 && NAME_SUFFIXES.has(parts[1])) parts.pop();
  return parts;
}

/** "Karl-Anthony Towns" and "K. Towns" -> "k|towns" (first initial + last token). "" when there is no usable pair. */
export function initialKey(name) {
  const t = nameTokens(name);
  return t.length < 2 ? "" : t[0][0] + "|" + t[t.length - 1];
}

/** Index of recommendation `board` rows by initial+last name. */
export function buildBoardIndex(board) {
  const index = new Map();
  for (const row of board || []) {
    const k = initialKey(row.name);
    if (!k) continue;
    const list = index.get(k);
    if (list) list.push(row);
    else index.set(k, [row]);
  }
  return index;
}

/** Board row for a Yahoo "K. Towns" + "NYK"; null when unknown or still ambiguous after the team filter. */
export function matchBoardPlayer(index, yahooName, yahooTeam) {
  let cands = index.get(initialKey(yahooName)) || [];
  if (cands.length > 1 && yahooTeam) {
    const t = canonTeam(yahooTeam);
    const byTeam = cands.filter((c) => canonTeam(c.nbaTeam) === t);
    if (byTeam.length) cands = byTeam;
  }
  return cands.length === 1 ? cands[0] : null;
}

/** Players-table `.ys-player[data-id]` elements (everything that is not a picks-feed row nor ours): [{ el, id, name, nameEl, nbaTeam }]. */
export function findTablePlayers(root) {
  const out = [];
  for (const el of root.querySelectorAll(".ys-player[data-id]")) {
    if (el.closest("[data-fdc-ignore]") || feedPickNumber(el) !== null) continue;
    const info = readYahooPlayer(el);
    if (!info.playerName || !info.nameEl) continue;
    out.push({ el, id: el.getAttribute("data-id"), name: info.playerName, nameEl: info.nameEl, nbaTeam: info.nbaTeam });
  }
  return out;
}

/** Short badge text: "DRAFT 74" / "#3 WAIT 66" (rank shown for the top 10). */
export function badgeText(row) {
  const sc = typeof row.score === "number" ? (Math.abs(row.score) >= 10 ? String(Math.round(row.score)) : row.score.toFixed(1)) : "";
  return ((row.rank && row.rank <= 10 ? "#" + row.rank + " " : "") + row.state + (sc ? " " + sc : "")).trim();
}

/** Injury marker for a recommendations row/board entry: red "O"/"OFS", amber "DTD"; null when healthy or unknown. */
export function statusMarker(status) {
  if (status === "out") return { text: "O", color: "#dc2626" };
  if (status === "out-for-season") return { text: "OFS", color: "#991b1b" };
  if (status === "day-to-day") return { text: "DTD", color: "#d97706" };
  return null;
}

// ----------------------------------------------------------------------------- orchestration

/** Dedupe by pick number (prefer entries with more detail), drop implausible numbers, sort ascending. */
export function finalizePicks(list, cfg = CONFIG) {
  const byPick = new Map();
  const detail = (p) => (p.nbaTeam ? 1 : 0) + (p.positions ? 1 : 0) + (p.teamName ? 1 : 0);
  for (const p of list) {
    if (!(p.pick >= 1 && p.pick <= cfg.maxPick) || !Number.isInteger(p.pick)) continue;
    const prev = byPick.get(p.pick);
    if (!prev || detail(p) > detail(prev)) byPick.set(p.pick, toPick(p));
  }
  return [...byPick.values()].sort((a, b) => a.pick - b.pick);
}

/**
 * Parses the draft room from a Document or Element.
 * Returns { picks, method: "selectors" | "text" | "none", detail, needsTeams, notes }.
 */
export function parseDraftRoom(root, overrides = {}) {
  const cfg = { ...CONFIG, ...overrides, fields: { ...CONFIG.fields, ...(overrides.fields || {}) } };
  const notes = [];
  const p0 = finalizePicks(parseYahooFeed(root), cfg);
  if (p0.length) return { picks: p0, method: "yahoo-feed", detail: ".ys-player feed", needsTeams: false, notes };
  const rt = parseResultsTeams(root);
  if (rt.picks.length) return { picks: rt.picks, method: "results-teams", detail: "Results > Teams", needsTeams: false, notes };
  const pr = parseResultsTab(root, cfg.teams);
  if (pr.picks.length) return { picks: pr.picks, method: "results-tab", detail: "Results tab (unverified layout)", needsTeams: false, notes };
  const l1 = parseWithSelectors(root, cfg);
  const l2 = parseWithText(root, cfg);
  const p1 = finalizePicks(l1.picks, cfg);
  const p2 = finalizePicks(l2.picks, cfg);
  const needsTeams = (l1.needsTeams || l2.needsTeams) && !cfg.teams;
  if (needsTeams) notes.push("pick numbers are round-relative; waiting for the team count from the app");
  if (p1.length >= p2.length && p1.length) return { picks: p1, method: "selectors", detail: l1.selector, needsTeams, notes };
  if (p2.length) {
    if (l2.via === "body") notes.push("no pick-history region found; scanned the whole page (lower confidence)");
    return { picks: p2, method: "text", detail: l2.via, needsTeams, notes };
  }
  return { picks: [], method: "none", detail: null, needsTeams, notes };
}

// ----------------------------------------------------------------------------- Season mode: Yahoo league pages (BEST EFFORT, NOT calibrated)

/*
 * In-season pages (basketball.fantasysports.yahoo.com/nba/<league>/...): My Team (/<teamId>), Players (/players), Matchup (/matchup).
 * No real snapshot of these pages exists yet, so every reader below is a generic heuristic over table rows ("a row = a player link + a
 * status + position cells") and is covered by plausible fixtures only (tests/fixtures-extension/season-*.html). Use the overlay's
 * "Send snapshot" on each page type and calibrate (see extension/README.md, "Season mode"). Everything is read-only.
 */

const SEASON_SLOT_RE = /^(PG|SG|G|SF|PF|F|C|UTIL|BN|IL\+?|NA)$/i;
const SEASON_TAGS = new Set(["INJ", "O", "Q", "DTD", "GTD", "NA", "IL", "IL+", "SUSP", "P", "D", "OUT"]);
const SEASON_OPP_RE = /^(@|vs\.?)\s*([A-Za-z]{2,4})\b/i;

/** Which Yahoo page this is: { kind: "team" | "players" | "matchup" | "draft" | "other", leagueId, teamId }. */
export function parseSeasonUrl(href) {
  let u;
  try {
    u = new URL(href, "https://basketball.fantasysports.yahoo.com/");
  } catch {
    return { kind: "other", leagueId: null, teamId: null };
  }
  if (!/fantasysports\.yahoo\.com$/i.test(u.hostname)) return { kind: "other", leagueId: null, teamId: null };
  if (/draft/i.test(u.pathname)) return { kind: "draft", leagueId: null, teamId: null };
  const m = /^\/nba\/(\d+)(?:\/([^/?#]*))?/.exec(u.pathname);
  if (!m) return { kind: "other", leagueId: null, teamId: null };
  const seg = m[2] || "";
  if (/^\d+$/.test(seg)) return { kind: "team", leagueId: m[1], teamId: seg };
  if (seg === "players") return { kind: "players", leagueId: m[1], teamId: null };
  if (seg === "matchup") return { kind: "matchup", leagueId: m[1], teamId: null };
  if (seg === "transactions") return { kind: "transactions", leagueId: m[1], teamId: null };
  return { kind: "other", leagueId: m[1], teamId: null };
}

/** The user's own team id from the "My Team" navigation link (so a team page can be told apart from an opponent's). */
export function findMyTeamId(root) {
  for (const a of root.querySelectorAll("a[href]")) {
    if (a.closest("[data-fdc-ignore]")) continue;
    if ((a.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() !== "my team") continue;
    const m = /\/nba\/\d+\/(\d+)(?:[/?#]|$)/.exec(a.getAttribute("href") || "");
    if (m) return m[1];
  }
  return null;
}

const NAV_LABELS = /^(my team|team|roster|matchup|players|league|standings|more|home|draft|transactions|trade|scoreboard|schedule|waiver|add|drop)$/i;

/**
 * Team name shown on a team page. Real Yahoo (2026): the roster table caption "<team>'s Players roster for <date>." and the title
 * "<league> - <team> | Fantasy Basketball | Yahoo! Sports" (the <h1> is the league name or the site header, never the team).
 */
export function findTeamName(root) {
  for (const cap of root.querySelectorAll("caption")) {
    if (cap.closest("[data-fdc-ignore]")) continue;
    const m = /^\s*(.+?)['\u2019]s\s+Players\s+roster\b/i.exec((cap.textContent || "").replace(/\s+/g, " "));
    if (m && m[1].length <= 60) return m[1].trim();
  }
  const title = (root.title || (root.querySelector && root.querySelector("title") ? root.querySelector("title").textContent : "") || "").trim();
  const head = title.split(/\s+[|\u2013\u2014]\s+/)[0].trim();
  const dash = head.split(/\s+-\s+/);
  if (dash.length >= 2) {
    const t = dash[dash.length - 1].trim();
    if (t && t.length <= 60 && !NAV_LABELS.test(t) && !/yahoo/i.test(t)) return t;
  }
  const sels = ["[data-tst='team-name']", "#team-name", ".team-name", "[class*='teamName' i]", "[class*='team-name' i]", "#yspmaincontent h1"];
  for (const sel of sels) {
    for (const el of root.querySelectorAll(sel)) {
      if (el.closest("[data-fdc-ignore]")) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length <= 60 && !NAV_LABELS.test(t) && !/yahoo/i.test(t)) return t;
    }
  }
  return head && head.length <= 60 && !NAV_LABELS.test(head) && !/yahoo/i.test(head) ? head : null;
}

const SEASON_STAT_KEYS = {
  "fg%": "fgPct", "ft%": "ftPct", "3ptm": "threePm", "3pm": "threePm", "3pt": "threePm", pts: "pts", reb: "reb", ast: "ast", st: "stl", stl: "stl", blk: "blk", to: "tov", tov: "tov",
  gp: "gp", "gp*": "gp", mpg: "min", min: "min", rank: "rank", "%owned": "pctOwned", "% owned": "pctOwned", "%own": "pctOwned", "owned": "pctOwned", "%rost": "pctOwned", "%ros": "pctOwned", "fan pts": "fpts", "fpts": "fpts",
};

function seasonHeaderKeys(table) {
  const hrows = [...table.querySelectorAll("thead tr")];
  const cells = hrows.length ? [...hrows[hrows.length - 1].children] : [...(table.querySelector("tr") ? table.querySelector("tr").children : [])];
  const keys = [];
  for (const th of cells) {
    const t = (th.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    for (let i = 0, n = Math.max(1, Number(th.getAttribute("colspan")) || 1); i < n; i++) keys.push(t);
  }
  return keys;
}

function seasonPlayerLink(tr) {
  for (const a of tr.querySelectorAll("a[href]")) {
    if (a.closest("[data-fdc-ignore]")) continue;
    const m = /\/nba\/players\/(\d+)/.exec(a.getAttribute("href") || "");
    if (m && (a.textContent || "").trim().length >= 3 && !/^(new\s+)?player\s+notes?$/i.test((a.textContent || "").trim()) && !/\/nba\/players\/\d+\/(news|notes)/.test(a.getAttribute("href") || "")) return { id: m[1], name: a.textContent.replace(/\s+/g, " ").trim(), el: a };
  }
  return null;
}

function seasonTag(cell, nameEl) {
  for (const el of cell.querySelectorAll("span,abbr,div,em,b,i")) {
    if (el.children.length || el.contains(nameEl) || el.closest("[data-fdc-ignore]")) continue;
    const t = (el.textContent || "").trim();
    if (t && SEASON_TAGS.has(t.toUpperCase())) return t.toUpperCase();
  }
  return undefined;
}

/** One table row -> a player row (or null). Generic: player link (or `.ys-player` / data-ys-playerid), team-pos text, slot cell, status tag, stats by header. */
function parseSeasonRow(tr, keys) {
  const cells = [...tr.children];
  if (!cells.length) return null;
  let id = null;
  let name = "";
  let nameEl = null;
  let team;
  let positions;
  const link = seasonPlayerLink(tr);
  const ys = tr.querySelector(".ys-player[data-id]");
  const attrEl = tr.matches("[data-ys-playerid]") ? tr : tr.querySelector("[data-ys-playerid]");
  if (ys) {
    const info = readYahooPlayer(ys);
    id = ys.getAttribute("data-id");
    name = info.playerName;
    nameEl = info.nameEl;
    team = info.nbaTeam;
    positions = info.positions;
  }
  if (link) {
    id = id || link.id;
    name = name || link.name;
    nameEl = nameEl || link.el;
  }
  if (!id && attrEl) id = attrEl.getAttribute("data-ys-playerid");
  if (!name) return null;
  // The cell that holds the player: contains the name element.
  const playerCell = cells.find((c) => nameEl && c.contains(nameEl)) || cells.find((c) => (c.textContent || "").includes(name)) || cells[0];
  const info = tr.tagName.toUpperCase() === "TR" ? playerCell : tr;
  if (!team || !positions) {
    const tp = parseTeamPos(textLines(info).join(" ").replace(name, " ").replace(/\s+/g, " "));
    if (tp) {
      team = team || tp.nbaTeam;
      positions = positions || tp.positions.split(",").join("/");
    }
  }
  if (positions) positions = positions.replace(/,/g, "/");
  const row = { playerName: name };
  if (id) row.yahooId = String(id);
  if (team) row.nbaTeam = team.toUpperCase();
  if (positions) row.positions = positions;
  // Slot: a short cell before the player cell.
  const pi = cells.indexOf(playerCell);
  const dp = (tr.getAttribute("data-pos") || "").trim();
  if (dp && SEASON_SLOT_RE.test(dp)) row.slot = dp.toUpperCase();
  for (let i = 0; i < pi && !row.slot; i++) {
    const t = (cells[i].textContent || "").replace(/\s+/g, " ").trim();
    if (SEASON_SLOT_RE.test(t)) {
      row.slot = t.toUpperCase();
      break;
    }
  }
  if (!row.slot && tr.tagName.toUpperCase() !== "TR") {
    for (const n of tr.querySelectorAll("*")) {
      if (n === nameEl || n.contains(nameEl)) break;
      if (n.children.length) continue;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (SEASON_SLOT_RE.test(t)) {
        row.slot = t.toUpperCase();
        break;
      }
    }
  }
  const tag = seasonTag(info, nameEl);
  if (tag) row.injuryTag = tag;
  // Stats / opponent by header text.
  const stats = {};
  let oppCell = null;
  for (let i = 0; i < cells.length && i < keys.length; i++) {
    if (cells[i] === playerCell) continue;
    const k = keys[i];
    const text = (cells[i].textContent || "").replace(/\s+/g, " ").trim();
    if (/^(opp|opponent|today|game)\b/.test(k)) {
      oppCell = text;
      continue;
    }
    const sk = SEASON_STAT_KEYS[k] || SEASON_STAT_KEYS[k.replace(/\s+/g, "")] || SEASON_STAT_KEYS[k.replace(/[\s*]+/g, "")];
    if (!sk) continue;
    let v = parseStatNumber(text);
    if (v === undefined) continue;
    if ((sk === "fgPct" || sk === "ftPct") && v > 1) v = Math.round(v * 10) / 1000;
    if (sk === "pctOwned") row.pctOwned = v;
    else stats[sk] = v;
  }
  if (Object.keys(stats).length) row.stats = stats;
  if (oppCell === null) {
    for (const c of cells) {
      const t = (c.textContent || "").replace(/\s+/g, " ").trim();
      if (SEASON_OPP_RE.test(t)) {
        oppCell = t;
        break;
      }
    }
    if (oppCell !== null) row.hasGame = true;
  }
  if (oppCell !== null) {
    const m = SEASON_OPP_RE.exec(oppCell);
    if (m) {
      row.opp = oppCell.slice(0, 20);
      row.hasGame = true;
    } else if (/^[-–—\s]*$/.test(oppCell) || /^no game/i.test(oppCell)) row.hasGame = false;
    else if (/\d{1,2}:\d{2}/.test(oppCell)) {
      row.opp = oppCell.slice(0, 20);
      row.hasGame = true;
    }
  }
  return row;
}

/** Row elements of div/list based layouts: the largest ancestor of a player link that holds no other player (stops at tr / li / role=row). */
function structuralRowEls(root) {
  const links = [];
  for (const a of root.querySelectorAll("a[href]")) {
    if (a.closest("[data-fdc-ignore]")) continue;
    const m = /\/nba\/players\/(\d+)(?:[/?#]|$)/.exec(a.getAttribute("href") || "");
    const t = (a.textContent || "").trim();
    if (m && t.length >= 3 && !/^(new\s+)?player\s+notes?$/i.test(t)) links.push({ id: m[1], a });
  }
  const idsIn = (el) => {
    const ids = new Set();
    for (const a of el.querySelectorAll("a[href]")) {
      const m = /\/nba\/players\/(\d+)(?:[/?#]|$)/.exec(a.getAttribute("href") || "");
      if (m && (a.textContent || "").trim().length >= 3) ids.add(m[1]);
    }
    return ids;
  };
  const out = [];
  const seen = new Set();
  for (const { id, a } of links) {
    let el = a.parentElement;
    for (let i = 0; el && i < 8; i++) {
      if (/^(TR|LI)$/i.test(el.tagName) || el.getAttribute("role") === "row") break;
      const up = el.parentElement;
      if (!up || /^(BODY|HTML|TABLE|TBODY|UL|OL)$/i.test(up.tagName) || idsIn(up).size > 1) break;
      el = up;
    }
    if (!el || seen.has(el) || idsIn(el).size !== 1 || !idsIn(el).has(id)) continue;
    seen.add(el);
    out.push(el);
  }
  return out;
}

function seasonTables(root) {
  return [...root.querySelectorAll("table")].filter((t) => !t.closest("[data-fdc-ignore]"));
}

/**
 * My Team / team roster page: { teamName, myTeamId, rows } with rows[]: { playerName, yahooId?, nbaTeam?, positions?, slot, injuryTag?, opp?, hasGame?, stats? }.
 * Only rows that start with a lineup slot (PG ... BN, IL) count, so the free-agent or stats tables on the same page are ignored.
 */
export function parseSeasonRoster(root) {
  const rows = [];
  const seen = new Set();
  for (const table of seasonTables(root)) {
    const keys = seasonHeaderKeys(table);
    for (const tr of table.querySelectorAll("tbody tr, tr")) {
      if (tr.closest("thead") || tr.querySelector("table")) continue;
      const row = parseSeasonRow(tr, keys);
      if (!row || !row.slot) continue;
      const key = row.yahooId || row.playerName;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  if (!rows.length) {
    for (const el of structuralRowEls(root)) {
      const row = parseSeasonRow(el, []);
      if (!row || !row.slot) continue;
      const key = row.yahooId || row.playerName;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return { teamName: findTeamName(root), myTeamId: findMyTeamId(root), rows };
}

/** Players / free-agent list: { rows } with rows[]: { playerName, yahooId?, nbaTeam?, positions?, injuryTag?, pctOwned?, stats? }; rows with a lineup slot (roster tables) are skipped. */
export function parseSeasonPlayers(root) {
  const rows = [];
  const seen = new Set();
  for (const table of seasonTables(root)) {
    const keys = seasonHeaderKeys(table);
    for (const tr of table.querySelectorAll("tbody tr, tr")) {
      if (tr.closest("thead") || tr.querySelector("table")) continue;
      const row = parseSeasonRow(tr, keys);
      if (!row || row.slot) continue;
      const key = row.yahooId || row.playerName;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  if (!rows.length) {
    for (const el of structuralRowEls(root)) {
      const row = parseSeasonRow(el, []);
      if (!row || row.slot) continue;
      const key = row.yahooId || row.playerName;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return { rows };
}

/**
 * Pagination links of a Yahoo list page: same path, only the `count` (offset) query parameter differs from the current URL.
 * Returns absolute URLs sorted by count, without the current page. Used for read-only same-origin GETs, never for clicking.
 */
export function findSeasonPageLinks(root, currentHref) {
  let cur;
  try {
    cur = new URL(currentHref);
  } catch {
    return [];
  }
  const sig = (u) => {
    const p = new URLSearchParams(u.search);
    p.delete("count");
    return u.origin + u.pathname + "?" + [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[0] + "=" + e[1]).join("&");
  };
  const base = sig(cur);
  const out = new Map();
  for (const a of root.querySelectorAll("a[href]")) {
    if (a.closest("[data-fdc-ignore]")) continue;
    let u;
    try {
      u = new URL(a.getAttribute("href"), cur);
    } catch {
      continue;
    }
    if (u.origin !== cur.origin || !u.searchParams.has("count") || sig(u) !== base) continue;
    const n = Number(u.searchParams.get("count"));
    if (!Number.isFinite(n) || n === Number(cur.searchParams.get("count") || 0)) continue;
    out.set(n, u.href);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

const MATCHUP_LABELS = {
  "fg%": "fgPct", "ft%": "ftPct", "3ptm": "threePm", "3pm": "threePm", "3pt": "threePm", pts: "pts", reb: "reb", ast: "ast", st: "stl", stl: "stl", blk: "blk", to: "tov", tov: "tov",
};
const FRAC_LABELS = { "fgm/a": ["fgm", "fga"], "fgm/fga": ["fgm", "fga"], "ftm/a": ["ftm", "fta"], "ftm/fta": ["ftm", "fta"] };
const normLabel = (t) => String(t || "").replace(/\s+/g, "").replace(/\*+$/, "").toLowerCase();
const fracOf = (s) => {
  const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(String(s || "").trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
};
const isCatLabel = (t) => {
  const n = normLabel(t);
  return !!(MATCHUP_LABELS[n] || FRAC_LABELS[n]);
};
const TEAM_HREF_RE = /\/nba\/(\d+)\/(\d+)(?:[/?#]|$)/;

function setCat(cats, label, lraw, rraw) {
  const n = normLabel(label);
  if (FRAC_LABELS[n]) {
    const [mk, ak] = FRAC_LABELS[n];
    const l = fracOf(lraw);
    const r = fracOf(rraw);
    if (!l || !r) return false;
    cats[0][mk] = l[0];
    cats[0][ak] = l[1];
    cats[1][mk] = r[0];
    cats[1][ak] = r[1];
    return true;
  }
  const key = MATCHUP_LABELS[n];
  if (!key) return false;
  let lv = parseStatNumber(lraw);
  let rv = parseStatNumber(rraw);
  if (lv === undefined || rv === undefined) return false;
  if ((key === "fgPct" || key === "ftPct") && (lv > 1 || rv > 1)) {
    lv = lv > 1 ? Math.round(lv * 10) / 1000 : lv;
    rv = rv > 1 ? Math.round(rv * 10) / 1000 : rv;
  }
  cats[0][key] = lv;
  cats[1][key] = rv;
  return true;
}

/** Layout 1 (real Yahoo 2026): a table whose header lists the categories (Team FGM/A* FG% ... TO) and whose two body rows are the teams. */
function matchupFromHeaderTables(root) {
  for (const table of root.querySelectorAll("table")) {
    if (table.closest("[data-fdc-ignore]")) continue;
    const hrows = [...table.querySelectorAll("tr")].filter((tr) => tr.querySelector("th") && !tr.querySelector("td"));
    if (!hrows.length) continue;
    const head = [...hrows[hrows.length - 1].children].map((c) => (c.textContent || "").replace(/\s+/g, " ").trim());
    if (head.filter(isCatLabel).length < 6) continue;
    const teams = [];
    for (const tr of table.querySelectorAll("tr")) {
      if (!tr.querySelector("td") || tr.querySelector("table")) continue;
      const cells = [...tr.children];
      const link = [...tr.querySelectorAll("a[href]")].find((a) => TEAM_HREF_RE.test(a.getAttribute("href") || "") && (a.textContent || "").trim());
      if (!link) continue;
      const cats = [{}, {}];
      let n = 0;
      cells.forEach((c, i) => {
        const label = head[i];
        if (!label || !isCatLabel(label)) return;
        const t = (c.textContent || "").replace(/\s+/g, " ").trim();
        if (setCat(cats, label, t, t)) n++;
      });
      if (n < 6) continue;
      const m = TEAM_HREF_RE.exec(link.getAttribute("href"));
      teams.push({ name: link.textContent.replace(/\s+/g, " ").trim(), id: m[2], cats: cats[0] });
    }
    if (teams.length >= 2) return teams.slice(0, 2);
  }
  return null;
}

function leafTexts(el) {
  const out = [];
  for (const n of el.querySelectorAll("*")) {
    if (n.children.length || SKIP.has(n.tagName.toUpperCase())) continue;
    const t = (n.textContent || "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
}

/** Layout 2/3: one row per category with the label between (or before) the two values: table rows (<td>) or div/list rows (leaf elements). */
function matchupFromLabelRows(root) {
  const cats = [{}, {}];
  let count = 0;
  const fromCells = (cells) => {
    const li = cells.findIndex((t) => isCatLabel(t));
    if (li < 0) return;
    const label = cells[li];
    const frac = !!FRAC_LABELS[normLabel(label)];
    const ok = (t) => (frac ? !!fracOf(t) : parseStatNumber(t) !== undefined);
    let l = li > 0 && ok(cells[li - 1]) ? li - 1 : -1;
    let r = li + 1 < cells.length && ok(cells[li + 1]) ? li + 1 : -1;
    if (l < 0 || r < 0) {
      const after = cells.map((t, i) => [t, i]).filter(([t, i]) => i > li && ok(t));
      if (after.length >= 2) [l, r] = [after[0][1], after[1][1]];
    }
    if (l < 0 || r < 0) return;
    const had = cats[0][MATCHUP_LABELS[normLabel(label)]] !== undefined;
    if (setCat(cats, label, cells[l], cells[r]) && !frac && !had) count++;
  };
  const seen = new Set();
  for (const tr of root.querySelectorAll("tr")) {
    if (tr.closest("[data-fdc-ignore]") || tr.querySelector("table")) continue;
    fromCells([...tr.children].map((c) => (c.textContent || "").replace(/\s+/g, " ").trim()));
  }
  if (count < 6) {
    for (const leaf of root.querySelectorAll("*")) {
      if (leaf.children.length || leaf.closest("[data-fdc-ignore],table,thead") || !isCatLabel(leaf.textContent || "")) continue;
      let p = leaf.parentElement;
      for (let i = 0; p && i < 3; i++, p = p.parentElement) {
        const lt = leafTexts(p);
        if (lt.length >= 3 && lt.length <= 9 && lt.filter((t) => parseStatNumber(t) !== undefined || fracOf(t)).length >= 2) {
          if (!seen.has(p)) {
            seen.add(p);
            fromCells(lt);
          }
          break;
        }
      }
    }
  }
  return { cats, count };
}

/** "24 Remaining | 11/35 Games Played 12/30 | Remaining 18" -> { gamesPlayed: [11, 12], gamesRemaining: [24, 18] } (nulls when not shown). */
export function parseMatchupGames(root) {
  const leaves = [];
  for (const n of root.querySelectorAll("*")) {
    if (n.children.length || SKIP.has(n.tagName.toUpperCase()) || n.closest("[data-fdc-ignore]")) continue;
    const t = (n.textContent || "").replace(/\s+/g, " ").trim();
    if (t) leaves.push(t);
  }
  const out = { gamesPlayed: [null, null], gamesRemaining: [null, null] };
  const num = (t) => {
    const m = /^(\d+)(?:\s*\/\s*\d+)?$/.exec(t || "");
    return m ? Number(m[1]) : null;
  };
  const gp = leaves.findIndex((t) => /^games played$/i.test(t));
  if (gp >= 0) {
    out.gamesPlayed = [num(leaves[gp - 1]), num(leaves[gp + 1])];
    for (let i = gp - 1; i >= Math.max(0, gp - 4); i--) {
      if (/^remaining( games)?$/i.test(leaves[i])) {
        out.gamesRemaining[0] = num(leaves[i - 1]);
        break;
      }
    }
    for (let i = gp + 1; i <= Math.min(leaves.length - 1, gp + 4); i++) {
      if (/^remaining( games)?$/i.test(leaves[i])) {
        out.gamesRemaining[1] = num(leaves[i + 1]);
        break;
      }
    }
  }
  return out;
}

function matchupWeek(root) {
  const wk = (href) => {
    const m = /[?&]week=(\d{1,2})\b/.exec(href || "");
    return m ? Number(m[1]) : null;
  };
  const sel = root.querySelector(".Navitem.Selected a[href*='week='], li.Selected a[href*='week=']");
  if (sel && wk(sel.getAttribute("href"))) return wk(sel.getAttribute("href"));
  const opt = root.querySelector("select option[selected][value*='week=']");
  if (opt && wk(opt.getAttribute("value"))) return wk(opt.getAttribute("value"));
  const next = root.querySelector("a.Js-next[href*='week=']");
  if (next && wk(next.getAttribute("href"))) return wk(next.getAttribute("href")) - 1;
  const prev = root.querySelector("a.Js-prev[href*='week=']");
  if (prev && wk(prev.getAttribute("href"))) return wk(prev.getAttribute("href")) + 1;
  const text = (root.body || root).textContent || "";
  const m = /\bWeek\s+(\d{1,2})\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Matchup page: { found, week, leagueId, teams: [{ name, id?, cats, gamesPlayed?, gamesRemaining? }, ...] }.
 * Layouts tried in order: header-column table (real Yahoo), category rows in a table, category rows made of divs/list items.
 * Needs both team names and >= 6 categories.
 */
export function parseSeasonMatchup(root, leagueId) {
  const games = parseMatchupGames(root);
  const week = matchupWeek(root);
  const withGames = (teams) => teams.map((t, i) => ({ ...t, ...(games.gamesPlayed[i] != null ? { gamesPlayed: games.gamesPlayed[i] } : {}), ...(games.gamesRemaining[i] != null ? { gamesRemaining: games.gamesRemaining[i] } : {}) }));
  const ht = matchupFromHeaderTables(root);
  if (ht) return { found: true, layout: "header-table", week, leagueId: leagueId || null, teams: withGames(ht) };
  const { cats, count } = matchupFromLabelRows(root);
  const names = [];
  for (const a of root.querySelectorAll("a[href]")) {
    if (a.closest("[data-fdc-ignore]")) continue;
    const m = TEAM_HREF_RE.exec(a.getAttribute("href") || "");
    if (!m) continue;
    const t = (a.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length < 2 || t.length > 60 || NAV_LABELS.test(t)) continue;
    if (!names.some((n) => n.name === t)) names.push({ name: t, id: m[2] });
    if (names.length === 2) break;
  }
  const found = count >= 6 && names.length === 2;
  return { found, layout: found ? "label-rows" : "none", week, leagueId: leagueId || null, teams: names.length === 2 ? withGames([{ ...names[0], cats: cats[0] }, { ...names[1], cats: cats[1] }]) : [] };
}

// ----------------------------------------------------------------------------- Season mode: league discovery, links, transactions


function absUrl(href, base) {
  try {
    return new URL(href, base || "https://basketball.fantasysports.yahoo.com/");
  } catch {
    return null;
  }
}

/**
 * League discovery from any league page: { leagueId, myTeamId, teams: [{ id, name? }] }. Team ids come from links /nba/<league>/<teamId>
 * (nav, standings, matchup, scoreboard); the name is the link text (or the logo's alt/title) when there is one. Read-only.
 */
export function discoverLeague(root, href) {
  const sp = parseSeasonUrl(href || "");
  let leagueId = sp.leagueId;
  const teams = new Map();
  const base = href || "https://basketball.fantasysports.yahoo.com/";
  const note = (id, name) => {
    const cur = teams.get(id) || {};
    if (name && !cur.name) cur.name = name;
    teams.set(id, cur);
  };
  for (const a of root.querySelectorAll("a[href]")) {
    if (a.closest("[data-fdc-ignore]")) continue;
    const u = absUrl(a.getAttribute("href"), base);
    if (!u || !/fantasysports\.yahoo\.com$/i.test(u.hostname)) continue;
    const m = /^\/nba\/(\d+)\/(\d+)(?:\/team)?\/?$/.exec(u.pathname);
    if (!m) continue;
    if (!leagueId) leagueId = m[1];
    if (m[1] !== leagueId) continue;
    let name = (a.textContent || "").replace(/\s+/g, " ").trim();
    if (!name) {
      const img = a.querySelector("img[alt],img[title]");
      name = img ? (img.getAttribute("title") || img.getAttribute("alt") || "").trim() : "";
      if (/^(logo|avatar|team logo)$/i.test(name)) name = "";
    }
    if (name && (NAV_LABELS.test(name) || name.length > 60 || /^(my team|view|roster|more|\d+)$/i.test(name))) name = "";
    note(m[2], name || undefined);
  }
  if (sp.kind === "team" && sp.teamId) note(sp.teamId, findTeamName(root) || undefined);
  const my = findMyTeamId(root);
  if (my) note(my);
  const list = [...teams.entries()].map(([id, v]) => ({ id, ...(v.name ? { name: v.name } : {}) })).sort((a, b) => Number(a.id) - Number(b.id));
  return { leagueId: leagueId || null, myTeamId: my || null, teams: list };
}

/** A link on the page to /nba/<league>/<segment> (no query preferred), as an absolute URL, or null. Used to follow the site's own navigation. */
export function findLeagueLink(root, leagueId, segment, base) {
  let best = null;
  for (const a of root.querySelectorAll("a[href]")) {
    if (a.closest("[data-fdc-ignore]")) continue;
    const u = absUrl(a.getAttribute("href"), base);
    if (!u || !/fantasysports\.yahoo\.com$/i.test(u.hostname)) continue;
    if (u.pathname.replace(/\/$/, "") !== "/nba/" + leagueId + "/" + segment) continue;
    if (!u.search) return u.href;
    if (!best) best = u.href;
  }
  return best;
}
/** A link into the league whose visible text matches (e.g. "Standings" -> /nba/<league>?lhst=stand), as an absolute URL, or null. */
export function findLeagueLinkByText(root, leagueId, re, base) {
  for (const a of root.querySelectorAll("a[href]")) {
    if (a.closest("[data-fdc-ignore]") || !re.test((a.textContent || "").replace(/\s+/g, " ").trim())) continue;
    const u = absUrl(a.getAttribute("href"), base);
    if (u && /fantasysports\.yahoo\.com$/i.test(u.hostname) && new RegExp("^/nba/" + leagueId + "(/|$)").test(u.pathname)) return u.href;
  }
  return null;
}
export const findMatchupLink = (root, leagueId, base) => findLeagueLink(root, leagueId, "matchup", base);
export const findTransactionsLink = (root, leagueId, base) => findLeagueLink(root, leagueId, "transactions", base);

/** The page's own "next" link of a paged list: a link whose text starts with "Next" (or rel=next) on the same path; else the next higher `count`. */
export function findNextPageLink(root, currentHref) {
  const cur = absUrl(currentHref);
  if (!cur) return null;
  for (const a of root.querySelectorAll("a[href]")) {
    if (a.closest("[data-fdc-ignore]")) continue;
    const t = (a.textContent || "").replace(/\s+/g, " ").trim();
    if (!/^next\b/i.test(t) && a.getAttribute("rel") !== "next") continue;
    const u = absUrl(a.getAttribute("href"), cur);
    if (u && u.origin === cur.origin && u.pathname === cur.pathname && u.href !== cur.href) return u.href;
  }
  const curN = Number(cur.searchParams.get("count") || 0);
  const more = findSeasonPageLinks(root, currentHref).filter((l) => Number(new URL(l).searchParams.get("count")) > curN);
  return more[0] || null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** "Oct 20, 2026 9:30 pm", "Oct 20", "10/20/2026", "10/20" -> { date: "2026-10-20", time: "21:30"|null } | null. Missing years take `now`'s (minus one if that lands in the future). */
export function parseTxnDate(text, now = Date.now()) {
  const t = String(text || "");
  let mo;
  let d;
  let y;
  let m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?/i.exec(t);
  if (m) {
    mo = MONTHS[m[1].toLowerCase()];
    d = Number(m[2]);
    y = m[3] ? Number(m[3]) : undefined;
  } else if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t))) {
    mo = Number(m[1]);
    d = Number(m[2]);
    y = m[3] ? Number(m[3]) + (m[3].length === 2 ? 2000 : 0) : undefined;
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const nowD = new Date(now);
  if (y === undefined) {
    y = nowD.getUTCFullYear();
    if (Date.UTC(y, mo - 1, d) > now + 2 * 86400000) y -= 1;
  }
  const pad = (n) => String(n).padStart(2, "0");
  let time = null;
  const tm = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.exec(t.slice(m.index + m[0].length));
  if (tm) {
    let h = Number(tm[1]);
    if (tm[3]) h = (h % 12) + (tm[3].toLowerCase() === "pm" ? 12 : 0);
    time = pad(h) + ":" + tm[2];
  }
  return { date: y + "-" + pad(mo) + "-" + pad(d), time };
}

/**
 * Transactions page (best effort, structure based): one entry per row/list item that holds player links. Each player is classified by the text
 * around it ("Add"/"Added"/"+" -> add, "Drop"/"Dropped" -> drop, trade rows -> "trade" with the team the player went to), with the team link next to
 * it. Returns { rows: [{ key, date, time, type, actions: [{ action, yahooId, name, nbaTeam?, positions?, teamId?, teamName? }] }] }.
 */
export function parseSeasonTransactions(root, now = Date.now()) {
  const els = [];
  const trs = [...root.querySelectorAll("tr")].filter((tr) => !tr.closest("[data-fdc-ignore]") && !tr.querySelector("table") && tr.querySelector("a[href*='/nba/players/']"));
  els.push(...(trs.length ? trs : structuralRowEls(root)));
  const rows = [];
  const keys = new Set();
  for (const el of els) {
    const text = textLines(el).join(" ").replace(/\s+/g, " ").trim();
    const links = [];
    for (const a of el.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      const pm = /\/nba\/players\/(\d+)(?:[/?#]|$)/.exec(href);
      const t = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (pm && t.length >= 3 && !/^(new\s+)?player\s+notes?$/i.test(t)) links.push({ kind: "p", id: pm[1], name: t, a });
      else {
        const tm = TEAM_HREF_RE.exec(href);
        if (tm && t && !NAV_LABELS.test(t)) links.push({ kind: "t", id: tm[2], name: t, a });
      }
    }
    const players = links.filter((l) => l.kind === "p");
    if (!players.length) continue;
    const when = parseTxnDate(text, now);
    const trade = /\btrade[ds]?\b/i.test(text);
    const claim = /\bwaiver|\bclaim/i.test(text);
    const actions = [];
    // Segment of each player: from the previous player link to the next one (document order).
    const order = links;
    players.forEach((pl, pi) => {
      const prevP = pi > 0 ? order.indexOf(players[pi - 1]) : -1;
      const nextP = pi + 1 < players.length ? order.indexOf(players[pi + 1]) : order.length;
      const segLinks = order.slice(prevP + 1, nextP).filter((l) => l.kind === "t");
      // Text before the player link (back to the previous player link) decides the action.
      let before = "";
      let after = "";
      const idx = text.indexOf(pl.name);
      const prevEnd = pi > 0 ? text.indexOf(players[pi - 1].name) + players[pi - 1].name.length : 0;
      before = idx >= 0 ? text.slice(prevEnd, idx) : "";
      const nextStart = pi + 1 < players.length ? text.indexOf(players[pi + 1].name, Math.max(idx, 0) + pl.name.length) : text.length;
      after = idx >= 0 && nextStart >= 0 ? text.slice(idx + pl.name.length, nextStart) : "";
      const ctx = (before.slice(-24) + " | " + after).toLowerCase();
      let action = null;
      if (trade) action = "trade";
      else if (/\bdrop(ped|s)?\b/.test(before.slice(-14).toLowerCase()) || /(^|\s)[-−–]\s*$/.test(before)) action = "drop";
      else if (/\badd(ed|s)?\b/.test(before.slice(-14).toLowerCase()) || /(^|\s)\+\s*$/.test(before)) action = "add";
      else if (/\bdropped\b|\bdrop\b|\breleased\b/.test(ctx) && !/\badd/.test(ctx)) action = "drop";
      else if (/\badded\b|\badd\b|\bclaimed\b/.test(ctx)) action = "add";
      if (!action) return;
      const tp = parseTeamPos(after);
      const team = action === "trade" ? segLinks[segLinks.length - 1] : action === "add" ? segLinks[segLinks.length - 1] || order.filter((l) => l.kind === "t")[0] : segLinks[0] || order.filter((l) => l.kind === "t")[0];
      const act = { action, yahooId: pl.id, name: pl.name };
      if (tp) {
        act.nbaTeam = tp.nbaTeam;
        act.positions = tp.positions.split(",").join("/");
      }
      if (team) {
        act.teamId = team.id;
        act.teamName = team.name;
      }
      actions.push(act);
    });
    if (!actions.length) continue;
    const kinds = new Set(actions.map((a) => a.action));
    const type = kinds.has("trade") ? "trade" : kinds.has("add") && kinds.has("drop") ? "add/drop" : kinds.has("add") ? (claim ? "claim" : "add") : "drop";
    const key = [when ? when.date + (when.time ? "T" + when.time : "") : "?", ...actions.map((a) => a.action + ":" + a.yahooId + ":" + (a.teamId || a.teamName || "")).sort()].join("|");
    if (keys.has(key)) continue;
    keys.add(key);
    rows.push({ key, date: when ? when.date : null, time: when ? when.time : null, type, actions });
  }
  return { rows };
}

/** Roster/free-agent rows reduced to the fields the app accepts. */
export function slimSeasonRows(rows) {
  return rows.map((r) => ({ yahooId: r.yahooId, playerName: r.playerName, nbaTeam: r.nbaTeam, positions: r.positions, slot: r.slot, injuryTag: r.injuryTag, pctOwned: r.pctOwned, opp: r.opp, hasGame: r.hasGame, stats: r.stats }));
}

// ----------------------------------------------------------------------------- Season mode: autonomous league sync (read-only)

export const SYNC_DEFAULTS = {
  paceMs: 2500, // minimum gap between two requests to Yahoo
  jitterMs: 1500, // plus up to this much random extra
  maxRequests: 60, // hard budget per run
  maxFaPages: 20, // the whole available list (Yahoo shows 25 per page; stops at the last page)
  faEveryMs: 3 * 3600000, // the free-agent crawl runs when the stored list is older (or env.fullSync); teams/matchup/moves every run
  maxTxnPages: 3,
  autoEveryMs: 2 * 3600000, // automatic full sync when the last one is older
  retryAfterMs: 30 * 60000, // after an attempt (failed or not) wait this long before the next automatic one
  sampleEveryMs: 6 * 3600000, // one auto-saved sample per page kind per this long
  sampleMaxHtml: 1500000,
  sampleMaxText: 100000,
  lockTtlMs: 300000, // renewed on every progress step
  faPath: "/players?status=A&pos=P&sort=AR",
};

/** Automatic trigger rule: the last full sync (here or on the server) is older than autoEveryMs and no attempt was made recently. */
export function shouldAutoSync({ now, lastFullAt, lastAttemptAt, serverAt }, cfg = SYNC_DEFAULTS) {
  const full = Math.max(lastFullAt || 0, serverAt || 0);
  if (full && now - full < cfg.autoEveryMs) return false;
  if (lastAttemptAt && now - lastAttemptAt < cfg.retryAfterMs) return false;
  return true;
}

/** Once per page kind per sampleEveryMs. `store` is a plain { kind: timestamp } object (persisted by the caller). */
export function sampleAllowed(store, kind, now, cfg = SYNC_DEFAULTS) {
  const t = store && store[kind];
  return !(typeof t === "number" && now - t < cfg.sampleEveryMs);
}

export function isLoginRedirect(url) {
  try {
    const u = new URL(url);
    return !/(^|\.)fantasysports\.yahoo\.com$/i.test(u.hostname) || /\/(login|signin|sign-in)\b/i.test(u.pathname) || /login/i.test(u.hostname);
  } catch {
    return true;
  }
}

class SyncStop extends Error {}

/**
 * One read-only sync run. Everything environment-specific is injected (so the same code runs in the userscript and in tests):
 *   env.origin, env.doc, env.href           the page the user is on (seed for discovery)
 *   env.fetchPage(url) -> { status, url, text }   same-origin GET with credentials (never anything else)
 *   env.parseHtml(text) -> Document
 *   env.post(path, body) -> { status, body }      to the local app
 *   env.sleep(ms), env.now(), env.rand()
 *   env.lock = { acquire(): boolean, touch(), release() }          single flight across tabs
 *   env.samples = { allowed(kind): boolean, mark(kind), send(kind, url, html, text): Promise<boolean> }
 *   env.expectedTeams, env.onProgress(report)
 * Stops at the first HTTP error / login redirect / exhausted request budget. Returns the report (also POSTed to /api/season/sync-report).
 */
export async function runLeagueSync(env, cfgIn = {}) {
  const c = { ...SYNC_DEFAULTS, ...cfgIn };
  const rep = {
    startedAt: new Date(env.now()).toISOString(), finishedAt: null, complete: false, requests: 0, stopped: null, skipped: null, leagueId: null,
    parts: { discovery: { ok: false }, myTeam: { ok: false }, teams: { ok: 0, total: 0, failed: [] }, matchup: { ok: false }, fas: { ok: false, pages: 0, rows: 0 }, transactions: { ok: false, rows: 0 } },
    samples: [], notes: [],
  };
  const progress = () => env.onProgress && env.onProgress(rep);
  if (!env.lock.acquire()) {
    rep.skipped = "another tab is syncing";
    return rep;
  }
  let lastAt = 0;
  let lid = null;
  const get = async (url) => {
    const u = new URL(url, env.origin);
    if (u.origin !== new URL(env.origin).origin || !new RegExp("^/nba/" + lid + "(/|$)").test(u.pathname)) throw new SyncStop("refused to fetch outside the league: " + u.pathname);
    if (rep.requests >= c.maxRequests) throw new SyncStop("request budget used up (" + c.maxRequests + ")");
    if (rep.requests > 0) {
      const wait = lastAt + c.paceMs + env.rand() * c.jitterMs - env.now();
      await env.sleep(Math.max(c.paceMs * 0.5, wait));
    }
    env.lock.touch();
    rep.requests++;
    lastAt = env.now();
    let res;
    try {
      res = await env.fetchPage(u.href);
    } catch (e) {
      throw new SyncStop("network error: " + ((e && e.message) || e));
    }
    if (res.status >= 400) throw new SyncStop("HTTP " + res.status + " on " + u.pathname);
    if (isLoginRedirect(res.url || u.href)) throw new SyncStop("redirected to login (" + u.pathname + ")");
    progress();
    return { doc: env.parseHtml(res.text), text: res.text, url: res.url || u.href };
  };
  const sample = async (kind, page) => {
    if (!env.samples || !env.samples.allowed(kind)) return false;
    let html = page.text;
    if (html.length > c.sampleMaxHtml) html = html.slice(0, c.sampleMaxHtml) + "\n<!-- truncated -->";
    let ok = false;
    try {
      ok = await env.samples.send(kind, page.url, html, textLines(page.doc.body || page.doc).join("\n").slice(0, c.sampleMaxText));
    } catch {
      ok = false;
    }
    if (ok) {
      env.samples.mark(kind);
      if (!rep.samples.includes(kind)) rep.samples.push(kind);
    }
    return ok;
  };
  const postApp = async (path, body) => {
    const r = await env.post(path, body);
    if (r.status >= 400) {
      const e = new Error((r.body && r.body.error) || "app HTTP " + r.status);
      e.code = r.body && r.body.code;
      throw e;
    }
    return r.body;
  };

  try {
    // 1. discovery (no request needed when the current page has the nav)
    const d0 = discoverLeague(env.doc, env.href);
    lid = d0.leagueId;
    rep.leagueId = lid;
    if (!lid) throw new SyncStop("no league id on this page");
    const found = new Map(d0.teams.map((t) => [t.id, t.name]));
    let myId = d0.myTeamId;
    const merge = (d) => {
      for (const t of d.teams) if (!found.get(t.id)) found.set(t.id, t.name);
      myId = myId || d.myTeamId;
    };
    // Without a "My Team" link on this page, the league home shows it (and the standings with every team).
    if (!myId) {
      const std = findLeagueLinkByText(env.doc, lid, /^standings$/i, env.href);
      const url = std || env.origin + "/nba/" + lid;
      merge(discoverLeague((await get(url)).doc, url));
    }
    let known = [...found.keys()];
    try {
      const out = await postApp("/api/season/discover", { leagueId: lid, myTeamId: myId || undefined, teams: [...found.entries()].map(([id, name]) => ({ id, ...(name ? { name } : {}) })) });
      rep.parts.discovery = { ok: true, teams: found.size, mapped: out.mapped, unmapped: out.unmapped };
      for (const t of out.teams || []) if (t.yahooTeamId && !known.includes(t.yahooTeamId)) known.push(t.yahooTeamId);
      myId = myId || out.userTeamId || null;
      known.sort((a, b) => Number(a) - Number(b));
    } catch (e) {
      rep.parts.discovery = { ok: false, error: e.message };
      throw new SyncStop("app refused discovery: " + e.message);
    }
    if (!myId) throw new SyncStop("could not find your team id (no My Team link)");
    rep.parts.teams.total = known.filter((id) => id !== myId).length;
    progress();

    const rosterBody = (page, tid, mine) => {
      const r = parseSeasonRoster(page.doc);
      return { r, body: { url: page.url, teamName: r.teamName || undefined, teamId: tid, mine, players: slimSeasonRows(r.rows) } };
    };
    const syncTeam = async (tid, mine) => {
      const page = await get(env.origin + "/nba/" + lid + "/" + tid);
      const { r, body } = rosterBody(page, tid, mine);
      if (!r.rows.length) {
        await sample("roster", page);
        return { page, ok: false, reason: "no player rows found" };
      }
      try {
        const out = await postApp("/api/season/roster", body);
        return { page, ok: true, out, count: r.rows.length };
      } catch (e) {
        return { page, ok: false, reason: e.message };
      }
    };

    // 2. my team
    const mine = await syncTeam(myId, true);
    rep.parts.myTeam = mine.ok ? { ok: true, count: mine.count, matched: mine.out.matched, added: mine.out.added.length, dropped: mine.out.dropped.length } : { ok: false, error: mine.reason };
    progress();
    {
      // Your team page carries the team switcher (every team's id and name): complete the mapping now.
      const d2 = discoverLeague(mine.page.doc, mine.page.url);
      const fresh = d2.teams.filter((t) => !known.includes(t.id));
      for (const t of d2.teams) if (!known.includes(t.id)) known.push(t.id);
      if (fresh.length || d2.teams.some((t) => t.name && !found.get(t.id))) {
        for (const t of d2.teams) if (t.name && !found.get(t.id)) found.set(t.id, t.name);
        try {
          const out = await postApp("/api/season/discover", { leagueId: lid, myTeamId: myId, teams: [...found.entries()].map(([id, name]) => ({ id, ...(name ? { name } : {}) })) });
          rep.parts.discovery = { ok: true, teams: found.size, mapped: out.mapped, unmapped: out.unmapped };
        } catch {
          /* keep the first mapping */
        }
      }
      known.sort((a, b) => Number(a) - Number(b));
      rep.parts.teams.total = known.filter((id) => id !== myId).length;
    }

    // 3. matchup: the link on the page, else the standard path
    {
      const link = findMatchupLink(mine.page.doc, lid, mine.page.url) || env.origin + "/nba/" + lid + "/matchup";
      const page = await get(link);
      const m = parseSeasonMatchup(page.doc, lid);
      if (!m.found) {
        await sample("matchup", page);
        rep.parts.matchup = { ok: false, error: "no category totals found" };
      } else {
        try {
          const out = await postApp("/api/season/matchup", { url: page.url, week: m.week, teams: m.teams });
          rep.parts.matchup = { ok: !!out.stored, opp: out.opp, week: out.week, layout: m.layout, ...(out.stored ? {} : { error: out.ignored }) };
        } catch (e) {
          rep.parts.matchup = { ok: false, error: e.message };
        }
      }
      progress();
    }

    // 4. available players (the page's own "next" links, <= maxFaPages); skipped when the stored list is fresh (light run)
    const faFresh = !env.fullSync && env.lastFaAt && env.now() - Date.parse(env.lastFaAt) < c.faEveryMs;
    if (faFresh) {
      rep.parts.fas = { ok: true, pages: 0, rows: 0, skipped: "list fresh" };
      progress();
    } else {
      let url = env.origin + "/nba/" + lid + c.faPath;
      const seen = new Set();
      while (url && !seen.has(url) && rep.parts.fas.pages < c.maxFaPages) {
        seen.add(url);
        const page = await get(url);
        const rows = parseSeasonPlayers(page.doc).rows;
        if (!rows.length) {
          if (!rep.parts.fas.pages) await sample("players", page);
          if (!rep.parts.fas.pages) rep.parts.fas.error = "no player rows found";
          break;
        }
        try {
          await postApp("/api/season/free-agents", { url: page.url, players: slimSeasonRows(rows).slice(0, 300) });
          rep.parts.fas.pages++;
          rep.parts.fas.rows += rows.length;
          rep.parts.fas.ok = true;
        } catch (e) {
          rep.parts.fas.error = e.message;
          break;
        }
        url = findNextPageLink(page.doc, page.url);
        progress();
      }
    }

    // 5. transactions (adds/drops so far)
    {
      const link = findTransactionsLink(mine.page.doc, lid, mine.page.url) || env.origin + "/nba/" + lid + "/transactions";
      let url = link;
      const seen = new Set();
      let pages = 0;
      const all = [];
      let first = null;
      while (url && !seen.has(url) && pages < c.maxTxnPages) {
        seen.add(url);
        const page = await get(url);
        first = first || page;
        const rows = parseSeasonTransactions(page.doc, env.now()).rows;
        pages++;
        if (!rows.length) break;
        all.push(...rows);
        url = findNextPageLink(page.doc, page.url);
      }
      if (!all.length) {
        if (first) await sample("transactions", first);
        rep.parts.transactions = { ok: false, rows: 0, error: "no transactions found (none yet, or parser needs update)" };
      } else {
        try {
          const out = await postApp("/api/season/transactions", { url: first.url, rows: all.slice(0, 400) });
          rep.parts.transactions = { ok: true, rows: all.length, inserted: out.inserted, applied: out.applied };
        } catch (e) {
          rep.parts.transactions = { ok: false, rows: all.length, error: e.message };
        }
      }
      progress();
    }

    // 6. every other team's roster (authoritative for who is on whom)
    for (const tid of known) {
      if (tid === myId) continue;
      const r = await syncTeam(tid, false);
      if (r.ok) rep.parts.teams.ok++;
      else rep.parts.teams.failed.push({ id: tid, error: r.reason });
      progress();
    }
  } catch (e) {
    if (e instanceof SyncStop) rep.stopped = e.message;
    else rep.stopped = "error: " + ((e && e.message) || e);
  } finally {
    env.lock.release();
  }
  rep.finishedAt = new Date(env.now()).toISOString();
  rep.complete = !rep.stopped && rep.parts.myTeam.ok && rep.parts.teams.failed.length === 0;
  try {
    await env.post("/api/season/sync-report", rep);
  } catch {
    /* the report is informational */
  }
  progress();
  return rep;
}
