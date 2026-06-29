import { cn } from "@/lib/cn";
import type { StatTile, StatTone } from "@/domains/resources/summary";

/**
 * The glanceable stat-tile header for the Resources surfaces (brief §7).
 * People and Gear both lead with a four-tile row derived by the pure
 * `src/domains/resources/summary.ts` view-model — this component only renders
 * it. Tile styling matches the Command Centre pulse tiles (§2 redesign):
 * rounded-card, brand tokens, font-display value, font-mono label.
 *
 * Tones are accent-only on the value; a "—" value (signal unavailable) reads
 * muted regardless of tone so an absent number never looks like an alert.
 */

const VALUE_TONE: Record<StatTone, string> = {
  neutral: "text-text",
  success: "text-emerald-700",
  warning: "text-amber-700",
  danger: "text-rose-700",
  info: "text-sky-700",
};

const CARD_TONE: Record<StatTone, string> = {
  neutral: "border-border bg-surface-raised",
  success: "border-border bg-surface-raised",
  warning: "border-amber-200 bg-amber-50",
  danger: "border-rose-200 bg-rose-50",
  info: "border-sky-200 bg-sky-50",
};

export function ResourceStatRow({
  tiles,
  label,
}: {
  tiles: ReadonlyArray<StatTile>;
  /** aria-label for the region, e.g. "People at a glance". */
  label: string;
}) {
  return (
    <section aria-label={label}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((tile) => {
          const unavailable = tile.value === "—";
          return (
            <div
              key={tile.key}
              className={cn(
                "rounded-card border p-4",
                unavailable ? "border-border bg-surface-raised" : CARD_TONE[tile.tone],
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
