import type { NewsItem } from "./types";
import { parseRssDate, stripTags, xmlTag } from "./text";

/** Generic RSS 2.0 parser. Items without a title, link or parseable date are skipped; throws when there is no <item> at all. */
export function parseRss(xml: string, source: string, opts: { nameFromTitlePrefix?: boolean } = {}): NewsItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi);
  if (!blocks) throw new Error("not an RSS feed (no <item> elements)");
  const out: NewsItem[] = [];
  for (const b of blocks) {
    const title = xmlTag(b, "title");
    const link = xmlTag(b, "link");
    const publishedAt = parseRssDate(xmlTag(b, "pubDate"));
    if (!title || !link || !publishedAt) continue;
    const desc = xmlTag(b, "description");
    const item: NewsItem = { title: stripTags(title), link: link.replace("rotowire.com//", "rotowire.com/"), source, publishedAt };
    if (desc) item.summary = stripTags(desc).slice(0, 600);
    if (opts.nameFromTitlePrefix) {
      // RotoWire: "Sandro Mamukelashvili: Scores 15 points ..."
      const m = /^([^:]{3,40}):\s/.exec(item.title);
      if (m) item.playerName = m[1];
    }
    out.push(item);
  }
  return out;
}
