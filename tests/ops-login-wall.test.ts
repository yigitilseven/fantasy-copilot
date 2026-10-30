import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { COLLECT_SNAPSHOT_JS, detectLoginWall, type PageSnapshot } from "@/ops/login-wall";

// jsdom has no layout (every box is 0x0): give elements a size unless they carry data-test-hidden, so the
// "visible captcha only" check can be exercised both ways.
const fixture = (name: string, url: string, extraHtml = ""): PageSnapshot => {
  const html = fs.readFileSync(path.join(__dirname, "fixtures-ops", name), "utf8").replace("</body>", `${extraHtml}</body>`);
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const size = this.hasAttribute("data-test-hidden") ? 0 : 100;
    return { width: size, height: size, top: 0, left: 0, right: size, bottom: size, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  return dom.window.eval(COLLECT_SNAPSHOT_JS) as PageSnapshot;
};
const LEAGUE = "https://basketball.fantasysports.yahoo.com/nba/100001/9";

describe("login wall detection", () => {
  it("lets the normal league page through", () => {
    expect(detectLoginWall(fixture("league.html", LEAGUE), "100001")).toEqual({ wall: false });
  });
  it("detects Yahoo's login page by url and by form", () => {
    expect(detectLoginWall(fixture("login.html", "https://login.yahoo.com/?.src=ym"))).toMatchObject({ wall: true, kind: "login" });
    expect(detectLoginWall(fixture("login.html", LEAGUE))).toMatchObject({ wall: true, kind: "login" }); // form on the league url
    expect(detectLoginWall(fixture("password.html", LEAGUE))).toMatchObject({ wall: true, kind: "login" });
  });
  it("ignores hidden captcha placeholders on a normal page", () => {
    expect(detectLoginWall(fixture("league.html", LEAGUE, '<div id="recaptcha-holder" data-test-hidden></div><div id="captcha-x" style="display:none"></div>'), "100001")).toEqual({ wall: false });
  });
  it("detects captcha and verification pages", () => {
    expect(detectLoginWall(fixture("captcha.html", "https://basketball.fantasysports.yahoo.com/nba/100001/9"))).toMatchObject({ wall: true, kind: "captcha" });
    expect(detectLoginWall(fixture("verify.html", LEAGUE))).toMatchObject({ wall: true, kind: "verification" });
    expect(detectLoginWall({ url: "https://login.yahoo.com/account/challenge/recaptcha" })).toMatchObject({ wall: true, kind: "captcha" });
    expect(detectLoginWall({ url: "https://login.yahoo.com/account/challenge/phone-verify" })).toMatchObject({ wall: true, kind: "verification" });
  });
  it("detects consent walls and foreign redirects", () => {
    expect(detectLoginWall({ url: "https://consent.yahoo.com/v2/collectConsent?sessionId=1" })).toMatchObject({ wall: true, kind: "consent" });
    expect(detectLoginWall({ url: "https://guce.yahoo.com/consent" })).toMatchObject({ wall: true, kind: "consent" });
    expect(detectLoginWall({ url: "https://www.yahoo.com/" })).toMatchObject({ wall: true, kind: "redirect" });
    expect(detectLoginWall({ url: "https://basketball.fantasysports.yahoo.com/" }, "100001")).toMatchObject({ wall: true, kind: "redirect" });
    expect(detectLoginWall({ url: "not a url" })).toMatchObject({ wall: true });
  });
});
