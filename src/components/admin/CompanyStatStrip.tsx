import { cn } from "@/lib/cn";
import type { StatTile, StatTone } from "@/domains/company/summary";

/**
 * The glanceable stat-tile header for the Company surfaces (brief §8 — Quotes,
 * QA status, ITP templates). Each surface leads with a four-tile row derived by
 * the pure `src/domains/company/summary.ts` view-models — this component only
 * renders it. Tile styling matches the Command Centre pulse tiles and the §7
 * Resources stat row: rounded-card, brand tokens, font-display value,
 * font-mono label.
 *
 * Tones are accent-only on the value; a "—" value (signal unavailable) reads
 * muted regardless of tone so an absent number never looks like an alert.
 */

const VALUE_TONE: Record<StatTone, string> = {
  neutral: "text-text",
  success: "text-state-success",
  warning: "text-state-warning",
  danger: "text-state-danger",
  info: "text-state-info",
};

// Tinted left rail on the value-bearing tones (the OwnerNumbersBoard cue); the
// card body stays calm so a coloured number never reads as a full-card alert.
const RAIL_TONE: Record<StatTone, string> = {
  neutral: "border-l-border",
  success: "border-l-state-success",
  warning: "border-l-state-warning",
  danger: "border-l-state-danger",
  info: "border-l-state-info",
};

export function CompanyStatStrip({
  tiles,
  label,
  subline,
}: {
  tiles: ReadonlyArray<StatTile>;
  /** aria-label for the region, e.g. "Quotes at a glance". */
  label: string;
  /** Optional one-line summary shown above the tiles, e.g. "14 quotes · 5 live". */
  subline?: string;
}) {
  return (
    <section aria-label={label} className="space-y-2">
      {subline ? (
        <p className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
          {subline}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((tile) => {
          const unavailable = tile.value === "—";
          return (
            <div
              key={tile.key}
              className={cn(
                "rounded-card border border-l-4 bg-surface-raised p-4",
                unavailable ? "border-l-border" : RAIL_TONE[tile.tone],
              )}
            >
              <p className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
                {tile.label}
              </p>
              <p
                className={cn(
                  "mt-1 font-display text-2xl font-semibold tabular-nums",
                  unavailable ? "text-text-muted" : VALUE_TONE[tile.tone],
                )}
              >
                {tile.value}
              </p>
              <p className="mt-0.5 text-xs text-text-muted">{tile.hint}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
