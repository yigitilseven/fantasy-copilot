import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { draftRoomKey, headerOnClock, PROJ_MAX_AGE_MS, projectionCaptureDecision } from "../extension/parser.js";
import { evaluatePredraft, predraftProblems } from "../src/store/predraft";

const NOW = 1_800_000_000_000;
const base = { statView: "proj-2026-27", roomKey: "123/4", lastCapture: null, serverCapturedAt: null, onClock: false, now: NOW };
const decide = (o: Record<string, unknown> = {}) => projectionCaptureDecision({ ...base, ...o }).action;

describe("projectionCaptureDecision", () => {
  it("captures a never-captured room when the proj view is on screen and the user is not on the clock", () => {
    expect(decide()).toBe("capture");
  });
  it("hints (until captured) when the proj view is not selected", () => {
    expect(decide({ statView: "avg-2025-26" })).toBe("hint");
    expect(decide({ statView: "unknown" })).toBe("hint");
  });
  it("defers while on the clock, then captures", () => {
    expect(decide({ onClock: true })).toBe("defer");
    expect(decide({ onClock: false })).toBe("capture");
  });
  it("is done for a room captured < 12 h ago, no matter the view or the clock", () => {
    const lastCapture = { draftRoomKey: "123/4", capturedAt: NOW - 3600_000 };
    expect(decide({ lastCapture })).toBe("done");
    expect(decide({ lastCapture, statView: "unknown", onClock: true })).toBe("done");
  });
  it("captures again after 12 h, unless the server has a newer capture", () => {
    const lastCapture = { draftRoomKey: "123/4", capturedAt: NOW - PROJ_MAX_AGE_MS - 1000 };
    expect(decide({ lastCapture })).toBe("capture");
    expect(decide({ lastCapture, statView: "avg-2025-26" })).toBe("hint");
    expect(decide({ lastCapture, serverCapturedAt: NOW - 60_000 })).toBe("done");
  });
  it("treats a capture of another room as not captured; no room = none", () => {
    expect(decide({ lastCapture: { draftRoomKey: "999/1", capturedAt: NOW - 1000 } })).toBe("capture");
    expect(decide({ roomKey: null })).toBe("none");
  });
});

describe("draftRoomKey", () => {
  it("reads the league id (and team) from the draft client URL", () => {
    expect(draftRoomKey("https://basketball.fantasysports.yahoo.com/draftclient/nba/12345/6")).toBe("12345/6");
    expect(draftRoomKey("https://basketball.fantasysports.yahoo.com/draftclient/nba/12345")).toBe("12345");
    expect(draftRoomKey("https://basketball.fantasysports.yahoo.com/nba/12345/draft")).toBe("12345");
    expect(draftRoomKey("https://basketball.fantasysports.yahoo.com/")).toBeNull();
  });
});

describe("headerOnClock", () => {
  const doc = (line: string) => new JSDOM(`<body><div><span>${line}</span></div></body>`).window.document;
  it("is false while someone else picks ('You're up in N Picks' = not yet)", () => {
    expect(headerOnClock(doc("00:30 Ricky's Pick • You're up in 11 Picks • Round 5, Pick 58"))).toBe(false);
    expect(headerOnClock(doc("Drafter ZZ's Pick • Round 13, Pick 182"))).toBe(false);
  });
  it("is true for the on-the-clock wordings", () => {
    expect(headerOnClock(doc("00:45 Your Pick • Round 5, Pick 58"))).toBe(true);
    expect(headerOnClock(doc("00:45 You're up • Round 5, Pick 58"))).toBe(true);
    expect(headerOnClock(doc("You're on the clock • Round 5, Pick 58"))).toBe(true);
  });
  it("is false without a header", () => {
    expect(headerOnClock(doc("Players"))).toBe(false);
  });
});

describe("evaluatePredraft", () => {
  const ok = {
    news: { lastSuccessAt: new Date(NOW - 5 * 60_000).toISOString() },
    proj: { usable: 733, capturedAt: new Date(NOW - 3600_000).toISOString() },
    heartbeat: { receivedAt: NOW - 4000, panel: "picks" as const },
    browserSync: true, teams: 12, userSlot: 4, now: NOW,
  };
  const row = (i: Parameters<typeof evaluatePredraft>[0], k: string) => evaluatePredraft(i).find((r) => r.key === k)!;

  it("all green", () => {
    const rows = evaluatePredraft(ok);
    expect(predraftProblems(rows)).toBe(0);
    expect(row(ok, "projections").text).toContain("733 players");
    expect(row(ok, "setup").text).toBe("12 teams · you pick #4");
  });
  it("flags stale news, old/missing projections, silent tab, hidden panel, sync off", () => {
    expect(row({ ...ok, news: { lastSuccessAt: new Date(NOW - 2 * 3600_000).toISOString() } }, "news").state).toBe("bad");
    expect(row({ ...ok, news: { lastSuccessAt: null } }, "news").state).toBe("bad");
    expect(row({ ...ok, proj: { usable: 0, capturedAt: null } }, "projections").state).toBe("bad");
    expect(row({ ...ok, proj: { usable: 700, capturedAt: new Date(NOW - 13 * 3600_000).toISOString() } }, "projections").state).toBe("bad");
    expect(row({ ...ok, heartbeat: { receivedAt: NOW - 20_000, panel: "picks" } }, "yahoo-tab").state).toBe("bad");
    expect(row({ ...ok, heartbeat: null }, "yahoo-tab").state).toBe("bad");
    expect(row({ ...ok, heartbeat: { receivedAt: NOW - 1000, panel: "hidden" } }, "picks-panel").state).toBe("bad");
    expect(row({ ...ok, heartbeat: { receivedAt: NOW - 1000, panel: "n/a" } }, "picks-panel").state).toBe("wait");
    expect(row({ ...ok, browserSync: false }, "browser-sync").state).toBe("bad");
  });
});
