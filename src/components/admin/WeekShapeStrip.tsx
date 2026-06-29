import { cn } from "@/lib/cn";
import type { StripCell, StripTone } from "@/domains/timesheets/pay-run";

/**
 * The seven-day strip (§5 mockup `hwk-strip`) — one cell per day, Mon → Sun,
 * each showing the ACTUAL LOGGED HOURS NUMBER ("8", "8.5", "10.5"). A day with
 * no logged hours shows a glyph, never a fabricated 0: "—" for a server-flagged
 * missing day, "·" for an off / not-required / future day, "L"/"H" for leave /
 * holiday. Status colour comes from brand tokens (no inline gradients — the
 * repo bans the `style` attribute, so the mockup's per-day linear-gradient bars
 * are intentionally NOT ported).
 *
 * Presentational only. Cells come from the pure pay-run VM
 * (src/domains/timesheets/pay-run.ts → workerStrip); each carries a full
 * `title` for hover + an aria-label so the strip is not colour-only.
 */

// Day-cell fills — the status palette, kept consistent with the board's Pills:
// approved=success, submitted=info, rejected/overtime=danger, draft/missing=
// warning, leave=info-subtle, holiday/empty=neutral. Border + bg only, no hex.
const CELL_TONE: Record<StripTone, string> = {
  approved: "border-emerald-200 bg-emerald-100 text-emerald-900",
  submitted: "border-sky-200 bg-sky-100 text-sky-900",
  rejected: "border-rose-200 bg-rose-100 text-rose-900",
  draft: "border-amber-200 bg-amber-100 text-amber-900",
  missing: "border-amber-300 bg-transparent text-amber-700",
  leave: "border-sky-200 bg-sky-50 text-sky-800",
  holiday: "border-border bg-surface-subtle text-text-muted",
  empty: "border-transparent bg-transparent text-text-muted",
};

// Overtime cell — a long day reads red even when its status is approved /
// submitted, so a >10h or stored-OT day pops in the strip (§5 .hwk-day.over).
const OVERTIME_CELL = "border-rose-200 bg-rose-50 text-rose-700";

/** A logged day with stored overtime, or a >10h day — the mockup's "over"
 *  treatment. Pure: reads only the cell the model already produced. */
function isOvertimeCell(cell: StripCell): boolean {
  return cell.hoursNumber != null && cell.hoursNumber > 10;
}

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
      className="flex gap-1.5"
      role="img"
      aria-label={`${workerName} — week at a glance`}
    >
      {cells.map((cell) => {
        const over = isOvertimeCell(cell);
        return (
          <div
            key={cell.date}
            title={cell.title}
            aria-label={`${workerName}: ${cell.title}`}
            className={cn(
              "flex h-12 w-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-card border text-center",
              over ? OVERTIME_CELL : CELL_TONE[cell.tone],
            )}
          >
            <span className="font-mono text-[8px] font-semibold uppercase leading-none tracking-widest opacity-70">
              {cell.weekday}
            </span>
            <span className="font-display text-sm font-bold leading-none tabular-nums">
              {cell.hoursShort ?? cell.emptyGlyph}
            </span>
          </div>
        );
      })}
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
