import { injuryText } from "@/engine/recommendation/explain";
import type { Risk } from "@/types";

const PILL = {
  "day-to-day": { label: "DTD", cls: "border-warn bg-warn-bg text-warn" },
  out: { label: "O", cls: "border-neg bg-neg-bg text-neg" },
  "out-for-season": { label: "OFS", cls: "border-neg bg-neg-bg text-neg" },
} as const;

/** Tooltip text: status line, injury, source and date. */
export function statusTooltip(risk: Risk): string {
  const lines = [injuryText(risk) ?? ""];
  if (risk.injuryNote) lines.push(`Injury: ${risk.injuryNote}`);
  if (risk.estReturn) lines.push(`Est. return: ${risk.estReturn}`);
  return lines.filter(Boolean).join("\n");
}

/** Small O / DTD / OFS pill; nothing for healthy players. */
export function StatusPill({ risk }: { risk: Risk }) {
  if (risk.currentStatus === "healthy") return null;
  const p = PILL[risk.currentStatus];
  return (
    <span
      data-testid="status-pill"
      data-status={risk.currentStatus}
      title={statusTooltip(risk)}
      className={`ml-1 inline-block rounded-sm border px-1 text-[9px] font-bold leading-[14px] ${p.cls}`}
    >
      {p.label}
    </span>
  );
}
