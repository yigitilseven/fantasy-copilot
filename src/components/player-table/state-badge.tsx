import type { RecommendationState } from "@/types";

const STYLE: Record<RecommendationState, string> = {
  DRAFT: "bg-brand text-brand-ink",
  TAKE: "bg-pos-bg text-pos border border-pos",
  WAIT: "bg-raised text-ink-2",
  "RISKY WAIT": "bg-warn-bg text-warn border border-warn",
  AVOID: "bg-neg-bg text-neg border border-neg",
};

export function StateBadge({ state }: { state: RecommendationState }) {
  return (
    <span data-testid="state-badge" className={`inline-block whitespace-nowrap rounded-md px-1.5 py-px text-[10px] font-semibold leading-4 ${STYLE[state]}`}>
      {state}
    </span>
  );
}
