import { cn } from "@/lib/cn";

/**
 * Source badge (prototype `.source`) — names the register an item came from
 * (Snags, Hours, ITPs, Evidence, Observations, Materials…) so a mixed
 * needs-attention list stays honest about provenance. Mono, muted.
 */
export function SourceBadge({ source, className }: { source: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[3px] border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted",
        className
      )}
    >
      {source}
    </span>
  );
}
