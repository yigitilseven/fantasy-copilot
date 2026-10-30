/** Pure scheduling helpers for the scheduler and the browser worker: timezone-aware clock times, jitter, daily caps, quiet hours. */

export function parseHHMM(s: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? { h, m: mi } : null;
}

interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number }

export function zonedParts(ms: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/** Local calendar day "YYYY-MM-DD" in `tz`. */
export function localDay(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

const offsetAt = (ms: number, tz: string) => {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
};

/** UTC ms of local wall-clock y-mo-d h:m in `tz` (DST gaps resolve forward). */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}

/** The next instant strictly after `nowMs` at which the clock in `tz` reads `hhmm`. */
export function nextDailyAt(nowMs: number, hhmm: string, tz: string): number {
  const t = parseHHMM(hhmm);
  if (!t) throw new Error(`bad time "${hhmm}" (use HH:MM)`);
  const p = zonedParts(nowMs, tz);
  let at = zonedToUtc(p.y, p.mo, p.d, t.h, t.m, tz);
  if (at <= nowMs) {
    const n = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
    at = zonedToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), t.h, t.m, tz);
  }
  return at;
}

/** base ± jitter (uniform), never below 60 s. */
export function jitteredDelayMs(baseMs: number, jitterMs: number, rand: () => number = Math.random): number {
  return Math.max(60_000, Math.round(baseMs + (rand() * 2 - 1) * jitterMs));
}

/** Quiet hours "HH:MM-HH:MM" (may wrap midnight); empty string = never quiet. */
export function inQuietHours(nowMs: number, tz: string, spec: string | undefined): boolean {
  if (!spec || !spec.trim()) return false;
  const [a, b] = spec.split("-").map((x) => parseHHMM(x));
  if (!a || !b) return false;
  const p = zonedParts(nowMs, tz);
  const cur = p.h * 60 + p.mi;
  const from = a.h * 60 + a.m;
  const to = b.h * 60 + b.m;
  if (from === to) return false;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

export const runsOnLocalDay = (history: readonly number[], nowMs: number, tz: string) => {
  const today = localDay(nowMs, tz);
  return history.filter((t) => localDay(t, tz) === today).length;
};

export interface RunDecisionInput {
  now: number;
  tz: string;
  history: readonly number[]; // start times of earlier runs
  maxPerDay: number;
  quietHours?: string;
  manual: boolean;
  needsLogin: boolean;
  lastRunAt?: number;
  loginRetryMs: number;
  minGapMs: number;
}
export interface RunDecision { run: boolean; reason?: "cap" | "quiet" | "needs-login" | "too-soon" }

/** Whether a sync run may start. Manual triggers skip quiet hours and the login back-off but never the daily cap or the minimum gap. */
export function decideRun(i: RunDecisionInput): RunDecision {
  if (i.lastRunAt && i.now - i.lastRunAt < i.minGapMs) return { run: false, reason: "too-soon" };
  if (runsOnLocalDay(i.history, i.now, i.tz) >= i.maxPerDay) return { run: false, reason: "cap" };
  if (!i.manual) {
    if (inQuietHours(i.now, i.tz, i.quietHours)) return { run: false, reason: "quiet" };
    if (i.needsLogin && i.lastRunAt && i.now - i.lastRunAt < i.loginRetryMs) return { run: false, reason: "needs-login" };
  }
  return { run: true };
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** True when the local weekday in `tz` is `day` ("Mon", "monday", case-insensitive). Empty/unknown `day` = never. */
export function isLocalWeekday(ms: number, tz: string, day: string | undefined): boolean {
  const want = (day ?? "").trim().slice(0, 3).toLowerCase();
  if (!WEEKDAYS.includes(want as (typeof WEEKDAYS)[number])) return false;
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ms)).toLowerCase();
  return wd === want;
}
