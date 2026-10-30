import { NAME_ALIASES, nameKey, normalizeName } from "../projections/names";
import type { NewsItem } from "./types";

export interface MatchPlayer { id: string; name: string }

/** All normalized spellings that identify a player in free text (own name + alias variants of his canonical key). */
function keysFor(name: string): string[] {
  const canon = nameKey(name);
  const keys = new Set<string>([normalizeName(name), canon]);
  for (const [variant, target] of Object.entries(NAME_ALIASES)) if (target === canon) keys.add(variant);
  return [...keys].filter((k) => k.split(" ").length >= 2);
}

export interface NameMatcher {
  /** Player ids named in `text` by full name or a unique "F. Last". */
  match(text: string): string[];
  /** Player id for an explicit name (injury report row, "Name:" prefix); null if unknown/ambiguous. */
  byName(name: string): string | null;
}

/**
 * Deterministic name matching. Full names (alias-aware, accents/suffixes/possessives normalized) always match;
 * "F. Last" matches only when initial+last name is unique among our players, so common surnames never fire alone.
 */
export function buildNameMatcher(players: MatchPlayer[]): NameMatcher {
  const full = new Map<string, Set<string>>();
  const initialLast = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, id: string) => (m.get(k) ?? m.set(k, new Set()).get(k)!).add(id);
  for (const p of players) {
    for (const k of keysFor(p.name)) add(full, k, p.id);
    const parts = nameKey(p.name).split(" ");
    if (parts.length >= 2) add(initialLast, `${parts[0][0]} ${parts[parts.length - 1]}`, p.id);
  }
  const maxWords = Math.max(2, ...[...full.keys()].map((k) => k.split(" ").length));
  const norm = (s: string) => normalizeName(s.replace(/['’]s\b/g, ""));

  return {
    byName(name) {
      const ids = full.get(normalizeName(name)) ?? full.get(nameKey(name));
      return ids && ids.size === 1 ? [...ids][0] : null;
    },
    match(text) {
      const found = new Set<string>();
      const toks = norm(text).split(" ").filter(Boolean);
      for (let i = 0; i < toks.length; i++) {
        for (let n = 2; n <= Math.min(maxWords, toks.length - i); n++) {
          const ids = full.get(toks.slice(i, i + n).join(" "));
          if (ids && ids.size === 1) found.add([...ids][0]);
        }
      }
      for (const m of text.matchAll(/\b([A-Z])\.\s?([A-Z][A-Za-z'’-]+(?:\s(?:Jr|Sr)\.?)?)/g)) {
        const last = normalizeName(m[2]).split(" ").pop() ?? "";
        const ids = initialLast.get(`${m[1].toLowerCase()} ${last}`);
        if (ids && ids.size === 1) found.add([...ids][0]);
      }
      return [...found];
    },
  };
}

/** Player ids a news item belongs to: the explicit playerName if it resolves, plus every full-name mention in title/summary. */
export function matchNewsItem(matcher: NameMatcher, item: NewsItem): string[] {
  const ids = new Set<string>();
  if (item.playerName) {
    const id = matcher.byName(item.playerName);
    if (id) ids.add(id);
  }
  for (const id of matcher.match(`${item.title}. ${item.summary ?? ""}`)) ids.add(id);
  return [...ids];
}
