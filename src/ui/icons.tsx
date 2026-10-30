/** Line icons used by the Copilot shell (24px grid, 1.6 stroke, currentColor). */
type P = { className?: string };
const base = (className = "h-6 w-6") => ({ className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true });

export const IconToday = ({ className }: P) => (
  <svg {...base(className)}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>
);
export const IconMoves = ({ className }: P) => (
  <svg {...base(className)}><path d="M4 8h15M15 4l4 4-4 4" /><path d="M20 16H5M9 12l-4 4 4 4" /></svg>
);
export const IconMatchup = ({ className }: P) => (
  <svg {...base(className)}><path d="M4 20h16" /><path d="M6 17v-3M10 17v-6M14 17v-4M18 17V8" /><path d="M5 11l5-4 4 3 6-6" /></svg>
);
export const IconLeague = ({ className }: P) => (
  <svg {...base(className)}><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4" /><path d="M12 13v4M9 20h6" /></svg>
);
export const IconSliders = ({ className }: P) => (
  <svg {...base(className)}><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>
);
export const IconInfo = ({ className }: P) => (
  <svg {...base(className ?? "h-3.5 w-3.5")}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
);
export const IconCheck = ({ className }: P) => (
  <svg {...base(className)}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
export const IconArrow = ({ className }: P) => (
  <svg {...base(className ?? "h-4 w-4")}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const IconBack = ({ className }: P) => (
  <svg {...base(className ?? "h-4 w-4")}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
);
export const IconChevron = ({ className }: P) => (
  <svg {...base(className ?? "h-3 w-3")}><path d="M6 9l6 6 6-6" /></svg>
);
export const IconExternal = ({ className }: P) => (
  <svg {...base(className ?? "h-3.5 w-3.5")}><path d="M8 16L16 8M9 8h7v7" /></svg>
);
export const IconBell = ({ className }: P) => (
  <svg {...base(className)}><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
);

/** The "C/" app mark. */
export const Logo = ({ size = 32 }: { size?: number }) => (
  <span className="inline-flex shrink-0 items-center justify-center rounded-[9px] bg-brand font-semibold text-white" style={{ width: size, height: size, fontSize: size * 0.48, letterSpacing: "-0.04em" }} aria-hidden>
    C/
  </span>
);
