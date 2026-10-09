"use client";

import { MapPin } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatNumber, identityLine, UNIT_LABEL } from "@/domains/workshop-stock/format";
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

/**
 * One workshop item as a big tappable row: photo, name, identity line, where it
 * lives, and the RECORDED quantity with its unit. Zero reads "None recorded";
 * an estimate reads "≈". Never a fake number (P7).
 */
export function StockItemRow({ item, onClick, hint, testId }: { item: StockRowItem; onClick: () => void; hint?: string | null; testId?: string }) {
  const zero = item.balanceMilli === 0;
  const unit = UNIT_LABEL[item.baseUnit];
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[76px] w-full items-center gap-3 rounded-card border border-border bg-surface-raised px-3 py-2 text-left hover:border-brand-navy focus-visible:outline-brand-navy"
      data-testid={testId ?? "stock-row"}
      data-item-id={item.id}
    >
      <StockThumb photoId={item.photoId} alt="" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-base font-semibold text-text">{item.name}</p>
        {identityLine(item) ? <p className="truncate text-sm text-text-muted">{identityLine(item)}</p> : null}
        <p className="mt-0.5 flex items-center gap-1 truncate text-sm text-text-muted">
          <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {item.location ? <span className="truncate">{item.location}</span> : <span className="italic">No location set</span>}
        </p>
        {hint ? <p className="mt-0.5 truncate text-xs font-semibold text-state-warning">{hint}</p> : null}
      </div>
      <div className="shrink-0 text-right" aria-label={zero ? "None recorded" : `${item.estimated ? "about " : ""}${formatNumber(item.balanceMilli)} ${unit.plural} recorded`}>
        {zero ? (
          <span className="inline-flex rounded-pill border border-state-warning-subtle-border bg-state-warning-subtle-bg px-2 py-1 text-xs font-semibold text-state-warning-subtle-text">None recorded</span>
        ) : (
          <>
            <p className={cn("font-display text-2xl font-semibold leading-none text-text")}>
              {item.estimated ? "≈" : ""}
              {formatNumber(item.balanceMilli)}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">{item.estimated ? `${unit.plural} (est.)` : unit.plural}</p>
          </>
        )}
      </div>
    </button>
  );
}
