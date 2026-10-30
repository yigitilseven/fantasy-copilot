import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildClaudeArgs, buildClaudeEnv, classifyFailure, parseClaudeOutput, runClaude, tokenExpiry } from "@/ops/claude-runner";

let dir: string;
const fake = (name: string, body: string) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
};
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
});
const env = { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test" };

describe("claude args and env", () => {
  it("uses the unattended flags and never --bare", () => {
    const a = buildClaudeArgs({});
    expect(a).toEqual(["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--allowedTools", "Read"]);
    expect(a).not.toContain("--bare");
    expect(buildClaudeArgs({ model: "sonnet", extraArgs: ["--permission-prompts", "none"] }).slice(-4)).toEqual(["--model", "sonnet", "--permission-prompts", "none"]);
  });
  it("strips API-key variables so the subscription token is used", () => {
    const r = buildClaudeEnv({ ANTHROPIC_API_KEY: "sk-ant-api", CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "/bin" });
    expect(r.hadApiKey).toBe(true);
    expect(r.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
  });
});

describe("runClaude with a mocked CLI", () => {
  it("success: prompt on stdin, cwd respected, API key not passed", async () => {
    const bin = fake("ok", `cat > "$PWD/prompt-seen.txt"; echo "key=[$ANTHROPIC_API_KEY]" > "$PWD/env-seen.txt"; echo '{"type":"result","subtype":"success","is_error":false,"result":"Lineup is fine.","total_cost_usd":0.01}'`);
    const cwd = fs.mkdtempSync(path.join(dir, "cwd-"));
    const r = await runClaude({ prompt: "PROMPT TEXT", cwd, bin, env: { ...env, ANTHROPIC_API_KEY: "leak" } });
    expect(r).toMatchObject({ ok: true, text: "Lineup is fine.", costUsd: 0.01 });
    expect(fs.readFileSync(path.join(cwd, "prompt-seen.txt"), "utf8")).toBe("PROMPT TEXT");
    expect(fs.readFileSync(path.join(cwd, "env-seen.txt"), "utf8").trim()).toBe("key=[]");
  });
  it("auth failure (real CLI output shape: is_error true, exit 1)", async () => {
    const out = JSON.stringify({ is_error: true, subtype: "success", result: "Failed to authenticate: OAuth session expired and could not be refreshed", type: "result" });
    const r = await runClaude({ prompt: "p", cwd: dir, bin: fake("auth", `cat >/dev/null; echo '${out}'; exit 1`), env });
    expect(r).toMatchObject({ ok: false, failure: "auth", exitCode: 1 });
    expect(r.detail).toContain("OAuth");
  });
  it("rate limit", async () => {
    const r = await runClaude({ prompt: "p", cwd: dir, bin: fake("rl", `cat >/dev/null; echo '{"type":"result","is_error":true,"result":"5-hour usage limit reached, resets at 3pm"}'; exit 1`), env });
    expect(r).toMatchObject({ ok: false, failure: "rate_limit" });
  });
  it("other failures: stderr only, empty answer, missing binary, no token, timeout", async () => {
    expect((await runClaude({ prompt: "p", cwd: dir, bin: fake("boom", `cat >/dev/null; echo kaboom >&2; exit 2`), env })).failure).toBe("error");
    expect((await runClaude({ prompt: "p", cwd: dir, bin: fake("empty", `cat >/dev/null; echo '{"type":"result","is_error":false,"result":"  "}'`), env })).failure).toBe("empty");
    expect((await runClaude({ prompt: "p", cwd: dir, bin: path.join(dir, "nope"), env })).failure).toBe("missing");
    expect((await runClaude({ prompt: "p", cwd: dir, env: { PATH: process.env.PATH } })).failure).toBe("no_token");
    // a stored `claude login` (claude-config volume) counts: the CLI is run instead of failing early
    fs.mkdirSync(path.join(dir, "home", ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, "home", ".claude", ".credentials.json"), "{}");
    expect((await runClaude({ prompt: "p", cwd: dir, bin: path.join(dir, "nope"), env: { PATH: process.env.PATH, HOME: path.join(dir, "home") } })).failure).toBe("missing");
    const t = await runClaude({ prompt: "p", cwd: dir, bin: fake("slow", `exec sleep 5`), env, timeoutMs: 300 });
    expect(t.failure).toBe("timeout");
  });
  it("parses arrays of events and classifies messages", () => {
    expect(parseClaudeOutput(JSON.stringify([{ type: "system" }, { type: "result", result: "hi", is_error: false }]))?.text).toBe("hi");
    expect(parseClaudeOutput("garbage")).toBeNull();
    expect(classifyFailure("HTTP 429 Too Many Requests")).toBe("rate_limit");
    expect(classifyFailure("Invalid API key")).toBe("auth");
  });
});

describe("token expiry", () => {
  const day = 86_400_000;
  it("warns 14 days before one year", () => {
    const created = "2026-01-01";
    const exp = Date.parse(created) + 365 * day;
    expect(tokenExpiry(created, exp - 30 * day).warn).toBe(false);
    expect(tokenExpiry(created, exp - 14 * day)).toMatchObject({ warn: true, daysLeft: 14 });
    expect(tokenExpiry(created, exp + 3 * day)).toMatchObject({ warn: true, daysLeft: -3 });
    expect(tokenExpiry(undefined, 0)).toEqual({ known: false, warn: false });
  });
});
