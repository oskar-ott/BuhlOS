import { cn } from "@/lib/cn";

/** Status dot (prototype `.dot`) — a tone-coloured marker, usually leading a label. */
export type DotTone = "green" | "amber" | "red" | "navy" | "yellow" | "grey";

const DOT: Record<DotTone, string> = {
  green: "bg-state-success",
  amber: "bg-state-warning",
  red: "bg-state-danger",
  navy: "bg-brand-navy",
  yellow: "bg-accent-yellow",
  grey: "bg-text-muted",
};

export function Dot({ tone = "grey", className }: { tone?: DotTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", DOT[tone], className)}
    />
  );
}
