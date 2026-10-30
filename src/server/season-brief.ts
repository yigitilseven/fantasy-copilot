import type { Db } from "@/db/client";
import { getBrief, getLeague, saveBrief } from "@/db/season";
import { gameDayOf } from "@/engine/season/schedule";
import { computeSeason, type SeasonOverview, type StateOptions } from "./season";

export interface SeasonBrief {
  day: string;
  generatedAt: string;
  headline: string;
  sections: { title: string; lines: string[] }[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;
const age = (ms: number | null) => (ms == null ? "never" : ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m ago` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h ago` : `${Math.round(ms / 86_400_000)}d ago`);

/** Pure: turns an overview into the daily brief (suggestions only; nothing here acts on Yahoo). */
export function makeBrief(o: SeasonOverview): SeasonBrief {
  const wk = o.week;
  const sections: SeasonBrief["sections"] = [];
  const head = `${o.league.userTeam}: ${o.preview ? `opening-day preview ${o.date}` : o.date}${wk.number ? ` - week ${wk.number} (${wk.start} to ${wk.end})` : ""}${wk.opponent ? ` vs ${wk.opponent}` : ""}`;
  const lineup = o.lineup;

  const l: string[] = [];
  if (o.preview) l.push(`Season has not started yet (today ${o.realDate}): this is the opening-day preview for ${o.date}, from the draft rosters and current injury news.`);
  else if (o.seasonStarted === false) l.push(`Season has not started yet (first game ${o.freshness.schedule.firstDate ?? "unknown"}): this is what the model would do on ${o.date}.`);
  l.push(`${lineup.gamesToday} of your players have a game today; ${lineup.starters.length}/${o.league.settings.rosterSlots.length} slots filled.`);
  for (const s of lineup.starters) l.push(`${s.slot.padEnd(4)} ${s.name} (${s.team}) - ${s.reason}${s.flags.length ? ` [${s.flags.join(",")}]` : ""}`);
  if (lineup.bench.length) l.push(`Bench: ${lineup.bench.map((b) => `${b.name}${b.hasGame ? "*" : ""} (${b.reason.split(",")[0].toLowerCase()})`).join("; ")}   (* = has a game)`);
  for (const c of lineup.changes) l.push(`${c.type === "start" ? "START" : "SIT"} ${c.name}${c.toSlot ? ` at ${c.toSlot}` : ""}: ${c.reason}`);
  for (const m of lineup.ilMoves) l.push(m.reason);
  for (const n of lineup.notes) l.push(n);
  sections.push({ title: "Today's lineup", lines: l });

  const w: string[] = [];
  w.push(`${wk.matchupCaptured ? "Matchup win probability" : "Win probability vs an average opponent (no matchup page read yet)"}: ${pct(wk.winProb)}. Adds used ${wk.addsUsed}/${wk.addsLimit} (${wk.addsRemaining} left).`);
  w.push(`Player-games left: you ${wk.youGames} vs ${wk.oppGames}.`);
  const toss = wk.cats.filter((c) => c.state === "toss-up" || c.state === "leaning").sort((a, b) => Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5));
  if (toss.length) w.push(`Swing categories: ${toss.map((c) => `${c.cat} ${pct(c.p)}`).join(", ")}.`);
  const locked = wk.cats.filter((c) => c.state === "secured" || c.state === "lost");
  if (locked.length) w.push(`Decided: ${locked.map((c) => `${c.cat} ${c.state === "secured" ? "won" : "lost"}`).join(", ")}.`);
  sections.push({ title: "This week", lines: w });

  if (o.alerts.length) sections.push({ title: "Alerts", lines: o.alerts.map((a) => `${a.title}: ${a.detail}`) });

  const m: string[] = [];
  for (const mv of o.moves.items.slice(0, 5)) {
    m.push(`${mv.label}: add ${mv.add.name} (${mv.add.team} ${mv.add.positions})${mv.ilMove ? `, move ${mv.ilMove.name} to IL` : mv.drop ? `, drop ${mv.drop.name}` : ""} | week ${pp(mv.dWeek)}, rest of season ${pp(mv.dRos)}${mv.blocked ? ` [${mv.blocked}]` : ""}`);
    for (const r of mv.reasons.slice(0, 2)) m.push(`    ${r}`);
    for (const n of mv.news.slice(0, 2)) m.push(`    news: ${n}`);
  }
  if (!m.length) m.push("No add/drop beats your roster by a meaningful margin.");
  if (o.moves.faSource === "all-unrostered") m.push(`(Free-agent pool not captured from Yahoo yet: candidates are all ${o.moves.faCount} unrostered players with projections.)`);
  sections.push({ title: "Moves", lines: m });

  const f = o.freshness;
  const d: string[] = [
    `Roster ${f.roster.source === "yahoo-page" ? `synced ${age(f.roster.ageMs)}` : "from the draft (no Yahoo My Team page read yet)"}; free agents ${f.freeAgents.usable ? `${f.freeAgents.count} captured ${age(f.freeAgents.ageMs)}` : "not captured"}; news ${age(f.news.ageMs)}${f.news.stale ? " (stale)" : ""}; schedule ${f.schedule.assumed ? "unavailable (3.5 games/week assumed)" : `${f.schedule.games} games, fetched ${age(f.schedule.ageMs)}`}; matchup ${f.matchup.currentWeek ? `read ${age(f.matchup.ageMs)}` : "not read this week"}.`,
  ];
  sections.push({ title: "Data", lines: d });

  const top = o.moves.items.find((x) => !x.blocked);
  const headline = `${lineup.starters.length} starters set${lineup.changes.length ? `, ${lineup.changes.length} lineup change(s)` : ""}; matchup ${pct(wk.winProb)}${top ? `; top move: ${top.label.toLowerCase()} ${top.add.name}` : ""}`;
  return { day: o.date, generatedAt: o.generatedAt, headline: `${head} - ${headline}`, sections };
}

export function renderBriefText(b: SeasonBrief): string {
  const out = [b.headline, ""];
  for (const s of b.sections) {
    out.push(s.title.toUpperCase());
    for (const l of s.lines) out.push(`  ${l}`);
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

/** The stored brief for the game day, generating (and storing) it once per day; `force` regenerates. Null without a league. */
export function getOrCreateBrief(db: Db, opts: StateOptions & { force?: boolean } = {}): { brief: SeasonBrief; created: boolean } | null {
  const lg = getLeague(db, opts.leagueId);
  if (!lg) return null;
  const today = gameDayOf(opts.now ?? Date.now(), lg.settings.timezone);
  const day = opts.date ?? today;
  // Only the real game day is stored: a preview for another date is computed fresh (and never shadows that day's own brief later).
  const store = day === today;
  if (store && !opts.force) {
    const hit = getBrief<SeasonBrief>(db, lg.id, day);
    if (hit) return { brief: hit.payload, created: false };
  }
  const overview = computeSeason(db, { ...opts, date: opts.date });
  if (!overview) return null;
  const brief = makeBrief(overview);
  if (store) saveBrief(db, lg.id, day, brief);
  return { brief, created: store };
}
