/** Small text helpers shared by the news parsers (no XML/HTML dependency). */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Inner text of <tag> (CDATA unwrapped, entities decoded, whitespace collapsed); null when absent. */
export function xmlTag(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!m) return null;
  let v = m[1].trim();
  const cd = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  v = cd ? cd[1] : decodeEntities(v);
  return v.replace(/\s+/g, " ").trim();
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const TZ_OFFSET_H: Record<string, number> = { UTC: 0, GMT: 0, Z: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7 };

/**
 * RSS date -> ISO. Handles RFC 822 ("Wed, 07 Oct 2026 14:20:10 +0000") and RotoWire's
 * "Tue, 06 Oct 2026 9:44:00 PM PDT". Null when unparseable.
 */
export function parseRssDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*([+-]\d{4}|[A-Z]{1,4})?/.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  let hour = Number(m[4]);
  if (m[7]) {
    const pm = m[7].toLowerCase() === "pm";
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  let offsetMin = 0;
  const tz = m[8];
  if (tz) {
    if (/^[+-]\d{4}$/.test(tz)) offsetMin = (tz[0] === "-" ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
    else if (tz in TZ_OFFSET_H) offsetMin = TZ_OFFSET_H[tz] * 60;
  }
  const ms = Date.UTC(Number(m[3]), mon, Number(m[1]), hour, Number(m[5]), Number(m[6] ?? 0)) - offsetMin * 60_000;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** "Oct 7" / "Wed, Oct 7" style (no year) -> YYYY-MM-DD, choosing the year nearest to `ref` (within ~ +-6 months). */
export function monthDayToIso(text: string, ref: Date): string | null {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/.exec(text);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon === undefined) return null;
  const day = Number(m[2]);
  let best: number | null = null;
  for (const y of [ref.getUTCFullYear() - 1, ref.getUTCFullYear(), ref.getUTCFullYear() + 1]) {
    const t = Date.UTC(y, mon, day);
    if (best === null || Math.abs(t - ref.getTime()) < Math.abs(best - ref.getTime())) best = t;
  }
  return new Date(best!).toISOString().slice(0, 10);
}

/** "Jan 2" -> first YYYY-MM-DD on/after `notBefore` (YYYY-MM-DD); an estimated return is never before the report date. */
export function returnDateAfter(text: string, notBefore: string): string | null {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/.exec(text);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon === undefined) return null;
  const y0 = Number(notBefore.slice(0, 4));
  for (const y of [y0, y0 + 1]) {
    const iso = new Date(Date.UTC(y, mon, Number(m[2]))).toISOString().slice(0, 10);
    if (iso >= notBefore) return iso;
  }
  return null;
}
