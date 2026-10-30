import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCbsInjuries, parseEspnInjuries, parseEspnNews, parseRotowireInjuries, seasonEndingText } from "@/integrations/news/providers";
import { parseRss } from "@/integrations/news/rss";
import { parseRssDate, returnDateAfter } from "@/integrations/news/text";

const fx = (f: string) => fs.readFileSync(path.resolve(__dirname, "fixtures-news", f), "utf8");
const NOW = new Date("2026-10-07T14:00:00Z");

describe("ESPN injuries JSON", () => {
  const { reports, news } = parseEspnInjuries(fx("espn-injuries.json"));
  const by = (n: string) => reports.find((r) => r.name === n)!;
  it("parses status, return date, injury and report time", () => {
    expect(reports.length).toBeGreaterThan(10);
    const w = by("Aaron Wiggins");
    expect(w).toMatchObject({ status: "day-to-day", estReturn: "2026-10-08", source: "ESPN", reportedAt: "2026-10-06T00:29:00.000Z" });
    expect(w.injury).toContain("Lips");
    expect(by("Jimmy Butler III")).toMatchObject({ status: "out", estReturn: "2027-01-02" });
  });
  it("season-ending: OFS flag or return after the season", () => {
    expect(by("Henri Veesaar").status).toBe("out-for-season");
    expect(by("Ariel Hukporti").status).toBe("out-for-season"); // returns 2027-10-01
  });
  it("derives headline news with the player card link", () => {
    const n = news.find((x) => x.playerName === "Aaron Wiggins")!;
    expect(n.link).toMatch(/espn\.com\/nba\/player/);
    expect(n.title).toMatch(/Wiggins/);
  });
  it("rejects a non-ESPN body", () => {
    expect(() => parseEspnInjuries("<html>challenge</html>")).toThrow();
    expect(() => parseEspnInjuries("{}")).toThrow(/injuries/);
  });
});

describe("CBS injuries HTML", () => {
  const { reports } = parseCbsInjuries(fx("cbs-injuries.html"), NOW);
  const by = (n: string) => reports.find((r) => r.name === n)!;
  it("parses rows with the long player name", () => {
    expect(by("Aaron Wiggins")).toMatchObject({ status: "day-to-day", injury: "Lips", source: "CBS", reportedAt: "2026-10-07T00:00:00.000Z", estReturn: null });
  });
  it("parses 'Expected to be out until at least <date>' (year inferred) and out for the season", () => {
    expect(by("Jimmy Butler")).toMatchObject({ status: "out", estReturn: "2027-01-02" });
    expect(by("Henri Veesaar").status).toBe("out-for-season");
    // "Oct 1" reported Oct 7 can only mean next year -> past the season -> out for the season
    expect(by("Ariel Hukporti")).toMatchObject({ estReturn: "2027-10-01", status: "out-for-season" });
  });
  it("throws on a page without the table", () => {
    expect(() => parseCbsInjuries("<html></html>", NOW)).toThrow();
  });
});

describe("RotoWire injuries JSON", () => {
  const { reports } = parseRotowireInjuries(fx("rotowire-injuries.json"));
  it("maps statuses; return dates are paywalled (null); no report time", () => {
    expect(reports.length).toBeGreaterThan(3);
    for (const r of reports) {
      expect(r.estReturn).toBeNull();
      expect(r.reportedAt).toBeNull();
      expect(r.source).toBe("RotoWire");
    }
    expect(reports.find((r) => r.name === "Bradley Beal")!.status).toBe("day-to-day");
    expect(reports.some((r) => r.status === "out" || r.status === "out-for-season")).toBe(true);
  });
  it("rejects non-array JSON", () => expect(() => parseRotowireInjuries('{"a":1}')).toThrow());
});

describe("RSS + ESPN news", () => {
  it("parses Yahoo (CDATA) and CBS (whitespace padded) items", () => {
    const y = parseRss(fx("yahoo-rss.xml"), "Yahoo Sports");
    expect(y.length).toBe(3);
    expect(y[0].link).toMatch(/^https:\/\/sports\.yahoo\.com\//);
    expect(y[0].title).not.toMatch(/CDATA|^\s/);
    const c = parseRss(fx("cbs-rss.xml"), "CBS Sports");
    expect(c.length).toBe(3);
    expect(c[0].link).toMatch(/^https:\/\/www\.cbssports\.com\//);
    expect(Date.parse(c[0].publishedAt)).not.toBeNaN();
  });
  it("RotoWire: PDT dates and the 'Name:' prefix", () => {
    const r = parseRss(fx("rotowire-rss.xml"), "RotoWire", { nameFromTitlePrefix: true });
    expect(r[0].playerName).toBe("Brandin Podziemski");
    expect(r[0].publishedAt).toBe("2026-10-07T04:44:00.000Z"); // Tue 9:44 PM PDT
    expect(r[0].link).not.toContain(".com//");
  });
  it("throws on non-RSS", () => expect(() => parseRss("<html/>", "x")).toThrow(/RSS/));
  it("ESPN news JSON", () => {
    const n = parseEspnNews(fx("espn-news.json"));
    expect(n.length).toBeGreaterThan(0);
    expect(n[0].link).toMatch(/^https:\/\/www\.espn\.com/);
  });
});

describe("text helpers", () => {
  it("dates", () => {
    expect(parseRssDate("Wed, 07 Oct 2026 14:20:10 +0000")).toBe("2026-10-07T14:20:10.000Z");
    expect(parseRssDate("garbage")).toBeNull();
    expect(returnDateAfter("Jan 2", "2026-10-02")).toBe("2027-01-02");
    expect(returnDateAfter("Oct 1", "2026-10-07")).toBe("2027-10-01");
  });
  it("season-ending phrases", () => {
    expect(seasonEndingText("is expected to miss the 2026-27 season")).toBe(true);
    expect(seasonEndingText("will miss the remainder of the season")).toBe(true);
    expect(seasonEndingText("a few weeks")).toBe(false);
  });
});
