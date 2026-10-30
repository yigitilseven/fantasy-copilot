import { describe, expect, it } from "vitest";
import type { CatRow } from "@/server/season";
import { catLeader, currentScore, defendCats, helpedCats, movesForCats } from "@/ui/matchup-parts";
import type { MoveSuggestion } from "@/engine/season/addDrop";

const row = (cat: string, youCur: number | null, oppCur: number | null, p: number): CatRow => ({ cat, youCur, oppCur, youProj: 0, oppProj: 0, p, leverage: 0, state: "toss-up" });
const mv = (name: string, reasons: string[], dWeek: number) => ({ add: { playerId: name, name }, reasons, dWeek }) as unknown as MoveSuggestion;

describe("matchup helpers", () => {
  it("TO is lower-is-better", () => {
    expect(catLeader(row("TO", 10, 14, 0.5))).toBe("you");
    expect(catLeader(row("PTS", 10, 14, 0.5))).toBe("opp");
    expect(catLeader(row("REB", 5, 5, 0.5))).toBe("tie");
    expect(catLeader(row("REB", null, 5, 0.5))).toBeNull();
  });
  it("counts the score only when captured", () => {
    const cats = [row("TO", 10, 14, 0.9), row("PTS", 10, 14, 0.4), row("FG%", 0.5, 0.4, 0.6)];
    expect(currentScore(cats, false)).toBeNull();
    expect(currentScore(cats, true)).toEqual({ you: 2, opp: 1, tie: 0 });
  });
  it("defends leads under 85%, weakest first", () => {
    const cats = [row("TO", 10, 14, 0.9), row("PTS", 20, 14, 0.6), row("REB", 20, 14, 0.7), row("AST", 1, 9, 0.4)];
    expect(defendCats(cats, true).map((c) => c.cat)).toEqual(["PTS", "REB"]);
    expect(defendCats(cats, false).map((c) => c.cat)).toEqual(["PTS", "REB"]);
  });
  it("reads helped categories from the this-week reason", () => {
    const m = mv("A", ["this week: REB +10.1 pp, 3PM +6.6 pp, FG% -1.0 pp", "costs TO -2.4 pp"], 0.1);
    expect(helpedCats(m)).toEqual(["REB", "3PM"]);
    const b = mv("B", ["this week: FG% +2.0 pp"], 0.3);
    const c = mv("C", ["costs REB -1 pp"], 0.9);
    expect(movesForCats([b, m, c], ["REB", "3PM"]).map((x) => x.m.add.name)).toEqual(["A"]);
    expect(movesForCats([b, m], ["REB", "3PM", "FG%"]).map((x) => x.m.add.name)).toEqual(["A", "B"]);
  });
});
