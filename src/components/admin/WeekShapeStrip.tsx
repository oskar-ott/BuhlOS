import { cn } from "@/lib/cn";
import type { StripCell, StripTone } from "@/domains/timesheets/pay-run";

/**
 * The seven-day "shape of the week" strip (brief §5) — one square per day,
 * Mon → Sun, so the office reads a worker's week at a glance before expanding
 * the row: solid green across = a clean approved week; an amber gap = a missing
 * day; a red square = a rejection waiting on the worker.
 *
 * Presentational only. The cells come from the pure pay-run VM
 * (src/domains/timesheets/pay-run.ts → workerStrip); this renders them with
 * brand tokens. Each cell carries a full `title` for hover + an aria-label so
 * the strip is not colour-only (the tone is backed by the day glyph/hours and
 * the accessible label).
 */

// Square fills — the status palette, kept consistent with the board's Pills:
// approved=success, submitted=info, rejected=danger, draft/missing=warning,
// leave=info-subtle, holiday/empty=neutral. Border + bg only, no new hex.
const CELL_TONE: Record<StripTone, string> = {
  approved: "border-emerald-200 bg-emerald-100 text-emerald-900",
  submitted: "border-sky-200 bg-sky-100 text-sky-900",
  rejected: "border-rose-200 bg-rose-100 text-rose-900",
  draft: "border-amber-200 bg-amber-100 text-amber-900",
  missing: "border-amber-200 bg-amber-50 text-amber-800",
  leave: "border-sky-200 bg-sky-50 text-sky-800",
  holiday: "border-border bg-surface-subtle text-text-muted",
  empty: "border-border bg-surface text-text-muted",
};

export function WeekShapeStrip({
  cells,
  workerName,
}: {
  cells: ReadonlyArray<StripCell>;
  /** Used to make each cell's aria-label self-describing. */
  workerName: string;
}) {
  return (
    <div
      className="flex gap-1"
      role="img"
      aria-label={`${workerName} — week at a glance`}
    >
      {cells.map((cell) => (
        <div
          key={cell.date}
          title={cell.title}
          aria-label={`${workerName}: ${cell.title}`}
          className={cn(
            "flex h-12 w-9 shrink-0 flex-col items-center justify-center rounded-card border text-center sm:w-10",
            CELL_TONE[cell.tone],
          )}
        >
          <span className="font-mono text-[10px] uppercase leading-none tracking-wide opacity-70">
            {cell.weekday}
          </span>
          <span className="mt-0.5 font-display text-xs font-semibold leading-none tabular-nums">
            {cell.hoursLabel ? cell.hoursLabel.replace(/\s+/g, "") : cell.emptyGlyph}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A compact legend for the strip tones actually present in the run — rendered
 *  by the board under the list so the squares are self-explaining. Only tones
 *  that appear are shown (no legend entries for states not in the data). */
const LEGEND_ORDER: ReadonlyArray<{ tone: StripTone; label: string }> = [
  { tone: "approved", label: "Approved" },
  { tone: "submitted", label: "Submitted" },
  { tone: "rejected", label: "Rejected" },
  { tone: "draft", label: "Draft" },
  { tone: "missing", label: "Missing" },
  { tone: "leave", label: "Leave" },
  { tone: "holiday", label: "Holiday" },
];

export function WeekShapeLegend({ tones }: { tones: ReadonlySet<StripTone> }) {
  const shown = LEGEND_ORDER.filter((l) => tones.has(l.tone));
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {shown.map((l) => (
        <li key={l.tone} className="flex items-center gap-1.5 text-xs text-text-muted">
          <span
            aria-hidden="true"
            className={cn("h-3 w-3 rounded border", CELL_TONE[l.tone])}
          />
          {l.label}
        </li>
      ))}
    </ul>
  );
}
