import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

describe("pnpm ext:build", () => {
  it("inlines parser.js into a single, syntactically valid userscript with the required metadata", () => {
    execFileSync("node", ["scripts/build-extension.mjs"], { cwd: ROOT, stdio: "pipe" });
    const out = fs.readFileSync(path.join(ROOT, "extension/yahoo-draft-reader.user.js"), "utf8");
    for (const tag of ["@match        https://basketball.fantasysports.yahoo.com/*", "@match        *://*.fantasysports.yahoo.com/*", "@grant        GM.xmlHttpRequest", "@connect      localhost", "@run-at       document-idle"])
      expect(out).toContain(tag);
    expect(out.startsWith("// ==UserScript==")).toBe(true);
    expect(out).not.toMatch(/^\s*(export|import)\s/m);
    expect(out).toContain("function parseDraftRoom(");
    expect(out).not.toContain("__PARSER__");
    expect(() => new vm.Script(out)).not.toThrow();
  });
});
