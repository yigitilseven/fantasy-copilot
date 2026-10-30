/** Formatting shared by the Copilot screens (numbers are shown in mono, deltas in pp). */

export const CATS = ["FG%", "FT%", "3PM", "PTS", "REB", "AST", "STL", "BLK", "TO"] as const;

export const pct = (x: number) => `${Math.round(x * 100)}%`;
/** 0.052 -> "+5.2pp" */
export const pp = (x: number, unit = "pp") => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}${unit}`;
/** Category value: .466 for percentages, 58.5 / 574 otherwise. */
export const catVal = (cat: string, v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return "–";
  if (cat === "FG%" || cat === "FT%") return v.toFixed(3).replace(/^0/, "");
  return Math.abs(v) >= 100 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1);
};

/** "12 min ago", "3 h ago", "2 d ago"; "never" without a date. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export const agoMs = (ms: number | null | undefined) => (ms == null ? "never" : ago(new Date(Date.now() - ms).toISOString()));

/** "2026-10-27" -> "Tue, Oct 27" */
export function dayLabel(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  if (!y) return d;
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
/** "2026-10-26".."2026-11-01" -> "Oct 26–Nov 1" */
export function rangeLabel(a: string, b: string): string {
  const f = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const [fa, fb] = [f(a), f(b)];
  return fa.split(" ")[0] === fb.split(" ")[0] ? `${fa}–${fb.split(" ")[1]}` : `${fa}–${fb}`;
}

export const initials = (name: string) => {
  const p = name.replace(/\b(Jr|Sr|II|III|IV)\.?$/i, "").trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
};

/** Category outcome by the chance to win it: won ≥85%, swing 35–65%, lost ≤15% (design system legend). */
export type CatTone = "pos" | "warn" | "neg" | "neutral";
export function catTone(raw: number): CatTone {
  const p = Math.round(raw * 100) / 100; // follow the percentage shown
  if (p >= 0.85) return "pos";
  if (p <= 0.15) return "neg";
  if (p >= 0.35 && p <= 0.65) return "warn";
  return "neutral";
}
export const catWord = (raw: number, p = Math.round(raw * 100) / 100) => (p >= 0.85 ? "Won" : p <= 0.15 ? "Lost" : p >= 0.35 && p <= 0.65 ? "Swing" : p > 0.65 ? "Lean win" : "Lean loss");
