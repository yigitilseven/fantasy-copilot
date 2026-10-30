import fs from "node:fs";
import path from "node:path";
import { YahooError } from "@/integrations/yahoo/errors";

export const FIXDIR = path.resolve(__dirname, "fixtures-yahoo");
export const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXDIR, name), "utf8"));

export interface FakeOpts {
  /** Make the ";out=" collection form fail with NOT_FOUND, forcing fallbacks. */
  outFormFails?: boolean;
  /** Make collection stats fail, forcing per-player stats. */
  collectionStatsFail?: boolean;
  /** Projected stats available (otherwise empty stats). */
  projected?: boolean;
}

const SINGLE: Record<string, string> = { "466.p.5352": "jokic", "466.p.5864": "sga", "466.p.6015": "wemby", "466.p.4612": "kawhi" };

/** Fake yahooGet routed over the fixtures. Records every requested path in `calls`. */
export function fakeGet(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const get = async (p: string): Promise<unknown> => {
    calls.push(p);
    if (p === "game/nba") return fixture("game-nba.json");
    if (/^game\/466\/players;start=0;count=25;sort=OR;out=/.test(p)) {
      if (opts.outFormFails) throw new YahooError("NOT_FOUND", "bad out");
      return fixture("players-or-page1.json");
    }
    if (/^game\/466\/players;start=0;count=3;sort=OR;out=/.test(p)) return fixture("players-or-page1.json");
    if (/^game\/466\/players;start=\d+;count=\d+;sort=OR(\/.*)?$/.test(p)) return fixture("players-or-page1.json");
    if (/^game\/466\/players;start=25/.test(p)) return { fantasy_content: { game: [{}, { players: { count: 0 } }] } };
    if (/^game\/466\/players;player_keys=.*\/stats;type=season;season=2025$/.test(p)) {
      if (opts.collectionStatsFail) throw new YahooError("PARSE", "nope");
      return fixture("players-stats-season-2025.json");
    }
    if (/^game\/466\/players;player_keys=.*\/stats;type=projected_season$/.test(p)) throw new YahooError("NOT_FOUND", "no collection projected");
    let m = /^player\/(466\.p\.\d+)\/stats;type=season;season=2025$/.exec(p);
    if (m) {
      const f = SINGLE[m[1]];
      if (!f) throw new YahooError("NOT_FOUND", "no stats");
      return fixture(`player-season-2025-${f}.json`);
    }
    m = /^player\/(466\.p\.\d+)\/stats;type=projected_season$/.exec(p);
    if (m) return fixture(opts.projected ? "player-projected-ok.json" : "player-projected-empty.json");
    m = /^player\/(466\.p\.\d+)\/(draft_analysis|percent_owned)$/.exec(p);
    if (m) {
      const full = fixture("players-or-page1.json") as { fantasy_content: { game: [unknown, { players: Record<string, { player: unknown[] }> }] } };
      const hit = Object.values(full.fantasy_content.game[1].players).find((x) => typeof x === "object" && JSON.stringify(x).includes(`"${m![1]}"`));
      return { fantasy_content: { player: (hit as { player: unknown[] }).player } };
    }
    if (p === "users;use_login=1/games;game_keys=nba/leagues") return fixture("users-leagues.json");
    if (p === "users;use_login=1/games;game_keys=nba/teams") return fixture("users-teams.json");
    if (/^league\/.*\/settings$/.test(p)) return fixture("league-settings.json");
    if (/^league\/.*\/draftresults$/.test(p)) return fixture("league-draftresults.json");
    throw new YahooError("NOT_FOUND", `fake: unrouted ${p}`);
  };
  return { get, calls };
}
