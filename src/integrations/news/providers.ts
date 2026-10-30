/**
 * Injury + news providers. Every parser is pure (text in, structured rows out) and fixture-tested; fetching, caching and
 * failure handling live in fetch.ts / update.ts.
 *
 * Probed 2026-10-07:  ESPN injuries JSON API ok | CBS injuries HTML ok | RotoWire injury JSON ok (return dates are paywalled)
 *   Yahoo RSS ok (https://sports.yahoo.com/nba/rss.xml) | CBS RSS ok | RotoWire RSS ok (5 items) | ESPN news JSON API ok
 *   espn.com/nba/injuries and espn.com/espn/rss/nba/news are behind a CloudFront WAF challenge (HTTP 202, empty) -> not used.
 */
import { returnsAfterSeason } from "../../engine/risk/calendar";
import type { InjuryStatus } from "../../types";
import { parseRss } from "./rss";
import { decodeEntities, monthDayToIso, returnDateAfter, stripTags } from "./text";
import type { NewsItem, NewsProvider, StatusReport } from "./types";

const SEASON_ENDING = /season-ending(?! surgery)|out for (?:the )?(?:rest of the |remainder of the )?season|miss(?:es)? the (?:rest|remainder) of the (?:\d{4}-\d{2} )?season|miss(?:es)? the (?:entire )?\d{4}-\d{2} season|done for the season|ruled out for the season/i;

export function seasonEndingText(s: string | null | undefined): boolean {
  return !!s && SEASON_ENDING.test(s);
}

/** Fits a raw status + return date into our 4 statuses. */
function classifyStatus(raw: string, estReturn: string | null, texts: (string | null | undefined)[]): InjuryStatus {
  const r = raw.toLowerCase();
  if (/season/.test(r) && /(out|ofs)/.test(r)) return "out-for-season";
  if (r === "ofs") return "out-for-season";
  if (/^out|suspen|inactive/.test(r) || r === "o") {
    if (texts.some(seasonEndingText) || (estReturn && returnsAfterSeason(estReturn))) return "out-for-season";
    return "out";
  }
  return "day-to-day"; // day-to-day, questionable, doubtful, probable, game time decision, ...
}

// ---------------------------------------------------------------- ESPN injuries JSON API

export const ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries";

interface EspnNote { headline?: string; text?: string; date?: string; source?: string }
interface EspnInjury {
  status?: string; date?: string; shortComment?: string; longComment?: string;
  athlete?: { displayName?: string; links?: { rel?: string[]; href?: string }[]; notes?: { items?: EspnNote[] } };
  details?: { type?: string; detail?: string; returnDate?: string; fantasyStatus?: { abbreviation?: string } };
}

export function parseEspnInjuries(text: string): { reports: StatusReport[]; news: NewsItem[] } {
  const j = JSON.parse(text) as { injuries?: { displayName?: string; injuries?: EspnInjury[] }[] };
  if (!j || !Array.isArray(j.injuries)) throw new Error("not an ESPN injuries response (no injuries[])");
  const reports: StatusReport[] = [];
  const news: NewsItem[] = [];
  for (const team of j.injuries) {
    for (const i of team.injuries ?? []) {
      const name = i.athlete?.displayName;
      if (!name || !i.status) continue;
      const estReturn = i.details?.returnDate && /^\d{4}-\d{2}-\d{2}$/.test(i.details.returnDate) ? i.details.returnDate : null;
      const comment = i.shortComment ?? null;
      let status = classifyStatus(i.status, estReturn, [i.shortComment]);
      if (i.details?.fantasyStatus?.abbreviation === "OFS") status = "out-for-season";
      const injury = [i.details?.type, i.details?.detail].filter(Boolean).join(" – ") || null;
      const reportedAt = i.date && !Number.isNaN(Date.parse(i.date)) ? new Date(i.date).toISOString() : null;
      reports.push({ name, team: team.displayName, status, injury, estReturn, comment, source: "ESPN", reportedAt });
      const note = i.athlete?.notes?.items?.[0];
      const link = i.athlete?.links?.find((l) => l.rel?.includes("playercard") && l.rel.includes("desktop"))?.href;
      if (reportedAt && link && (note?.headline ?? i.shortComment)) {
        news.push({ title: (note?.headline ?? i.shortComment)!, link, source: "ESPN", publishedAt: reportedAt, summary: i.longComment, playerName: name });
      }
    }
  }
  return { reports, news };
}

// ---------------------------------------------------------------- CBS injuries HTML

export const CBS_INJURIES_URL = "https://www.cbssports.com/nba/injuries/";

export function parseCbsInjuries(html: string, now: Date): { reports: StatusReport[]; news: NewsItem[] } {
  const rows = html.match(/<tr class="TableBase-bodyTr">[\s\S]*?<\/tr>/g);
  if (!rows) throw new Error("not a CBS injuries page (no TableBase-bodyTr rows)");
  const reports: StatusReport[] = [];
  for (const row of rows) {
    const long = /CellPlayerName--long[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/.exec(row)?.[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]));
    if (!long || cells.length < 5) continue;
    const name = stripTags(long);
    const updated = monthDayToIso(cells[2], now); // "Wed, Oct 7"
    const reportedAt = updated ? `${updated}T00:00:00.000Z` : null;
    const statusText = cells[4];
    let estReturn: string | null = null;
    const until = /out until (?:at least )?(.+)$/i.exec(statusText);
    if (until && updated) estReturn = returnDateAfter(until[1], updated);
    const status = classifyStatus(/out for the season/i.test(statusText) ? "Out for the season" : /expected to be out|^out/i.test(statusText) ? "Out" : statusText, estReturn, [statusText]);
    reports.push({ name, team: undefined, status, injury: cells[3] || null, estReturn, comment: statusText || null, source: "CBS", reportedAt });
  }
  if (rows.length > 0 && reports.length === 0) throw new Error("CBS injuries rows found but none parsed (layout changed?)");
  return { reports, news: [] };
}

// ---------------------------------------------------------------- RotoWire injuries JSON

export const ROTOWIRE_INJURIES_URL = "https://www.rotowire.com/basketball/tables/injury-report.php?team=ALL&pos=ALL";

interface RwRow { player?: string; team?: string; injury?: string; status?: string; rDate?: string }

export function parseRotowireInjuries(text: string): { reports: StatusReport[]; news: NewsItem[] } {
  const rows = JSON.parse(text) as RwRow[];
  if (!Array.isArray(rows)) throw new Error("not a RotoWire injury table (expected a JSON array)");
  const reports: StatusReport[] = [];
  for (const r of rows) {
    if (!r.player || !r.status) continue;
    const dateStr = r.rDate ? decodeEntities(r.rDate.replace(/<[^>]*>/g, "")).trim() : "";
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : null; // paywalled: "Subscribers Only"
    const status = classifyStatus(r.status, iso, []);
    const note = r.injury && r.injury !== "Not Injury Related" ? r.injury : null;
    reports.push({ name: r.player, team: r.team, status, injury: note, estReturn: iso, comment: r.status, source: "RotoWire", reportedAt: null });
  }
  return { reports, news: [] };
}

// ---------------------------------------------------------------- news

export const YAHOO_RSS_URLS = ["https://sports.yahoo.com/nba/rss.xml", "https://sports.yahoo.com/nba/rss/"];
export const CBS_RSS_URL = "https://www.cbssports.com/rss/headlines/nba/";
export const ROTOWIRE_RSS_URL = "https://www.rotowire.com/rss/news.php?sport=NBA";
export const ESPN_NEWS_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=50";

export function parseEspnNews(text: string): NewsItem[] {
  const j = JSON.parse(text) as { articles?: { headline?: string; description?: string; published?: string; links?: { web?: { href?: string } }; categories?: { type?: string; description?: string }[] }[] };
  if (!j || !Array.isArray(j.articles)) throw new Error("not an ESPN news response (no articles[])");
  const out: NewsItem[] = [];
  for (const a of j.articles) {
    const link = a.links?.web?.href;
    if (!a.headline || !link || !a.published || Number.isNaN(Date.parse(a.published))) continue;
    const athletes = (a.categories ?? []).filter((c) => c.type === "athlete" && c.description).map((c) => c.description);
    out.push({ title: a.headline, link, source: "ESPN", publishedAt: new Date(a.published).toISOString(), summary: [a.description, ...athletes].filter(Boolean).join(" ") });
  }
  return out;
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};
export const NEWS_HEADERS = BROWSER_HEADERS;

export const PROVIDERS: NewsProvider[] = [
  { id: "espn-injuries", kind: "injuries", label: "ESPN", url: ESPN_INJURIES_URL, ext: "json", headers: { ...BROWSER_HEADERS, Accept: "application/json" }, parse: (t) => parseEspnInjuries(t) },
  { id: "cbs-injuries", kind: "injuries", label: "CBS", url: CBS_INJURIES_URL, ext: "html", headers: { ...BROWSER_HEADERS, Accept: "text/html" }, parse: (t, now) => parseCbsInjuries(t, now) },
  { id: "rotowire-injuries", kind: "injuries", label: "RotoWire", url: ROTOWIRE_INJURIES_URL, ext: "json", headers: { ...BROWSER_HEADERS, Accept: "application/json" }, parse: (t) => parseRotowireInjuries(t) },
  { id: "yahoo-rss", kind: "news", label: "Yahoo Sports", url: YAHOO_RSS_URLS[0], ext: "xml", headers: BROWSER_HEADERS, parse: (t) => ({ reports: [], news: parseRss(t, "Yahoo Sports") }) },
  { id: "espn-news", kind: "news", label: "ESPN", url: ESPN_NEWS_URL, ext: "json", headers: { ...BROWSER_HEADERS, Accept: "application/json" }, parse: (t) => ({ reports: [], news: parseEspnNews(t) }) },
  { id: "cbs-rss", kind: "news", label: "CBS Sports", url: CBS_RSS_URL, ext: "xml", headers: BROWSER_HEADERS, parse: (t) => ({ reports: [], news: parseRss(t, "CBS Sports") }) },
  { id: "rotowire-rss", kind: "news", label: "RotoWire", url: ROTOWIRE_RSS_URL, ext: "xml", headers: BROWSER_HEADERS, parse: (t) => ({ reports: [], news: parseRss(t, "RotoWire", { nameFromTitlePrefix: true }) }) },
];
