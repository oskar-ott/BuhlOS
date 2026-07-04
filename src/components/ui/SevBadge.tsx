import { cn } from "@/lib/cn";

/**
 * Severity badge (prototype `.sev`) — the word leads, colour reinforces. Mono
 * uppercase instrument voice. Used by the needs-attention / observations rails.
 * Uses the literal Tailwind palette (like Pill/StatusChip) — token colours don't
 * take opacity modifiers reliably in this repo.
 */
export type Severity = "critical" | "warning" | "info";

const SEV: Record<Severity, { label: string; cls: string }> = {
  critical: { label: "Critical", cls: "bg-rose-50 text-rose-700" },
  warning: { label: "Warning", cls: "bg-amber-50 text-amber-800" },
  info: { label: "Info", cls: "bg-sky-50 text-sky-700" },
};

export function SevBadge({ sev, className }: { sev: Severity; className?: string }) {
  const s = SEV[sev];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[3px] px-1.5 py-0.5 font-mono text-[12px] font-semibold uppercase tracking-wider",
        s.cls,
        className
      )}
    >
      {s.label}
    </span>
  );
}
