/**
 * Public ADP tables → { name, team, positions, adp }. Dependency-free regex parsing.
 *  - FantasyPros  https://www.fantasypros.com/nba/adp/overall.php  (columns: Rank, Player (TEAM - POS), Yahoo, ESPN, AVG)
 *  - Hashtag      https://hashtagbasketball.com/fantasy-basketball-adp (per-site ADP in data-yadp / data-madp attributes)
 *  - CSV          user-saved: headers name|player, adp|yahoo|yahoo_adp|avg, optional team, pos|positions
 * "Yahoo ADP" is the Yahoo column when present, else the site's average (`usedAverage` = true).
 */
import { parseCsv } from "./csv";
import type { Position } from "../../types";

export interface AdpEntry {
  name: string;
  team: string | null;
  /** Eligibility parsed from the site (PG/SG/SF/PF/C only), source order. */
  positions: Position[];
  adp: number;
  usedAverage: boolean;
  /** 0-based order on the page. */
  order: number;
}

export type AdpSourceName = "fantasypros" | "hashtag" | "file";

export const FANTASYPROS_URL = "https://www.fantasypros.com/nba/adp/overall.php";
export const HASHTAG_URL = "https://hashtagbasketball.com/fantasy-basketball-adp";

const POS_SET = new Set(["PG", "SG", "SF", "PF", "C"]);
const CANON: Position[] = ["PG", "SG", "SF", "PF", "C"];

/** "PG,SF,SG" / "PF-C" / "G/F" → eligible Position[] in canonical order (G/F expand to PG,SG / SF,PF). */
export function parsePositionList(raw: string): Position[] {
  const set = new Set<string>();
  for (const t of raw.toUpperCase().split(/[^A-Z]+/).filter(Boolean)) {
    if (POS_SET.has(t)) set.add(t);
    else if (t === "G") (["PG", "SG"] as const).forEach((x) => set.add(x));
    else if (t === "F") (["SF", "PF"] as const).forEach((x) => set.add(x));
  }
  return CANON.filter((p) => set.has(p));
}

const decode = (s: string) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const numOrNull = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.trim();
  if (!t || t === "-" || t === "--") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function parseFantasyProsAdp(html: string): AdpEntry[] {
  const out: AdpEntry[] = [];
  const tbody = html.slice(Math.max(0, html.indexOf('id="data"')));
  // FantasyPros leaves <tr> unclosed; split on row starts.
  const rows = tbody.split(/<tr[\s>]/).slice(1);
  for (const row of rows) {
    const nameM = /<a[^>]*class="[^"]*player-name[^"]*"[^>]*>([^<]+)<\/a>\s*(?:<small>\(([^)]*)\)<\/small>)?/.exec(row);
    if (!nameM) continue;
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decode(m[1]));
    // tds: [rank, "Name (TEAM - POS)", yahoo, espn, avg] — rank first, then player cell, then ADP columns.
    const nums = tds.slice(2);
    const yahoo = numOrNull(nums[0]);
    const avg = numOrNull(nums[2]);
    const adp = yahoo ?? avg;
    if (adp === null) continue;
    const meta = (nameM[2] ?? "").split("-").map((x) => x.trim());
    out.push({
      name: decode(nameM[1]),
      team: meta[0] && /^[A-Za-z]{2,4}$/.test(meta[0]) ? meta[0].toUpperCase() : null,
      positions: parsePositionList(meta.slice(1).join(" ")),
      adp,
      usedAverage: yahoo === null,
      order: out.length,
    });
  }
  return out;
}

export function parseHashtagAdp(html: string): AdpEntry[] {
  const out: AdpEntry[] = [];
  const seen = new Set<string>();
  const re = /<tr\s+data-madp='([^']*)'\s+data-yadp='([^']*)'[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tds = [...m[3].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)];
    if (tds.length < 2) continue;
    const name = decode(/<a[^>]*d-sm-inline[^>]*>([^<]+)<\/a>/.exec(tds[0][2])?.[1] ?? tds[0][2]);
    if (!name || seen.has(name)) continue;
    const yahoo = numOrNull(m[2]);
    const avg = numOrNull(m[1]);
    const adp = yahoo ?? avg;
    if (adp === null) continue;
    seen.add(name);
    const posCell = tds.find((t) => /adp-pos-col/.test(t[1]) && /adp-col-y/.test(t[1]));
    const team = decode(tds[1][2]);
    out.push({
      name,
      team: /^[A-Za-z]{2,4}$/.test(team) ? team.toUpperCase() : null,
      positions: parsePositionList(posCell ? [...posCell[2].matchAll(/pos-pill__seg[^>]*>([^<]+)</g)].map((x) => x[1]).join(" ") : ""),
      adp,
      usedAverage: yahoo === null,
      order: out.length,
    });
  }
  return out.sort((a, b) => a.adp - b.adp).map((e, i) => ({ ...e, order: i }));
}

const CSV_NAME = ["name", "player", "player_name"];
const CSV_ADP = ["yahoo_adp", "yahoo", "adp", "avg", "average"];

export function parseAdpCsv(text: string): AdpEntry[] {
  const out: AdpEntry[] = [];
  for (const r0 of parseCsv(text)) {
    const r = Object.fromEntries(Object.entries(r0).map(([k, v]) => [k.trim().toLowerCase(), v]));
    const name = CSV_NAME.map((k) => r[k]).find(Boolean);
    const adpKey = CSV_ADP.find((k) => numOrNull(r[k]) !== null);
    if (!name || !adpKey) continue;
    out.push({
      name,
      team: (r.team ?? r.nba_team ?? "").toUpperCase() || null,
      positions: parsePositionList(r.pos ?? r.positions ?? ""),
      adp: numOrNull(r[adpKey])!,
      usedAverage: adpKey === "avg" || adpKey === "average",
      order: out.length,
    });
  }
  return out.sort((a, b) => a.adp - b.adp).map((e, i) => ({ ...e, order: i }));
}

/** Detects the format of a user-saved file (HTML from either site, or CSV) and parses it. */
export function parseAdpFile(text: string): { source: AdpSourceName; entries: AdpEntry[] } {
  if (/data-yadp=/.test(text)) return { source: "hashtag", entries: parseHashtagAdp(text) };
  if (/player-name|fp-player-link/.test(text)) return { source: "fantasypros", entries: parseFantasyProsAdp(text) };
  return { source: "file", entries: parseAdpCsv(text) };
}
