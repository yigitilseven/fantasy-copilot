import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeResult } from "@/ops/claude-runner";
import type { LimiterState } from "@/ops/injury-watch";
import { DAILY_BRIEF, WEEKLY_PLAN, runRebriefCheck, plainBrief, pushSummary, runBriefJob, runInjuryJob, runTokenCheck, type JobDeps } from "@/ops/jobs";

const BRIEF = {
  day: "2026-10-27", headline: "Copilot Grizzlies: 2026-10-27 - 9 starters set; matchup 56%; top move: pickup Foo",
  sections: [
    { title: "Today's lineup", lines: ["7 of your players have a game today", "START Bar at UTIL: hot", "G1 noise line"] },
    { title: "This week", lines: ["Matchup win probability: 56%."] },
    { title: "Moves", lines: ["Pickup: add Foo (BOS PF) | week +2.0pp", "    reason line"] },
  ],
};
let dir: string;
let sent: { title?: string; body: string; level?: string; url?: string; pushBody?: string }[];
let claudeCalls: number;
let stored: { text: string; usedClaude: boolean }[];

function deps(claude: ClaudeResult, over: Partial<JobDeps> = {}, pendingEvents: unknown[] = []): JobDeps {
  const acked: string[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace("http://app:3000", "");
    if (u.startsWith("/api/season/claude-brief")) {
      stored.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    if (u.startsWith("/api/season/brief") && u.includes("format=text")) return new Response("PLAIN BRIEF TEXT", { status: 200 });
    if (u.startsWith("/api/season/brief")) return Response.json(BRIEF);
    if (u.startsWith("/api/season/report")) return Response.json({ ranks: [] });
    if (u.startsWith("/api/season/sync-status")) return Response.json({ lastFullAt: "x" });
    if (u.startsWith("/api/season/trades")) return Response.json({ ideas: [] });
    if (u === "/api/ops/injury-events" && init?.method === "POST") {
      acked.push(...JSON.parse(String(init.body)).ids);
      return Response.json({ removed: 1 });
    }
    if (u === "/api/ops/injury-events") return Response.json({ events: pendingEvents });
    return Response.json({});
  });
  (f as unknown as { acked: string[] }).acked = acked;
  return {
    appUrl: "http://app:3000", reportsDir: path.join(dir, "reports"), claudeCwd: path.join(dir, "reports"), promptsDir: path.resolve(__dirname, "../prompts"),
    fetch: f as never, runClaude: async () => (claudeCalls++, claude), notify: async (m) => (sent.push(m), [{ channel: "webpush", ok: true }]), log: () => undefined,
    now: () => Date.parse("2026-10-27T12:30:00Z"), claude: {}, briefMaxChars: 1500, ...over,
  };
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-"));
  sent = [];
  claudeCalls = 0;
  stored = [];
});

describe("morning brief job", () => {
  it("writes engine files, runs Claude and sends its (clipped) answer", async () => {
    const out = await runBriefJob(deps({ ok: true, text: "x".repeat(2000) }));
    expect(out).toMatchObject({ sent: true, usedClaude: true });
    expect(sent[0].body.length).toBeLessThanOrEqual(1500);
    expect(sent[0].title).toBe("Daily brief");
    expect(sent[0].url).toBe("/today/brief");
    expect(sent[0].pushBody).toBe("56% this week · Start: Bar · Move: add Foo");
    expect(stored[0]).toMatchObject({ usedClaude: true });
    expect(stored[0].text.length).toBeLessThanOrEqual(1500);
    for (const f of ["brief.json", "brief.txt", "report.json", "sync-status.json", "trades.json", "context.json"]) expect(fs.existsSync(path.join(dir, "reports", f))).toBe(true);
  });
  it("weekly plan: own prompt, title, tag and a longer limit", async () => {
    let prompt = "";
    const d = deps({ ok: true, text: "y".repeat(3000) }, { runClaude: async (o) => ((prompt = o.prompt), { ok: true, text: "y".repeat(3000) }) });
    const out = await runBriefJob(d, "manual", { ...WEEKLY_PLAN, maxChars: 2500 });
    expect(out.usedClaude).toBe(true);
    expect(prompt).toContain("weekly strategy plan");
    expect(sent[0]).toMatchObject({ title: "Weekly plan", tag: "weekly-plan" });
    expect(sent[0].body.length).toBeLessThanOrEqual(2500); // the limit passed in
    expect(sent[0].body.length).toBeGreaterThan(1500);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "reports", "context.json"), "utf8")).kind).toBe("weekly-plan");
  });
  it.each([
    ["auth", "token problem"],
    ["rate_limit", "rate limit"],
    ["timeout", "unavailable (timeout)"],
  ] as const)("falls back to the plain engine brief on %s", async (failure, note) => {
    const out = await runBriefJob(deps({ ok: false, text: "", failure, detail: "x" }));
    expect(out).toMatchObject({ sent: true, usedClaude: false, failure });
    expect(sent[0].title).toContain("(engine only)");
    expect(sent[0].body).toContain("START Bar at UTIL");
    expect(sent[0].body).toContain(note);
    expect(sent[0].body).not.toContain("G1 noise line");
    expect(stored[0]).toMatchObject({ usedClaude: false });
  });
  it("reports a failing engine instead of staying silent", async () => {
    const d = deps({ ok: true, text: "x" });
    d.fetch = (async (url: string) => (String(url).includes("/brief") ? Response.json({ error: "No season league yet" }, { status: 404 }) : Response.json({}))) as never;
    const out = await runBriefJob(d);
    expect(claudeCalls).toBe(0);
    expect(out.failure).toContain("No season league");
    expect(sent[0].level).toBe("warn");
  });
  it("asks the worker for a fresh sync first, and survives its failure", async () => {
    const workerSync = vi.fn(async () => {
      throw new Error("down");
    });
    expect((await runBriefJob(deps({ ok: true, text: "ok" }, { workerSync }))).sent).toBe(true);
    expect(workerSync).toHaveBeenCalled();
  });
  it("push summary is short and falls back to the headline", () => {
    expect(pushSummary(BRIEF).length).toBeLessThanOrEqual(170);
    expect(pushSummary({ headline: "x ".repeat(200) }).length).toBeLessThanOrEqual(170);
    expect(pushSummary(null)).toContain("ready");
  });
  it("plainBrief stays within the cap", () => {
    expect(plainBrief(BRIEF, 80).length).toBeLessThanOrEqual(80);
  });
});

describe("injury job", () => {
  const ev = { id: "a:healthy>out:t", at: "2026-10-27T12:00:00Z", playerId: "a", name: "Alpha One", before: "healthy", after: "out", direction: "worse", injury: "knee" };
  let lim: LimiterState;
  const io = (useClaude: boolean) => ({ loadLimiter: () => lim, saveLimiter: (s: LimiterState) => void (lim = s), refreshNews: false, useClaude });
  beforeEach(() => {
    lim = { seen: {}, sent: [], takes: [] };
  });
  it("sends engine facts plus a Claude take, acks, and rate-limits the repeat", async () => {
    const d = deps({ ok: true, text: "Start the next guy." }, {}, [ev]);
    expect(await runInjuryJob(d, io(true))).toEqual({ events: 1, sent: 1, take: true });
    expect(sent[0].level).toBe("alert");
    expect(sent[0].body).toContain("- Alpha One: healthy -> OUT (knee)");
    expect(sent[0].body).toContain("Take: Start the next guy.");
    expect((d.fetch as unknown as { acked: string[] }).acked).toContain(ev.id);
    const again = deps({ ok: true, text: "t" }, {}, [{ ...ev, id: "second" }]);
    expect((await runInjuryJob(again, io(true))).sent).toBe(0); // cooldown
  });
  it("still alerts with engine facts when Claude fails", async () => {
    const d = deps({ ok: false, text: "", failure: "rate_limit" }, {}, [ev]);
    expect(await runInjuryJob(d, io(true))).toEqual({ events: 1, sent: 1, take: false });
    expect(sent[0].body).not.toContain("Take:");
  });
  it("keeps events pending when no channel delivers", async () => {
    const d = deps({ ok: true, text: "t" }, { notify: async () => [{ channel: "none", ok: false }] }, [ev]);
    expect((await runInjuryJob(d, io(false))).sent).toBe(0);
    expect((d.fetch as unknown as { acked: string[] }).acked).not.toContain(ev.id);
  });
  it("does nothing without events", async () => {
    expect(await runInjuryJob(deps({ ok: true, text: "" }), io(true))).toEqual({ events: 0, sent: 0, take: false });
  });
});

describe("token check job", () => {
  it("warns once per day near expiry", async () => {
    const d = deps({ ok: true, text: "" });
    const created = "2025-11-01"; // expires 2026-11-01; "now" is 2026-10-27
    expect(await runTokenCheck(d, created, undefined, "2026-10-27")).toBe(true);
    expect(sent[0].body).toContain("expires on 2026-11-01");
    expect(await runTokenCheck(d, created, "2026-10-27", "2026-10-27")).toBe(false);
    expect(await runTokenCheck(d, "2026-09-01", undefined, "2026-10-27")).toBe(false);
    expect(await runTokenCheck(d, undefined, undefined, "2026-10-27")).toBe(false);
  });
});

describe("rebrief after a roster change", () => {
  const kinds = { daily: DAILY_BRIEF, weekly: WEEKLY_PLAN };
  const withBrief = (outdated: boolean, kind = "daily-brief") => {
    const d = deps({ ok: true, text: "MOVES: hold" });
    const inner = d.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
    d.fetch = (async (u: string | URL | Request, i?: RequestInit) => {
      if (String(u).endsWith("/api/season/claude-brief") && (!i || !i.method || i.method === "GET")) return Response.json({ brief: { text: "old", kind }, outdated });
      return inner(String(u), i);
    }) as never;
    return d;
  };
  it("does nothing while the brief matches the roster", async () => {
    const r = await runRebriefCheck(withBrief(false), {}, "2026-10-29", kinds);
    expect(r).toMatchObject({ ran: false, reason: "up to date" });
    expect(claudeCalls).toBe(0);
  });
  it("rewrites an outdated brief quietly (stored, no push), same kind, then waits and caps", async () => {
    const d = withBrief(true, "weekly-plan");
    const r = await runRebriefCheck(d, {}, "2026-10-29", kinds);
    expect(r.ran).toBe(true);
    expect(claudeCalls).toBe(1);
    expect(sent).toHaveLength(0);
    expect(stored[0]).toMatchObject({ usedClaude: true, kind: "weekly-plan" });
    expect((await runRebriefCheck(d, r.state, "2026-10-29", kinds)).reason).toBe("too soon");
    expect((await runRebriefCheck(d, { day: "2026-10-29", count: 6 }, "2026-10-29", kinds)).reason).toBe("daily cap");
    expect((await runRebriefCheck(d, { day: "2026-10-28", count: 6, lastAt: 0 }, "2026-10-29", kinds)).ran).toBe(true); // new day
  });
});
