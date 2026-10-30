import type { InjuryStatus } from "../../types";

/** One player's injury line as reported by one source (names are NOT yet matched to the DB). */
export interface StatusReport {
  name: string;
  team?: string;
  status: InjuryStatus;
  /** Injury text ("Knee"). */
  injury: string | null;
  /** ISO date YYYY-MM-DD. */
  estReturn: string | null;
  comment: string | null;
  source: string;
  /** ISO timestamp (date-only sources: midnight UTC); null when the source gives no date. */
  reportedAt: string | null;
}

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  /** ISO timestamp. */
  publishedAt: string;
  /** Short body used for name matching. */
  summary?: string;
  /** Set when the source names the player explicitly (RotoWire "Name: headline", ESPN injury notes). */
  playerName?: string;
}

export interface ProviderResult {
  reports: StatusReport[];
  news: NewsItem[];
}

export interface NewsProvider {
  /** Stable id, also the source label stored in news_source_status ("espn-injuries", "yahoo-rss", ...). */
  id: string;
  kind: "injuries" | "news";
  /** Human label stored on rows ("ESPN", "Yahoo Sports"). */
  label: string;
  url: string;
  ext: "json" | "html" | "xml";
  headers?: Record<string, string>;
  /** Pure parser; throws on an unrecognizable response. `now` is used to infer missing years. */
  parse(text: string, now: Date): ProviderResult;
}
