import Link from "next/link";
import type { Route } from "next";
import { ArrowRight, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import type { OwnerNumberTile } from "@/domains/analytics/owner-numbers";

/**
 * /reports board (#316) — renders the six owner-number tiles EXACTLY as
 * src/domains/analytics/owner-numbers.ts defines them. No metric math
 * here: values, trends, states, notes and drill targets all arrive
 * pre-derived; this component only lays them out.
 *
 * State → tone per doc 27 §6.1 (solid state tokens, rail not tinted fill):
 *   ok      → neutral card, no accent
 *   warning → --state-warning left rail
 *   error   → --state-danger left rail + "Couldn't load" pill
 *   missing → dashed border, neutral (honest explainer speaks, no number)
 */
export function OwnerNumbersBoard({
  tiles,
}: {
  tiles: ReadonlyArray<OwnerNumberTile>;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {tiles.map((tile) => (
        <OwnerNumberCard key={tile.id} tile={tile} />
      ))}
    </div>
  );
}

const RAIL_CLASSES: Record<OwnerNumberTile["state"], string> = {
  ok: "",
  warning: "border-l-4 border-l-state-warning",
  error: "border-l-4 border-l-state-danger",
  missing: "border-dashed",
};

function OwnerNumberCard({ tile }: { tile: OwnerNumberTile }) {
  const body = (
    <Card
      data-testid={`owner-number-${tile.id}`}
      role={tile.state === "error" ? "alert" : undefined}
      className={cn("flex h-full flex-col gap-1", RAIL_CLASSES[tile.state])}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-text-muted">
          {tile.label}
        </p>
        {tile.state === "error" ? <Pill tone="danger">Couldn&rsquo;t load</Pill> : null}
        {tile.state === "missing" ? <Pill tone="neutral">No data</Pill> : null}
      </div>

      <p className="font-display text-3xl font-semibold text-text">
        {tile.value ?? <span aria-hidden="true">—</span>}
      </p>

      {tile.trend ? (
        <p className="flex items-center gap-1 text-xs text-text-muted">
          <TrendIcon direction={tile.trend.direction} />
          {tile.trend.label}
        </p>
      ) : null}

      {tile.detail ? <p className="text-xs text-text-muted">{tile.detail}</p> : null}

      {tile.honestNote ? (
        <p className="text-xs text-text-muted">{tile.honestNote}</p>
      ) : null}

      {tile.asOf ? <p className="text-[11px] text-text-muted">{tile.asOf}</p> : null}

      {tile.drillHref && tile.drillLabel ? (
        <p className="mt-auto inline-flex items-center gap-1 pt-2 text-sm font-medium text-brand-navy">
          {tile.drillLabel}
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </p>
      ) : null}
    </Card>
  );

  // Every number deep-links to the surface holding its records; tiles
  // with no surface (quotes) render unlinked rather than dead-ended.
  if (tile.drillHref) {
    return (
      <Link
        href={tile.drillHref as Route}
        aria-label={`${tile.label}: ${tile.value ?? "no data"}`}
        className="group block focus:outline-none focus:ring-2 focus:ring-brand-navy"
      >
        {body}
      </Link>
    );
  }
  return body;
}

function TrendIcon({ direction }: { direction: "up" | "down" | "flat" }) {
  if (direction === "up")
    return <TrendingUp aria-hidden="true" className="h-3.5 w-3.5" />;
  if (direction === "down")
    return <TrendingDown aria-hidden="true" className="h-3.5 w-3.5" />;
  return <Minus aria-hidden="true" className="h-3.5 w-3.5" />;
}
