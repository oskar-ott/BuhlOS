"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatNumber, identityLine, UNIT_LABEL } from "@/domains/workshop-stock/format";
import { binOf } from "@/domains/workshop-stock/location";
import type { StockUnit } from "@/domains/workshop-stock/schema";
import { StockThumb } from "./StockThumb";

export interface StockRowItem {
  id: string;
  name: string;
  brand: string | null;
  manufacturerCode: string | null;
  colourFinish: string | null;
  variant: string | null;
  location: string | null;
  baseUnit: StockUnit;
  balanceMilli: number;
  estimated: boolean;
  photoId: string | null;
  archivedAt?: string | null;
}

/** "None recorded" — the pill every list uses for a zero balance (never a bare 0). */
export function NoneRecorded({ className }: { className?: string }) {
  return <span className={cn("inline-flex h-7 items-center whitespace-nowrap rounded-pill border border-state-warning-subtle-border bg-state-warning-subtle-bg px-2.5 text-[13px] font-semibold text-state-warning-subtle-text", className)}>None recorded</span>;
}

/** The recorded quantity as the row's largest thing: "15 each", "≈ 40 m · estimate", or the None recorded pill. */
export function RecordedQuantity({ item, size = "md", className }: { item: Pick<StockRowItem, "balanceMilli" | "baseUnit" | "estimated">; size?: "md" | "lg"; className?: string }) {
  const unit = UNIT_LABEL[item.baseUnit];
  if (item.balanceMilli === 0) return <NoneRecorded className={className} />;
  const n = formatNumber(item.balanceMilli);
  return (
    <span className={cn("block whitespace-nowrap", className)} aria-label={`${item.estimated ? "about " : ""}${n} ${unit.plural} recorded`}>
      <span className={cn("font-display font-bold leading-none tabular-nums", size === "lg" ? "text-[26px]" : "text-[22px]", item.estimated ? "text-text-muted" : "text-text")}>
        {item.estimated ? "≈ " : ""}
        {n}
        <span className="ml-1 font-sans text-sm font-medium text-text-muted">{unit.plural}</span>
      </span>
      {item.estimated ? <span className="mt-1 block text-right text-xs font-semibold text-text-muted">estimate</span> : null}
    </span>
  );
}

/**
 * One workshop item as a big tappable row: photo, name, identity line, and the
 * RECORDED quantity as the largest thing on the row, with where it lives under
 * it. In a shelf group only the BIN is shown (the shelf is the group header);
 * elsewhere the whole location. Zero reads "None recorded"; an estimate reads
 * "≈". Never a fake number (P7).
 */
export function StockItemRow({
  item,
  onClick,
  hint,
  meta,
  inGroup = false,
  marker,
  highlight = false,
  testId,
}: {
  item: StockRowItem;
  onClick: () => void;
  /** a warning under the identity line (a candidate's conflict) */
  hint?: string | null;
  /** a plain line under the identity line (the office's last movement / count) */
  meta?: ReactNode;
  /** the row sits under its shelf header: show the bin, not the whole location */
  inGroup?: boolean;
  /** "just now" — the row a save a moment ago changed */
  marker?: string | null;
  highlight?: boolean;
  testId?: string;
}) {
  const where = inGroup ? binOf(item.location) : item.location;
  const under = [where, marker].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[68px] w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left hover:bg-surface-subtle focus-visible:outline-brand-navy",
        highlight ? "bg-state-success-subtle-bg/60" : "bg-surface",
      )}
      data-testid={testId ?? "stock-row"}
      data-item-id={item.id}
    >
      <StockThumb photoId={item.photoId} alt="" size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-semibold leading-tight text-text">{item.name}</span>
        {identityLine(item) ? <span className="mt-0.5 block truncate text-[13px] text-text-muted">{identityLine(item)}</span> : null}
        {!inGroup && !item.location ? <span className="mt-0.5 block text-[13px] italic text-text-muted">No shelf set</span> : null}
        {meta ? <span className="mt-0.5 block truncate text-xs text-text-muted">{meta}</span> : null}
        {hint ? <span className="mt-0.5 block truncate text-xs font-semibold text-state-warning">{hint}</span> : null}
      </span>
      <span className="shrink-0 text-right">
        <RecordedQuantity item={item} />
        {under ? <span className="mt-1 block text-xs font-medium text-text-muted">{under}</span> : null}
      </span>
    </button>
  );
}
