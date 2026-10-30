import nodemailer from "nodemailer";
import { formatPushPayload } from "../lib/push-payload";

/**
 * Notifications for the always-on deployment. Default channel: Web Push to the installed PWA (the app container holds the subscriptions
 * and VAPID keys; this module just POSTs to its internal /api/push/send). Optional secondary channel: SMTP e-mail (off unless configured).
 * `notify()` never throws; it returns one result per channel. Secrets are never logged.
 *
 * Env: APP_URL (internal app URL; enables webpush), NOTIFY_WEBPUSH=0 to turn it off
 *      SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_TO (comma list)
 *      NOTIFY_CHANNELS (optional filter, "webpush", "email" or "webpush,email")
 */

type Env = Record<string, string | undefined>;
export type NotifyLevel = "info" | "warn" | "alert";
export type Channel = "webpush" | "email";

export interface NotifyMessage {
  title?: string;
  /** Full text (e-mail, logs). */
  body: string;
  /** Short text for the push notification (iOS shows ~4 lines); defaults to a clipped body. */
  pushBody?: string;
  /** Where a tap goes: a path on the app ("/today/brief") or an https URL. */
  url?: string;
  tag?: string;
  level?: NotifyLevel;
}
export interface WebPushConfig { appUrl: string }
export interface EmailConfig { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string; to: string[] }
export interface NotifyConfig { webpush?: WebPushConfig; email?: EmailConfig }
export interface NotifyResult { channel: Channel | "none"; ok: boolean; error?: string }

export function loadNotifyConfig(env: Env = process.env): NotifyConfig {
  const want = (env.NOTIFY_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowed = (c: Channel) => want.length === 0 || want.includes(c);
  const cfg: NotifyConfig = {};
  if (allowed("webpush") && env.NOTIFY_WEBPUSH !== "0" && env.APP_URL?.trim()) cfg.webpush = { appUrl: env.APP_URL.trim().replace(/\/$/, "") };
  const to = (env.SMTP_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed("email") && env.SMTP_HOST?.trim() && to.length) {
    const port = Number(env.SMTP_PORT) || 587;
    const secure = env.SMTP_SECURE ? /^(1|true|yes)$/i.test(env.SMTP_SECURE) : port === 465;
    cfg.email = { host: env.SMTP_HOST.trim(), port, secure, user: env.SMTP_USER?.trim() || undefined, pass: env.SMTP_PASS || undefined, from: env.SMTP_FROM?.trim() || env.SMTP_USER?.trim() || `fantasy@${env.SMTP_HOST.trim()}`, to };
  }
  return cfg;
}

export function configuredChannels(cfg: NotifyConfig): Channel[] {
  return [cfg.webpush ? "webpush" : null, cfg.email ? "email" : null].filter((x): x is Channel => !!x);
}

const PREFIX: Record<NotifyLevel, string> = { info: "", warn: "WARNING: ", alert: "ALERT: " };

/** Plain text for e-mail: optional title line, blank line, body. */
export function formatText(msg: NotifyMessage): string {
  const title = msg.title ? `${PREFIX[msg.level ?? "info"]}${msg.title}` : msg.level && msg.level !== "info" ? PREFIX[msg.level].trim() : "";
  return (title ? `${title}\n\n` : "") + msg.body.trim();
}

/** Hard cap with an ellipsis, cutting at a line or word boundary when one is near the end. */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  let cut = t.lastIndexOf("\n", max - 1);
  if (cut < max * 0.6) cut = t.lastIndexOf(" ", max - 1);
  if (cut < max * 0.6) cut = max - 1;
  return t.slice(0, cut).trimEnd() + "…";
}

export function redact(s: string, cfg: NotifyConfig): string {
  return cfg.email?.pass ? s.split(cfg.email.pass).join("***") : s;
}

export interface MailTransport { sendMail(opts: { from: string; to: string; subject: string; text: string }): Promise<unknown> }
export interface NotifyDeps {
  fetch?: typeof fetch;
  createTransport?: (cfg: EmailConfig) => MailTransport;
  log?: (line: string) => void;
}

const defaultTransport = (c: EmailConfig): MailTransport =>
  nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 15_000, socketTimeout: 30_000 });

export function emailSubject(msg: NotifyMessage): string {
  const first = (msg.title || msg.body.split("\n")[0] || "Fantasy").trim();
  return `[Fantasy] ${PREFIX[msg.level ?? "info"]}${first}`.slice(0, 150);
}

/** What the push shows: short title (with level prefix) and a body of at most ~170 characters. */
export function pushPayloadFor(msg: NotifyMessage) {
  return formatPushPayload({ title: msg.title ? `${PREFIX[msg.level ?? "info"]}${msg.title}` : PREFIX[msg.level ?? "info"].trim() || undefined, body: msg.pushBody ?? msg.body, url: msg.url, tag: msg.tag });
}

export async function sendWebPush(cfg: WebPushConfig, msg: NotifyMessage, f: typeof fetch = fetch): Promise<void> {
  const res = await f(`${cfg.appUrl}/api/push/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pushPayloadFor(msg)), signal: AbortSignal.timeout(60_000) });
  let j: { sent?: number; subscriptions?: number; configured?: boolean; error?: string } = {};
  try {
    j = await res.json();
  } catch {
    /* no body */
  }
  if (res.status === 503 && j.configured === false) throw new Error("push is not configured in the app (set VAPID_* in .env)");
  if (!res.ok) throw new Error(`push send HTTP ${res.status}${j.error ? `: ${j.error}` : ""}`);
  if (!j.subscriptions) throw new Error("no device has enabled notifications yet (open the app on the iPhone and tap Enable notifications)");
  if (!j.sent) throw new Error("push service rejected every subscription");
}

export async function notify(msg: NotifyMessage, cfg: NotifyConfig = loadNotifyConfig(), deps: NotifyDeps = {}): Promise<NotifyResult[]> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const text = formatText(msg);
  const results: NotifyResult[] = [];
  if (cfg.webpush) {
    try {
      await sendWebPush(cfg.webpush, msg, deps.fetch);
      results.push({ channel: "webpush", ok: true });
    } catch (e) {
      results.push({ channel: "webpush", ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (cfg.email) {
    try {
      const t = (deps.createTransport ?? defaultTransport)(cfg.email);
      await t.sendMail({ from: cfg.email.from, to: cfg.email.to.join(", "), subject: emailSubject(msg), text });
      results.push({ channel: "email", ok: true });
    } catch (e) {
      results.push({ channel: "email", ok: false, error: redact(e instanceof Error ? e.message : String(e), cfg) });
    }
  }
  if (!results.length) {
    log(`[notify] no channel configured (APP_URL for push, or SMTP_*); message was:\n${text}`);
    return [{ channel: "none", ok: false, error: "no notification channel configured" }];
  }
  for (const r of results) if (!r.ok) log(`[notify] ${r.channel} failed: ${r.error}`);
  return results;
}

export const anyDelivered = (r: NotifyResult[]) => r.some((x) => x.ok);
