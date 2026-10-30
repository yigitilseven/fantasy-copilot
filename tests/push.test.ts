import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendNotification = vi.hoisted(() => vi.fn());
vi.mock("web-push", () => ({ default: { sendNotification, generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }) } }));

import { createDb, type Db } from "@/db/client";
import { seedSeasonLeague } from "./season-fixtures";
import { getLeague, getRosters, syncTeamRoster } from "@/db/season";
import { GET as publicKeyGet } from "@/app/api/push/public-key/route";
import { POST as subscribePost } from "@/app/api/push/subscribe/route";
import { POST as unsubscribePost } from "@/app/api/push/unsubscribe/route";
import { POST as testPost } from "@/app/api/push/test/route";
import { POST as sendPost } from "@/app/api/push/send/route";
import { GET as claudeGet, POST as claudePost } from "@/app/api/season/claude-brief/route";
import { countSubscriptions } from "@/server/push";
import { pushUiState, type PushEnv } from "@/lib/push-client";
import manifest from "@/app/manifest";

const ROOT = path.resolve(__dirname, "..");
const req = (url: string, body?: unknown, method = "POST") => new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", "user-agent": "iPhone Safari" }, body: body === undefined ? undefined : JSON.stringify(body) });
const sub = (n: number) => ({ endpoint: `https://web.push.apple.com/token-${n}`, keys: { p256dh: "BPubKeyBase64UrlString" + n, auth: "authSecret" + n } });
let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  process.env.VAPID_PUBLIC_KEY = "pubkey";
  process.env.VAPID_PRIVATE_KEY = "privkey";
  process.env.VAPID_SUBJECT = "mailto:me@example.com";
});

describe("push routes", () => {
  it("public key: served when configured, 503 when not", async () => {
    expect(await (await publicKeyGet()).json()).toEqual({ publicKey: "pubkey" });
    delete process.env.VAPID_PUBLIC_KEY;
    const r = await publicKeyGet();
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("PUSH_NOT_CONFIGURED");
  });

  it("subscribe stores, dedupes by endpoint, validates", async () => {
    expect((await (await subscribePost(req("/api/push/subscribe", sub(1)))).json()).result).toBe("created");
    expect((await (await subscribePost(req("/api/push/subscribe", sub(1)))).json()).result).toBe("updated");
    await subscribePost(req("/api/push/subscribe", sub(2)));
    expect(countSubscriptions(db)).toBe(2);
    expect((await subscribePost(req("/api/push/subscribe", { endpoint: "nope", keys: {} }))).status).toBe(400);
  });

  it("unsubscribe removes the endpoint", async () => {
    await subscribePost(req("/api/push/subscribe", sub(1)));
    expect((await (await unsubscribePost(req("/api/push/unsubscribe", { endpoint: sub(1).endpoint }))).json()).removed).toBe(true);
    expect(countSubscriptions(db)).toBe(0);
    expect((await (await unsubscribePost(req("/api/push/unsubscribe", { endpoint: sub(1).endpoint }))).json()).removed).toBe(false);
  });

  it("send: formats the payload, uses VAPID, and drops subscriptions the push service reports gone (404/410)", async () => {
    for (const n of [1, 2, 3]) await subscribePost(req("/api/push/subscribe", sub(n)));
    sendNotification.mockImplementation(async (s: { endpoint: string }) => {
      if (s.endpoint.endsWith("token-2")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      if (s.endpoint.endsWith("token-3")) throw Object.assign(new Error("boom"), { statusCode: 500 });
      return { statusCode: 201 };
    });
    const r = await sendPost(req("/api/push/send", { title: "Daily brief", body: "x ".repeat(300), url: "/season#brief", tag: "daily-brief" }));
    expect(await r.json()).toEqual({ subscriptions: 3, sent: 1, failed: 1, removed: 1, configured: true });
    expect(countSubscriptions(db)).toBe(2); // the 410 one is gone, the failing one stays
    const [s, payload, opts] = sendNotification.mock.calls[0];
    expect(s.keys.auth).toBe("authSecret1");
    const p = JSON.parse(payload);
    expect(p.title).toBe("Daily brief");
    expect(p.body.length).toBeLessThanOrEqual(170);
    expect(p).toMatchObject({ url: "/season#brief", tag: "daily-brief" });
    expect(opts.vapidDetails).toEqual({ subject: "mailto:me@example.com", publicKey: "pubkey", privateKey: "privkey" });
  });

  it("send: 404 from the push service also removes; without VAPID nothing is sent and the answer is 503", async () => {
    await subscribePost(req("/api/push/subscribe", sub(1)));
    sendNotification.mockRejectedValueOnce(Object.assign(new Error("nf"), { statusCode: 404 }));
    expect((await (await testPost()).json()).removed).toBe(1);
    await subscribePost(req("/api/push/subscribe", sub(1)));
    delete process.env.VAPID_PRIVATE_KEY;
    sendNotification.mockClear();
    const r = await testPost();
    expect(r.status).toBe(503);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("stored Claude brief", () => {
  it("is saved for today's game day and read back", async () => {
    seedSeasonLeague(db);
    expect((await (await claudeGet()).json()).brief).toBeNull();
    expect((await claudePost(req("/api/season/claude-brief", { text: "TODAY: start Bar", usedClaude: true }))).status).toBe(200);
    const b = (await (await claudeGet()).json()).brief;
    expect(b).toMatchObject({ text: "TODAY: start Bar", usedClaude: true });
  });
  it("404 without a league", async () => {
    expect((await claudePost(req("/api/season/claude-brief", { text: "x", usedClaude: false }))).status).toBe(404);
  });
  it("is flagged outdated once your roster changes after it was written", async () => {
    const { faIds } = seedSeasonLeague(db);
    expect((await claudePost(req("/api/season/claude-brief", { text: "MOVES: add X, drop Y", usedClaude: true, kind: "daily-brief" }))).status).toBe(200);
    let j = await (await claudeGet()).json();
    expect(j).toMatchObject({ outdated: false, brief: { kind: "daily-brief" } });
    // you dropped one player and added a free agent on Yahoo; the next sync stores the new roster
    const lg = getLeague(db)!;
    const mine = getRosters(db, lg.id).get(lg.userSlot)!.map((r) => r.playerId);
    syncTeamRoster(db, lg.id, lg.userSlot, [...mine.slice(1), faIds[0]].map((playerId) => ({ playerId, lineupSlot: null, status: "active" as const })), "yahoo-page");
    j = await (await claudeGet()).json();
    expect(j.outdated).toBe(true);
    // a rewritten brief matches the roster again
    await claudePost(req("/api/season/claude-brief", { text: "MOVES: hold", usedClaude: true }));
    expect((await (await claudeGet()).json()).outdated).toBe(false);
  });
});

describe("notification UI state (iOS standalone logic)", () => {
  const base: PushEnv = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile/15E148 Safari/604.1", standalone: false, secure: true, hasServiceWorker: true, hasPushManager: false, hasNotification: false, permission: "default", subscribed: false };
  it("iPhone in Safari: asks to add to the Home Screen first", () => {
    const u = pushUiState({ ...base, hasPushManager: true, hasNotification: true });
    expect(u.state).toBe("install-needed");
    expect(u.steps?.join(" ")).toMatch(/Share[\s\S]*Add to Home Screen[\s\S]*Home Screen icon[\s\S]*Enable/);
  });
  it("iPhone from the Home Screen: can enable, enabled, blocked", () => {
    const home = { ...base, standalone: true, hasPushManager: true, hasNotification: true };
    expect(pushUiState(home).state).toBe("can-enable");
    expect(pushUiState({ ...home, permission: "granted", subscribed: true }).state).toBe("enabled");
    expect(pushUiState({ ...home, permission: "granted", subscribed: false }).state).toBe("can-enable");
    expect(pushUiState({ ...home, permission: "denied" }).state).toBe("blocked");
  });
  it("insecure origin and unsupported browsers", () => {
    expect(pushUiState({ ...base, secure: false }).message).toContain("https://fantasy.example.com");
    expect(pushUiState({ ...base, userAgent: "Mozilla/5.0 (X11; Linux) Firefox", secure: true }).state).toBe("unsupported");
    expect(pushUiState({ ...base, userAgent: "Mozilla/5.0 (Macintosh) Chrome", hasPushManager: true, hasNotification: true }).state).toBe("can-enable");
  });
});

describe("PWA assets", () => {
  it("manifest: standalone, start_url /today, icons", () => {
    const m = manifest();
    expect(m).toMatchObject({ name: "Fantasy Copilot", short_name: "Copilot", display: "standalone", start_url: "/today" });
    expect(m.theme_color).toBeTruthy();
    expect(m.background_color).toBeTruthy();
    expect(m.icons?.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const i of m.icons ?? []) expect(fs.existsSync(path.join(ROOT, "public", i.src))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "public/icons/apple-touch-icon.png"))).toBe(true);
  });
  it("layout declares the iOS web-app metadata and registers the service worker", () => {
    const layout = fs.readFileSync(path.join(ROOT, "src/app/layout.tsx"), "utf8");
    expect(layout).toMatch(/appleWebApp: \{ capable: true, title: "Copilot"/);
    expect(layout).toContain("apple-touch-icon.png");
    expect(layout).toContain("<ServiceWorker />");
    expect(fs.readFileSync(path.join(ROOT, "src/app/service-worker.tsx"), "utf8")).toContain('register("/sw.js"');
  });
  it("service worker handles push and notificationclick, and caches nothing", () => {
    const sw = fs.readFileSync(path.join(ROOT, "public/sw.js"), "utf8");
    expect(sw).toContain('addEventListener("push"');
    expect(sw).toContain('addEventListener("notificationclick"');
    expect(sw).toContain("showNotification");
    expect(sw).toMatch(/openWindow|focus/);
    expect(sw).not.toMatch(/caches\.|addEventListener\("fetch"/);
  });
});
