/** Name matching across NBA.com / Basketball-Reference / FantasyPros / Hashtag / existing CSV. */

/** normalized variant → canonical normalized name. Applied after normalizeName(). */
export const NAME_ALIASES: Record<string, string> = {
  "nicolas claxton": "nic claxton",
  "herbert jones": "herb jones",
  "alexandre sarr": "alex sarr",
  "cameron thomas": "cam thomas",
  "cameron johnson": "cam johnson",
  "cameron whitmore": "cam whitmore",
  "kenyon martin": "kj martin",
  "carlton carrington": "bub carrington",
  "nahshon hyland": "bones hyland",
  "moritz wagner": "moe wagner",
  "mohamed bamba": "mo bamba",
  "nazreon reid": "naz reid",
  "luguentz dort": "lu dort",
  "lugentz dort": "lu dort",
  "santiago aldama": "santi aldama",
  "zachary lavine": "zach lavine",
  "ronald holland": "ron holland",
  "nicolas batum": "nic batum",
  "alexander sarr": "alex sarr",
  "gregory jackson": "gg jackson",
  "vincent williams": "vince williams",
};

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/** "Jaren Jackson Jr." → "jaren jackson"; "Luka Dončić" → "luka doncic"; "Shai Gilgeous-Alexander" → "shai gilgeous alexander". */
export function normalizeName(name: string): string {
  const parts = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (parts.length > 2 && SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  if (parts.length === 2 && SUFFIXES.has(parts[1])) parts.pop();
  return parts.join(" ");
}

/** Matching key: normalized name with nickname aliases resolved. */
export function nameKey(name: string): string {
  const n = normalizeName(name);
  return NAME_ALIASES[n] ?? n;
}
