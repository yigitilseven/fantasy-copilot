import type { Category, CategoryScores, PlayerScore, Risk } from "@/types";
import { CATEGORIES } from "@/types";
import type { RotoCategory } from "../evaluation/standings";
import type { CandidateResult, RotoAnalysis } from "../standings-opt/expected";
import { VIEW_LABELS, displayCat } from "../standings-opt/lines";

/** The n categories with the highest need weight (ties broken by CATEGORIES order). */
export function topNeedCategories(weights: CategoryScores, n = 3): Category[] {
  return [...CATEGORIES]
    .map((c, i) => ({ c, i, w: weights[c] }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .slice(0, n)
    .map((x) => x.c);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-15" / ISO timestamp -> "Nov 15" (UTC, deterministic). */
export function shortDate(iso: string | undefined): string | null {
  const m = iso ? /^\d{4}-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}` : null;
}

/** "Out — est. return Nov 15 (ESPN, Oct 6)"; null for healthy players. */
export function injuryText(risk: Pick<Risk, "currentStatus" | "estReturn" | "statusSource" | "statusUpdatedAt" | "injuryNote">): string | null {
  if (risk.currentStatus === "healthy") return null;
  const label = risk.currentStatus === "out-for-season" ? "Out for the season" : risk.currentStatus === "out" ? "Out" : "Day-to-day";
  const ret = risk.currentStatus === "out" ? shortDate(risk.estReturn) : null;
  const note = !ret && risk.injuryNote && risk.injuryNote.length <= 30 ? ` (${risk.injuryNote.toLowerCase()})` : "";
  const when = shortDate(risk.statusUpdatedAt);
  const src = risk.statusSource ? ` (${[risk.statusSource, when].filter(Boolean).join(", ")})` : "";
  return `${label}${ret ? ` — est. return ${ret}` : ""}${note}${src}`;
}

/** "IL stash: out until ~Dec 10 (ESPN), ~70% of season left — strong value for a late pick." */
export function ilStashText(risk: Pick<Risk, "estReturn" | "statusSource" | "gamesMissed">): string {
  const when = shortDate(risk.estReturn);
  const left = Math.round(100 * Math.max(0, 1 - (risk.gamesMissed ?? 0) / 82));
  return `IL stash: out until ~${when ?? "later"}${risk.statusSource ? ` (${risk.statusSource})` : ""}, ~${left}% of season left — strong value for a late pick.`;
}

export { displayCat };

/**
 * Standings reason for one evaluated candidate.
 *  h2h:  "Strengthens your core (REB, BLK): weekly win odds 58% -> 62%." / "Builds toward AST, PTS: ..." / "... little change ..."
 *  roto: "Lifts your weakest view (Proj: #7 -> #5): +PTS, +AST."
 */
export function rotoReason(a: RotoAnalysis, c: CandidateResult): string {
  if (a.objective.kind === "h2h") {
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const odds = `weekly win odds ${pct(a.baseline.h2h.winProb)} \u2192 ${pct(c.winProb)}`;
    const moves = c.moves.slice(0, 4);
    const core = moves.filter((m) => a.baseline.h2h.core.includes(m));
    if (c.dWinProb < -0.002) return `Costs weekly win odds (${pct(a.baseline.h2h.winProb)} \u2192 ${pct(c.winProb)}).`;
    if (core.length > 0) return `Strengthens your core (${core.map(displayCat).join(", ")}): ${odds}.`;
    if (moves.length > 0) return `Builds toward ${moves.map(displayCat).join(", ")}: ${odds}.`;
    return `Little change to your weekly matchups (${pct(a.baseline.h2h.winProb)} \u2192 ${pct(c.winProb)}).`;
  }
  const view = a.baseline.weakest;
  const b = a.baseline.views[view];
  const x = c.views[view];
  const cats = (Object.entries(x.dCats) as [RotoCategory, number][]).filter(([, d]) => d >= 0.3).sort((p, q) => q[1] - p[1]).slice(0, 3).map(([k]) => `+${displayCat(k)}`);
  const head = `Lifts your weakest view (${VIEW_LABELS[view]}: #${b.rankMedian} \u2192 #${x.rankMedian})`;
  return cats.length > 0 ? `${head}: ${cats.join(", ")}.` : `${head}.`;
}

export interface ExplainContext {
  /** Standings sentence (see rotoReason); leads the explanation when present. */
  roto?: string;
  /** IL-stash sentence (see ilStashText); set when the player is scored as a stash. */
  ilStash?: string;
  /** Current injury line (see injuryText); omitted for healthy players. */
  injury?: string | null;
  userNextPick: number | null;
  topNeeds: Category[];
  /** Optional: team-need categories this player is positive in (computed by scorePlayers). */
  addresses?: Category[];
  /** Set when a non-neutral strategy is active; weakPunted = punted categories this player is clearly negative in. */
  strategy?: { preset: string; punted: Category[]; weakPunted: Category[] };
}

/** Deterministic template explanation. */
export function explain(score: PlayerScore, ctx: ExplainContext): string {
  const parts: string[] = [];

  const fitGap = score.rosterFit - score.nineCat;
  if (fitGap >= 4) parts.push("Strong roster fit");
  else if (fitGap <= -4) parts.push("Weaker fit for your current roster than raw value suggests");
  else if (score.nineCat >= 85) parts.push("Elite raw value");
  else parts.push("Solid raw value");

  const s = score.survival;
  const pick = ctx.userNextPick != null ? ` until your next selection (#${ctx.userNextPick})` : "";
  if (s == null) {
    // no survival information
  } else {
    const pct = Math.round(s * 100);
    if (s < 0.1) parts.push(`extremely unlikely to survive${pick} (${pct}%)`);
    else if (s < 0.35) parts.push(`unlikely to survive${pick} (${pct}%)`);
    else if (s <= 0.7) parts.push(`about ${pct}% to survive${pick}`);
    else parts.push(`likely to still be available${pick} (${pct}%)`);
  }

  let text = parts[0] + (parts.length > 1 ? " and " + parts.slice(1).join(", ") : "") + ".";
  if (ctx.roto) text = `${ctx.roto} ${text}`;

  const hits = (ctx.addresses ?? []).filter((c) => ctx.topNeeds.includes(c));
  if (hits.length > 0) text += ` Helps your needs in ${hits.join(", ")}.`;

  const st = ctx.strategy;
  if (st && st.punted.length > 0 && st.weakPunted.length > 0) {
    const name = st.punted.map((c) => c.replace("%", "")).join("/");
    text += ` Fits punt-${name} build (${st.weakPunted.join(", ")} ${st.weakPunted.length > 1 ? "are" : "is"} punted).`;
  }

  if (ctx.injury) text += ` ${ctx.injury}.`;
  if (ctx.ilStash) text += ` ${ctx.ilStash}`;

  if (score.recommendation === "AVOID") text += ` Risk is too high (${score.riskLabel}, ${Math.round(score.riskScore)}).`;
  else if (score.riskLabel !== "Low") text += ` ${score.riskLabel} injury risk costs ${score.riskPenalty.toFixed(1)} points.`;
  return text;
}
