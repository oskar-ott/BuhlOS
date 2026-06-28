import { cn } from "@/lib/cn";

/**
 * KPI strip (prototype `.kpi`): a responsive grid of label/number/sub cells —
 * the eyebrow + big number summary every inbox/register leads with. The number
 * carries an optional tone (warn/amber/ok) so a count that needs attention reads
 * hot. Honesty: a cell whose signal isn't tracked passes `num="—"` (never 0/green).
 */
export type KpiTone = "default" | "ok" | "amber" | "warn";

export interface KpiCell {
  lbl: string;
  num: string | number;
  sub?: string;
  tone?: KpiTone;
}

const NUM_TONE: Record<KpiTone, string> = {
  default: "text-text",
  ok: "text-state-success",
  amber: "text-state-warning",
  warn: "text-state-danger",
};

export function KpiStrip({ cells, className }: { cells: ReadonlyArray<KpiCell>; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-4",
        className
      )}
    >
      {cells.map((c) => (
        <div key={c.lbl} className="bg-surface px-3 py-2.5">
          <p className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{c.lbl}</p>
          <p className={cn("mt-0.5 font-display text-2xl font-bold tabular-nums", NUM_TONE[c.tone ?? "default"])}>
            {c.num}
          </p>
          {c.sub ? <p className="mt-0.5 text-[11px] text-text-muted">{c.sub}</p> : null}
        </div>
      ))}
    </div>
  );
}
