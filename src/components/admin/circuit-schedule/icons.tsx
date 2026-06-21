import type { SVGProps } from "react";

/** Line icons (Lucide-ish, 24-grid, currentColor) — ported from the design's cs-shell. */
const base = (props: SVGProps<SVGSVGElement>) => ({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

export const Ic = {
  board: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 9v12M14 13l-2 3h3l-2 3" /></svg>
  ),
  zap: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>
  ),
  trash: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" /></svg>
  ),
  copy: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
  ),
  chev: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base({ strokeWidth: 2, ...p })}><path d="m6 9 6 6 6-6" /></svg>
  ),
  printer: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z" /></svg>
  ),
  download: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
  ),
  back: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base({ strokeWidth: 2, ...p })}><path d="m12 19-7-7 7-7M5 12h14" /></svg>
  ),
  lock: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
  ),
  check: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base({ strokeWidth: 2.2, ...p })}><path d="M20 6 9 17l-5-5" /></svg>
  ),
  scale: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M12 3v18M5 8l-3 7h6zM19 8l-3 7h6zM5 8l7-2 7 2" /></svg>
  ),
  plus: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base({ strokeWidth: 2, ...p })}><path d="M12 5v14M5 12h14" /></svg>
  ),
  grip: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}><circle cx="9" cy="5" r="1.7" /><circle cx="15" cy="5" r="1.7" /><circle cx="9" cy="12" r="1.7" /><circle cx="15" cy="12" r="1.7" /><circle cx="9" cy="19" r="1.7" /><circle cx="15" cy="19" r="1.7" /></svg>
  ),
};
