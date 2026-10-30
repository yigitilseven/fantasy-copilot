/**
 * Detects when Yahoo wants the human: login page, captcha, "verify it's you", consent wall. The worker then STOPS and alerts; it never types
 * credentials, solves challenges or tries to get around them.
 */
export type WallKind = "login" | "captcha" | "verification" | "consent" | "redirect";

export interface PageSnapshot {
  url: string;
  title?: string;
  /** Visible text (first few thousand characters are enough). */
  text?: string;
  hasPasswordInput?: boolean;
  hasLoginForm?: boolean;
  hasCaptcha?: boolean;
}
export interface WallResult { wall: boolean; kind?: WallKind; reason?: string }

const LEAGUE_HOST = /(^|\.)fantasysports\.yahoo\.com$/i;

/** Runs inside the page (string so no transpiler helper can leak into page.evaluate). Returns a PageSnapshot. */
export const COLLECT_SNAPSHOT_JS = `(() => {
  const q = (s) => !!document.querySelector(s);
  return {
    url: location.href,
    title: document.title || "",
    text: ((document.body && (document.body.innerText || document.body.textContent)) || "").slice(0, 4000),
    hasPasswordInput: q('input[type="password"]'),
    hasLoginForm: q('#login-username, #login-signin, form[action*="login"], input[name="username"][autocomplete*="username"]'),
    hasCaptcha: Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="captcha"], iframe[src*="hcaptcha"], .g-recaptcha, #recaptcha, [id*="captcha" i]')).some((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }),
  };
})()`;

export function detectLoginWall(s: PageSnapshot, expectedLeagueId?: string): WallResult {
  let u: URL | null = null;
  try {
    u = new URL(s.url);
  } catch {
    return { wall: true, kind: "redirect", reason: `unreadable url "${s.url}"` };
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  const text = `${s.title ?? ""}\n${s.text ?? ""}`;

  if (/^(guce|consent)\.yahoo\.com$/.test(host) || /consent\.yahoo\.com/.test(host) || /\/consent\b/.test(path)) return { wall: true, kind: "consent", reason: "consent page" };
  if (/(^|\.)login\.yahoo\.com$/.test(host) || /\/(login|signin|sign-in)(\/|$)/.test(path)) {
    if (/\/account\/challenge|\/challenge\b/.test(path) || /captcha|challenge/.test(path)) return { wall: true, kind: /captcha/.test(path) ? "captcha" : "verification", reason: "challenge page" };
    return { wall: true, kind: "login", reason: "login page" };
  }
  if (s.hasCaptcha || /\b(re)?captcha\b|i'?m not a robot|are you a robot|robot check/i.test(text)) return { wall: true, kind: "captcha", reason: "captcha on page" };
  if (/verify (that )?it'?s you|verify your identity|unusual (sign-?in )?activity|confirm (that )?it'?s you|we need to verify|suspicious activity/i.test(text)) return { wall: true, kind: "verification", reason: "verification prompt" };
  if (s.hasPasswordInput || s.hasLoginForm) return { wall: true, kind: "login", reason: "sign-in form on page" };
  if (!LEAGUE_HOST.test(host)) return { wall: true, kind: "redirect", reason: `redirected away from the league (${host})` };
  if (/^sign in to (yahoo|continue)|^(enter|type) your (email|username|mobile)/im.test(text) && !/\/nba\/\d+/.test(path)) return { wall: true, kind: "login", reason: "sign-in text" };
  if (expectedLeagueId && !path.startsWith(`/nba/${expectedLeagueId}`)) return { wall: true, kind: "redirect", reason: `landed on ${u.pathname}, not the league` };
  return { wall: false };
}

export const WALL_LABEL: Record<WallKind, string> = {
  login: "login required",
  captcha: "captcha shown",
  verification: "identity verification requested",
  consent: "consent page shown",
  redirect: "unexpected redirect",
};
