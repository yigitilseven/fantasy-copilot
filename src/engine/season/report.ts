import { rankMoves, type MoveSuggestion } from "./addDrop";
import { buildModel, type MatchupData } from "./evaluate";
import { catWinProbs, distOf, matchWinProb, type Dist } from "./matchup";
import { projectWindow, weightedValue } from "./window";
import { gamesInRange } from "./schedule";
import { SEASON_CATS, type LineupContext, type RosterEntry, type SeasonPlayer } from "./types";

/**
 * League analysis (pure): every team's projected weekly category line from its current roster and the per-player blended projections,
 * the user's rank in each category, head-to-head odds against every opponent in an average week, positional depth, and concrete moves.
 * All "weekly" numbers are the average of the next few full fantasy weeks (the schedule decides games per team).
 */

export interface ReportTeamInput { slot: number; name: string; isUser: boolean; entries: RosterEntry[] }

export interface ReportInput {
  ctx: LineupContext;
  players: ReadonlyMap<string, SeasonPlayer>;
  teams: ReportTeamInput[];
  freeAgentIds: readonly string[];
  pctOwned?: ReadonlyMap<string, number>;
  faSource: "captured" | "all-unrostered";
  matchup: MatchupData | null;
  schedule: { lastDate: string | null } | null;
  addsRemaining: number;
  addsLimit: number;
  /** Optional notes from the server (data provenance). */
  dataNotes?: string[];
  moveLimit?: number;
}

export interface TeamLine {
  slot: number;
  name: string;
  isUser: boolean;
  rostered: number;
  projected: number;
  /** Expected player-games in an average week. */
  games: number;
  /** Mean weekly value per category (SEASON_CATS order; FG%/FT% as fractions). */
  cats: number[];
  /** 1 = best in the league (TO: lowest). */
  ranks: number[];
  /** Average win probability against every other team (power ranking), 0..1. */
  power: number;
  powerRank: number;
}
export interface CatSummary {
  cat: string;
  value: number;
  rank: number;
  of: number;
  best: number;
  median: number;
  /** Mean P(user wins the category) over the 13 opponents. */
  avgWinP: number;
  label: "strength" | "weakness" | "swing" | "neutral";
  punt: boolean;
}
export interface H2HRow {
  slot: number;
  name: string;
  winProb: number;
  expCats: number;
  catP: number[];
  /** Categories the opponent is clearly ahead in (P(user wins) < 0.4) / the user clearly leads (> 0.6). */
  theyWin: string[];
  youWin: string[];
  tossUp: string[];
}
export interface DepthRow { pos: string; eligible: number; slots: number; leagueMedian: number; rank: number; weeklyGames: number; thin: boolean }
export interface InjuryRow { playerId: string; name: string; team: string; slot: string | null; flag: string; detail: string; onIl: boolean }
export interface DropRow { playerId: string; name: string; team: string; positions: string; /** Change in the average-week win probability if he is dropped with no replacement (negative = dropping hurts; sorted cheapest first). */ dWin: number; coreValue: number; note: string }
export interface HoldRow { playerId: string; name: string; reason: string }
export interface SeasonReport {
  date: string;
  weeksModeled: number;
  teams: TeamLine[];
  cats: CatSummary[];
  avgWinProb: number;
  expCatsWon: number;
  h2h: H2HRow[];
  depth: DepthRow[];
  ilUsed: number;
  ilSlots: number;
  injuries: InjuryRow[];
  moves: { items: MoveSuggestion[]; addsRemaining: number; addsLimit: number; faSource: "captured" | "all-unrostered"; faCount: number; baselineWeek: number; baselineRos: number };
  drops: DropRow[];
  holds: HoldRow[];
  punted: string[];
  notes: string[];
  summary: string[];
}

const POS5 = ["PG", "SG", "SF", "PF", "C"] as const;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;
const fmtCat = (cat: string, v: number) => (cat === "FG%" || cat === "FT%" ? v.toFixed(3).replace(/^0/, "") : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

/** Rank (1 = best) of `values[i]` among all; lowerBetter flips for turnovers. */
function ranksOf(values: number[], lowerBetter: boolean): number[] {
  return values.map((v) => 1 + values.filter((w) => (lowerBetter ? w < v : w > v)).length);
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

export function buildSeasonReport(input: ReportInput): SeasonReport {
  const { ctx, players, teams } = input;
  const user = teams.find((t) => t.isUser);
  if (!user) throw new Error("report needs a user team");
  const live = (t: ReportTeamInput) => t.entries.filter((e) => e.status !== "il").map((e) => players.get(e.playerId)).filter((p): p is SeasonPlayer => !!p);
  const opponents = teams.filter((t) => !t.isUser).map((t) => ({ slot: t.slot, name: t.name, players: live(t) }));
  const model = buildModel(ctx, opponents, null, input.schedule);
  const weeks = model.rosWeeks;
  const notes: string[] = [...(input.dataNotes ?? [])];

  // Per team and week: category distribution of an average (full) week.
  const dists = new Map<number, Dist[]>();
  const gamesPerWeek = new Map<number, number>();
  for (const t of teams) {
    const roster = live(t);
    let g = 0;
    dists.set(t.slot, weeks.map((dates) => {
      const w = projectWindow(roster, dates, ctx);
      g += w.playerGames / weeks.length;
      return distOf(null, w);
    }));
    gamesPerWeek.set(t.slot, g);
  }
  const meanCats = (slot: number): number[] => SEASON_CATS.map((_, c) => dists.get(slot)!.reduce((a, d) => a + d.mean[c], 0) / weeks.length);
  const winVs = (a: number, b: number): { catP: number[]; winProb: number } => {
    const catP = new Array<number>(9).fill(0);
    let win = 0;
    weeks.forEach((_, w) => {
      const p = catWinProbs(dists.get(a)![w], dists.get(b)![w]);
      p.forEach((x, i) => (catP[i] += x / weeks.length));
      win += matchWinProb(p) / weeks.length;
    });
    return { catP, winProb: win };
  };

  const cats = teams.map((t) => meanCats(t.slot));
  const rankByCat = SEASON_CATS.map((c, i) => ranksOf(cats.map((v) => v[i]), c === "TO"));
  const power = teams.map((t) => {
    const others = teams.filter((o) => o.slot !== t.slot);
    return others.reduce((a, o) => a + winVs(t.slot, o.slot).winProb, 0) / Math.max(1, others.length);
  });
  const powerRank = ranksOf(power, false);
  const lines: TeamLine[] = teams.map((t, ti) => ({
    slot: t.slot, name: t.name, isUser: t.isUser, rostered: t.entries.length, projected: t.entries.filter((e) => players.has(e.playerId)).length,
    games: Math.round((gamesPerWeek.get(t.slot) ?? 0) * 10) / 10, cats: cats[ti], ranks: SEASON_CATS.map((_, c) => rankByCat[c][ti]), power: power[ti], powerRank: powerRank[ti],
  }));
  const ui = teams.findIndex((t) => t.isUser);

  // Head to head
  const h2h: H2HRow[] = teams
    .filter((t) => !t.isUser)
    .map((t) => {
      const { catP, winProb } = winVs(user.slot, t.slot);
      return {
        slot: t.slot, name: t.name, winProb, expCats: catP.reduce((a, b) => a + b, 0), catP,
        theyWin: SEASON_CATS.filter((_, i) => catP[i] < 0.4), youWin: SEASON_CATS.filter((_, i) => catP[i] > 0.6), tossUp: SEASON_CATS.filter((_, i) => catP[i] >= 0.4 && catP[i] <= 0.6),
      };
    })
    .sort((a, b) => a.winProb - b.winProb);
  const avgWinProb = h2h.reduce((a, r) => a + r.winProb, 0) / Math.max(1, h2h.length);
  const expCatsWon = h2h.reduce((a, r) => a + r.expCats, 0) / Math.max(1, h2h.length);

  // Category summary: strengths = top 4 ranks, weaknesses = bottom 4, swing = the rest that are close to a coin flip on average.
  const n = teams.length;
  const catSummary: CatSummary[] = SEASON_CATS.map((cat, i) => {
    const avgP = h2h.reduce((a, r) => a + r.catP[i], 0) / Math.max(1, h2h.length);
    const rank = rankByCat[i][ui];
    const col = cats.map((v) => v[i]);
    const best = cat === "TO" ? Math.min(...col) : Math.max(...col);
    const label: CatSummary["label"] = rank <= 4 ? "strength" : rank > n - 4 ? "weakness" : avgP >= 0.35 && avgP <= 0.65 ? "swing" : "neutral";
    return { cat, value: cats[ui][i], rank, of: n, best, median: median(col), avgWinP: avgP, label, punt: rank >= n - 2 && avgP < 0.25 };
  });
  const punted = catSummary.filter((c) => c.punt).map((c) => c.cat);

  // Depth by position
  const mine = live(user);
  const elig = (ps: SeasonPlayer[], pos: string) => ps.filter((p) => p.positions.includes(pos as never));
  const leagueElig = POS5.map((pos) => teams.map((t) => elig(live(t), pos).length));
  const weekStart = weeks[0]?.[0];
  const weekEnd = weeks[0]?.[weeks[0].length - 1];
  const depth: DepthRow[] = POS5.map((pos, k) => {
    const e = elig(mine, pos);
    const slots = ctx.settings.rosterSlots.filter((s) => s === pos).length;
    const g = ctx.schedule && weekStart && weekEnd ? e.reduce((a, p) => a + gamesInRange(ctx.schedule, p.team, weekStart, weekEnd), 0) : e.length * 3.5;
    const need = slots + 1;
    return { pos, eligible: e.length, slots, leagueMedian: median(leagueElig[k]), rank: 1 + leagueElig[k].filter((v) => v > e.length).length, weeklyGames: Math.round(g * 10) / 10, thin: (slots >= 2 && e.length <= need) || e.length < median(leagueElig[k]) - 1 };
  });

  // Injuries / IL usage
  const injuries: InjuryRow[] = user.entries
    .map((e) => ({ e, p: players.get(e.playerId) }))
    .filter((x): x is { e: RosterEntry; p: SeasonPlayer } => !!x.p && (x.p.injury.flag !== "healthy" || x.e.status === "il"))
    .map(({ e, p }) => ({
      playerId: p.id, name: p.name, team: p.team, slot: e.slot, flag: p.injury.flag,
      detail: [p.injury.injury, p.injury.estReturn ? `back ${p.injury.estReturn}` : null, p.injury.tag ? `tag ${p.injury.tag}` : null].filter(Boolean).join(", "), onIl: e.status === "il",
    }));
  const ilUsed = user.entries.filter((e) => e.status === "il").length;

  // Moves from the real FA pool
  const res = rankMoves({
    ctx, players, entries: user.entries, opponents, freeAgentIds: input.freeAgentIds, pctOwned: input.pctOwned, matchup: input.matchup, schedule: input.schedule,
    addsRemaining: input.addsRemaining, limit: input.moveLimit ?? 10,
  });
  if (res.notes.length) notes.push(...res.notes);

  // Drop candidates: contribution to the average-week win probability, judged on the cats that matter (punted ones count zero).
  const core = SEASON_CATS.map((c) => (punted.includes(c) ? 0 : 1));
  const baseRos = model.ros(mine);
  const baseWeek = model.week(mine);
  const drops: DropRow[] = mine
    .map((p) => {
      const r = model.ros(mine.filter((x) => x.id !== p.id));
      const cv = weightedValue(p, core);
      const offCore = punted.length ? weightedValue(p) - cv : 0;
      return {
        playerId: p.id, name: p.name, team: p.team, positions: p.positions.join("/"), dWin: r.winProb - baseRos.winProb, coreValue: cv,
        note: [p.injury.flag !== "healthy" ? `${p.injury.flag}${p.injury.estReturn ? ` until ${p.injury.estReturn}` : ""}` : null, offCore > Math.abs(cv) && punted.length ? `value is mostly in punted ${punted.join("/")}` : null].filter(Boolean).join("; "),
      };
    })
    .sort((a, b) => b.dWin - a.dWin || a.coreValue - b.coreValue)
    .slice(0, 5);

  const holds: HoldRow[] = [...mine]
    .sort((a, b) => weightedValue(b, core) * b.avail - weightedValue(a, core) * a.avail)
    .slice(0, 10)
    .filter((p) => p.injury.flag === "gtd" || (p.injury.flag === "out" && p.injury.estReturn))
    .map((p) => ({ playerId: p.id, name: p.name, reason: p.injury.flag === "gtd" ? "top-10 core value and only day-to-day: hold, do not drop on a short absence" : `top-10 core value; out only until ${p.injury.estReturn}: use IL if a slot is free, otherwise hold` }));

  // Plain-language summary
  const summary: string[] = [];
  summary.push(`In an average week you win about ${pct(avgWinProb)} of matchups against this league (expected ${expCatsWon.toFixed(1)} of 9 categories); by that measure you are #${lines[ui].powerRank} of ${n} teams.`);
  const strong = catSummary.filter((c) => c.label === "strength");
  const weak = catSummary.filter((c) => c.label === "weakness");
  summary.push(`Strengths (top-4 in the league): ${strong.length ? strong.map((c) => `${c.cat} #${c.rank}`).join(", ") : "none"}. Weaknesses (bottom-4): ${weak.length ? weak.map((c) => `${c.cat} #${c.rank}`).join(", ") : "none"}.`);
  const swing = catSummary.filter((c) => c.label === "swing");
  if (swing.length) summary.push(`Swing categories (about a coin flip against the average opponent): ${swing.map((c) => `${c.cat} ${pct(c.avgWinP)}`).join(", ")}. These are where a pickup changes results most.`);
  if (punted.length) summary.push(`Your build effectively punts ${punted.join(", ")} (bottom of the league and rarely won): moves below ignore those categories when judging drops.`);
  const tough = h2h.slice(0, 3);
  summary.push(`Toughest opponents: ${tough.map((r) => `${r.name} (${pct(r.winProb)}${r.theyWin.length ? `, they lead ${r.theyWin.join("/")}` : ""})`).join("; ")}. Easiest: ${h2h.slice(-2).map((r) => `${r.name} (${pct(r.winProb)})`).join(", ")}.`);
  const thin = depth.filter((d) => d.thin);
  summary.push(thin.length ? `Depth: thin at ${thin.map((d) => `${d.pos} (${d.eligible} eligible, league median ${d.leagueMedian})`).join(", ")}.` : "Depth: no position is thin against the league.");
  const hurt = injuries.filter((i) => i.flag !== "healthy");
  if (hurt.length) summary.push(`Injuries: ${hurt.map((i) => `${i.name} (${i.flag}${i.onIl ? ", on IL" : ""})`).join(", ")}; IL slots used ${ilUsed}/${ctx.settings.ilSlots}.`);
  const season = res.moves.find((m) => m.dRos > 0.003);
  const stream = res.moves.find((m) => m.dWeek > 0.01);
  const fmtMove = (m: MoveSuggestion) => `add ${m.add.name} (${m.add.positions})${m.ilMove ? `, put ${m.ilMove.name} on IL` : m.drop ? `, drop ${m.drop.name}` : ""}: average week ${pp(m.dRos)}, this week ${pp(m.dWeek)}${m.blocked ? ` (${m.blocked})` : ""}`;
  if (season) summary.push(`Best season-long add: ${fmtMove(season)}.`);
  else summary.push(`No free agent improves your average week (${input.freeAgentIds.length} candidates checked from the ${input.faSource === "captured" ? "Yahoo free-agent pool" : "unrostered projections"}): hold your roster for the long run.`);
  if (stream) summary.push(`Best short-term stream (only worth an add if you have one to spare, ${input.addsRemaining} of ${input.addsLimit} left): ${fmtMove(stream)}.`);
  const unprojected = lines.filter((l) => l.projected < l.rostered);
  if (unprojected.length) notes.push(`${unprojected.length} team(s) have rostered players without a projection (ignored): ${unprojected.map((l) => `${l.name} ${l.rostered - l.projected}`).join(", ")}.`);
  notes.push("Actual 2026-27 stats to date are not used: the season is days old, so projections (blended Yahoo 2026-27 and last season) carry the numbers. 'Hold' notes therefore come from availability and projected value, not from a slump.");

  return {
    date: ctx.today, weeksModeled: weeks.length, teams: lines, cats: catSummary, avgWinProb, expCatsWon, h2h, depth, ilUsed, ilSlots: ctx.settings.ilSlots, injuries,
    moves: { items: res.moves, addsRemaining: input.addsRemaining, addsLimit: input.addsLimit, faSource: input.faSource, faCount: input.freeAgentIds.length, baselineWeek: baseWeek.winProb, baselineRos: baseRos.winProb },
    drops, holds, punted, notes, summary,
  };
}

/** Terminal / plain-text rendering of a report. */
export function renderReportText(r: SeasonReport): string {
  const out: string[] = [];
  const h = (t: string) => out.push("", t, "-".repeat(t.length));
  out.push(`LEAGUE REPORT  ${r.date}  (average of the next ${r.weeksModeled} full weeks)`);
  h("Summary");
  for (const s of r.summary) out.push(`* ${s}`);
  h("Your categories (weekly projection, rank of " + r.teams.length + ")");
  for (const c of r.cats) out.push(`${c.cat.padEnd(4)} ${fmtCat(c.cat, c.value).padStart(6)}  #${String(c.rank).padEnd(2)} (best ${fmtCat(c.cat, c.best)}, median ${fmtCat(c.cat, c.median)})  P(win cat) ${pct(c.avgWinP).padStart(4)}  ${c.label}${c.punt ? " [punt]" : ""}`);
  h("League table (weekly projected categories, power = win% vs the other 13)");
  out.push(`${"Team".padEnd(26)} gms  ${SEASON_CATS.map((c) => c.padStart(5)).join(" ")}  power`);
  for (const t of [...r.teams].sort((a, b) => a.powerRank - b.powerRank)) out.push(`${(t.isUser ? "> " : "  ") + t.name.slice(0, 24).padEnd(24)} ${String(t.games).padStart(4)}  ${t.cats.map((v, i) => fmtCat(SEASON_CATS[i], v).padStart(5)).join(" ")}  ${pct(t.power).padStart(4)} #${t.powerRank}`);
  h("Head to head, average week (hardest first)");
  for (const x of r.h2h) out.push(`${x.name.slice(0, 26).padEnd(26)} win ${pct(x.winProb).padStart(4)}  cats ${x.expCats.toFixed(1)}  they lead: ${x.theyWin.join(" ") || "-"}  you lead: ${x.youWin.join(" ") || "-"}  toss-up: ${x.tossUp.join(" ") || "-"}`);
  h("Depth");
  for (const d of r.depth) out.push(`${d.pos.padEnd(3)} eligible ${d.eligible} (slots ${d.slots}, league median ${d.leagueMedian}, rank #${d.rank})  games next week ${d.weeklyGames}${d.thin ? "  THIN" : ""}`);
  out.push(`IL ${r.ilUsed}/${r.ilSlots}`);
  for (const i of r.injuries) out.push(`  ${i.name} (${i.team}) ${i.flag}${i.onIl ? " [IL]" : ""} ${i.detail}`);
  h(`Best moves (${r.moves.faCount} candidates from the ${r.moves.faSource === "captured" ? "Yahoo free-agent pool" : "unrostered projections"}; ${r.moves.addsRemaining}/${r.moves.addsLimit} adds left)`);
  out.push(`baseline: this week ${pct(r.moves.baselineWeek)}, average week ${pct(r.moves.baselineRos)}`);
  for (const m of r.moves.items) {
    out.push(`${m.label}: add ${m.add.name} (${m.add.team} ${m.add.positions}${m.add.pctOwned != null ? `, ${m.add.pctOwned}% owned` : ""})${m.ilMove ? ` + ${m.ilMove.name} to IL` : m.drop ? `, drop ${m.drop.name}` : ""} | avg week ${pp(m.dRos)} | this week ${pp(m.dWeek)}${m.blocked ? ` [${m.blocked}]` : ""}`);
    for (const x of [...m.reasons, ...m.news.map((n) => `news: ${n}`)]) out.push(`    ${x}`);
  }
  if (!r.moves.items.length) out.push("(none)");
  h("Drop candidates (cheapest first)");
  for (const d of r.drops) out.push(`${d.name.padEnd(24)} ${d.team} ${d.positions.padEnd(10)} dropping changes avg-week win ${pp(d.dWin)}  core value ${d.coreValue.toFixed(2)}${d.note ? `  (${d.note})` : ""}`);
  if (r.holds.length) {
    h("Hold");
    for (const x of r.holds) out.push(`${x.name}: ${x.reason}`);
  }
  if (r.notes.length) {
    h("Notes");
    for (const n of r.notes) out.push(`* ${n}`);
  }
  return out.join("\n");
}
