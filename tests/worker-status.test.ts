import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/season/worker-status/route";

const req = () => new Request("http://localhost/api/season/worker-status");
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.WORKER_URL = "http://worker:8080/";
  process.env.WORKER_TOKEN = "secret";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WORKER_URL;
  delete process.env.WORKER_TOKEN;
});

describe("GET /api/season/worker-status", () => {
  it("is unavailable without WORKER_URL", async () => {
    delete process.env.WORKER_URL;
    const j = await (await GET(req())).json();
    expect(j.available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies /status with the bearer token and normalizes timestamps", async () => {
    const t = Date.UTC(2026, 9, 27, 9, 29);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ needsLogin: false, lastOkAt: t, lastRunAt: t, lastOutcome: "ok", runsToday: 3, maxPerDay: 14, nextRunAt: new Date(t + 7_200_000).toISOString(), novncUrl: "https://x/browser/vnc.html", runs: undefined, running: false }), { status: 200 }));
    const j = await (await GET(req())).json();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://worker:8080/status");
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(j).toEqual({ available: true, needsLogin: false, lastOkAt: new Date(t).toISOString(), lastRunAt: new Date(t).toISOString(), lastOutcome: "ok", runsToday: 3, maxPerDay: 14, nextRunAt: new Date(t + 7_200_000).toISOString(), novncUrl: "https://x/browser/vnc.html" });
  });

  it("reports needsLogin", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ needsLogin: true }), { status: 200 }));
    const j = await (await GET(req())).json();
    expect(j.available).toBe(true);
    expect(j.needsLogin).toBe(true);
    expect(j.lastOkAt).toBeNull();
  });

  it("handles 401, other HTTP errors and network failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect((await (await GET(req())).json()).detail).toMatch(/WORKER_TOKEN/);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect((await (await GET(req())).json()).available).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const j = await (await GET(req())).json();
    expect(j.available).toBe(false);
    expect(j.detail).toMatch(/ECONNREFUSED/);
  });
});
