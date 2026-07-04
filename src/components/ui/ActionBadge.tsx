import { cn } from "@/lib/cn";

/**
 * Action badge (prototype) — is the surfaced next-action the EXACT thing to do,
 * or a best-effort FALLBACK? Honesty primitive: we never imply precision we
 * don't have. `exact` → navy "Exact action"; otherwise muted "Fallback".
 */
export function ActionBadge({ exact, className }: { exact: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[3px] px-1.5 py-0.5 font-mono text-[12px] font-semibold uppercase tracking-wider",
        exact
          ? "bg-brand-navy text-text-inverse"
          : "border border-border bg-surface-subtle text-text-muted",
        className
      )}
    >
      {exact ? "Exact action" : "Fallback"}
    </span>
  );
}
