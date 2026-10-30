import { describe, expect, it, vi } from "vitest";
import { anyDelivered, clip, configuredChannels, emailSubject, formatText, loadNotifyConfig, notify, pushPayloadFor, redact } from "@/ops/notify";
import { formatPushPayload, PUSH_BODY_MAX, PUSH_TITLE_MAX, safeUrl } from "@/lib/push-payload";

describe("notify config", () => {
  it("web push is on whenever the app url is known; e-mail only when SMTP is configured", () => {
    const env = { APP_URL: "http://app:3000/", SMTP_HOST: "smtp.x.com", SMTP_TO: "a@x.com, b@x.com", SMTP_USER: "u@x.com", SMTP_PASS: "pw" };
    const all = loadNotifyConfig(env);
    expect(all.webpush).toEqual({ appUrl: "http://app:3000" });
    expect(all.email).toMatchObject({ host: "smtp.x.com", port: 587, secure: false, to: ["a@x.com", "b@x.com"], from: "u@x.com" });
    expect(configuredChannels(all)).toEqual(["webpush", "email"]);
    expect(loadNotifyConfig({ APP_URL: "http://app:3000" }).email).toBeUndefined();
    expect(loadNotifyConfig({ ...env, NOTIFY_CHANNELS: "webpush" }).email).toBeUndefined();
    expect(loadNotifyConfig({ ...env, NOTIFY_CHANNELS: "email" }).webpush).toBeUndefined();
    expect(loadNotifyConfig({ ...env, NOTIFY_WEBPUSH: "0" }).webpush).toBeUndefined();
    expect(loadNotifyConfig({ SMTP_HOST: "h", SMTP_TO: "a@b.c", SMTP_PORT: "465" }).email?.secure).toBe(true);
    expect(loadNotifyConfig({})).toEqual({});
  });
});

describe("formatting", () => {
  it("e-mail text and subject", () => {
    expect(formatText({ title: "Hello", body: " body \n" })).toBe("Hello\n\nbody");
    expect(formatText({ title: "Yahoo", body: "x", level: "alert" })).toBe("ALERT: Yahoo\n\nx");
    expect(emailSubject({ title: "T", body: "b", level: "warn" })).toBe("[Fantasy] WARNING: T");
  });
  it("push payload: short title, body <= 170 chars on a word boundary, safe url", () => {
    const p = pushPayloadFor({ title: "Daily brief", body: "ignored", pushBody: "62% this week · Start: " + "Long Name ".repeat(40), url: "/season#brief", tag: "brief" });
    expect(p.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
    expect(p.body.startsWith("62% this week")).toBe(true);
    expect(p.body.endsWith("…")).toBe(true);
    expect(p).toMatchObject({ title: "Daily brief", url: "/season#brief", tag: "brief" });
    expect(pushPayloadFor({ title: "Injury", body: "x", level: "alert" }).title).toBe("ALERT: Injury");
    expect(formatPushPayload({ title: "t".repeat(200), body: "b" }).title.length).toBeLessThanOrEqual(PUSH_TITLE_MAX);
    expect(formatPushPayload({ body: "multi\n\nline   text" }).body).toBe("multi line text");
    expect(formatPushPayload({ body: "b" }).title).toBe("Fantasy Copilot");
  });
  it("only same-site paths and https urls are allowed", () => {
    expect(safeUrl("/season#moves")).toBe("/season#moves");
    expect(safeUrl("https://fantasy.example.com/browser/vnc.html")).toBe("https://fantasy.example.com/browser/vnc.html");
    expect(safeUrl("//evil.com")).toBe("/today");
    expect(safeUrl("javascript:alert(1)")).toBe("/today");
    expect(safeUrl("http://plain.example")).toBe("/today");
    expect(safeUrl(undefined)).toBe("/today");
  });
  it("clips at a boundary with an ellipsis; redacts the SMTP password", () => {
    const c = clip("alpha beta gamma delta epsilon", 20);
    expect(c.length).toBeLessThanOrEqual(20);
    expect(c.endsWith("…")).toBe(true);
    expect(redact("auth failed for pw", { email: { host: "h", port: 1, secure: false, from: "f", to: ["t"], pass: "pw" } })).toBe("auth failed for ***");
  });
});

describe("notify()", () => {
  const cfg = loadNotifyConfig({ APP_URL: "http://app:3000", SMTP_HOST: "h", SMTP_TO: "a@b.c" });
  it("posts the short payload to the app and mails the full text", async () => {
    const f = vi.fn(async () => Response.json({ subscriptions: 1, sent: 1, failed: 0, removed: 0, configured: true }));
    const sendMail = vi.fn(async () => ({}));
    const res = await notify({ title: "Daily brief", body: "full text ".repeat(100), pushBody: "62% · Move: add X", url: "/season#brief" }, cfg, { fetch: f as never, createTransport: () => ({ sendMail }) });
    expect(res.map((r) => [r.channel, r.ok])).toEqual([["webpush", true], ["email", true]]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://app:3000/api/push/send");
    expect(JSON.parse(init.body as string)).toEqual({ title: "Daily brief", body: "62% · Move: add X", url: "/season#brief" });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "a@b.c", subject: "[Fantasy] Daily brief" }));
  });
  it("explains why push failed (no devices, not configured) and still sends e-mail", async () => {
    const none = vi.fn(async () => Response.json({ subscriptions: 0, sent: 0, configured: true }));
    const r1 = await notify({ body: "x" }, cfg, { fetch: none as never, createTransport: () => ({ sendMail: async () => ({}) }), log: () => undefined });
    expect(r1[0]).toMatchObject({ channel: "webpush", ok: false });
    expect(r1[0].error).toContain("no device");
    expect(anyDelivered(r1)).toBe(true);
    const nocfg = vi.fn(async () => Response.json({ configured: false }, { status: 503 }));
    const r2 = await notify({ body: "x" }, { webpush: cfg.webpush }, { fetch: nocfg as never, log: () => undefined });
    expect(r2[0].error).toContain("VAPID");
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await notify({ body: "x" }, { webpush: cfg.webpush }, { fetch: down as never, log: () => undefined }))[0].ok).toBe(false);
  });
  it("never throws without channels", async () => {
    const logs: string[] = [];
    const res = await notify({ body: "hello" }, {}, { log: (l) => logs.push(l) });
    expect(res).toEqual([{ channel: "none", ok: false, error: "no notification channel configured" }]);
    expect(logs[0]).toContain("hello");
  });
});
