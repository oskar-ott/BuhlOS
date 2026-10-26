"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { matchesSearch } from "@/domains/workshop-stock/format";
import type { StockItem } from "@/domains/workshop-stock/schema";
import { StockItemRow } from "./StockItemRow";
import { Kicker } from "./ui";

/**
 * Search over the loaded catalogue — always available, and the whole fallback
 * when the camera can't help. Matches name, brand, codes, SKUs, barcodes,
 * colour, variant and shelf/bin; trade names too ("power point" finds the GPO).
 *
 * With nothing typed it shows `whenEmpty` (the Take screen's camera and
 * shortcuts, or a "Taken often" list); as soon as something is typed the
 * matches take over, headed "2 match 'power point'".
 */
export function ItemPicker({
  items,
  onPick,
  autoFocus = false,
  placeholder = "Search name, code or shelf",
  whenEmpty,
  rowTestId = "stock-picker-row",
  disabled = false,
}: {
  items: StockItem[];
  onPick: (item: StockItem) => void;
  autoFocus?: boolean;
  placeholder?: string;
  whenEmpty?: ReactNode;
  rowTestId?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim();
  const shown = useMemo(() => (q ? items.filter((i) => !i.archivedAt && matchesSearch(i, q)).slice(0, 60) : []), [items, q]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative shrink-0">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted" />
        <input
          type="search"
          enterKeyHint="search"
          autoFocus={autoFocus}
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label="Search workshop stock"
          className="h-12 w-full rounded-xl border border-border-strong bg-surface pl-11 pr-12 text-base text-text focus:border-brand-navy focus:outline-none focus:ring-[3px] focus:ring-accent-yellow/60"
          data-testid="stock-picker-search"
        />
        {query ? (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-1 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center text-text-muted">
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        ) : null}
      </div>
      {!q ? (
        whenEmpty ?? null
      ) : shown.length ? (
        <div className="-mx-4">
          <Kicker className="px-4 pb-1.5 pt-1">
            {shown.length} match &ldquo;{q}&rdquo;
          </Kicker>
          <ul className="border-t border-border">
            {shown.map((i) => (
              <li key={i.id}>
                <StockItemRow item={i} onClick={() => onPick(i)} testId={rowTestId} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-[14px] border border-dashed border-border-strong bg-surface-subtle p-4">
          <p className="font-display text-base font-bold text-brand-navy">{items.length ? `Nothing matches "${q}"` : "Nothing is recorded in the workshop yet."}</p>
          {items.length ? <p className="mt-1 text-sm text-text-muted">Searched names, brands, codes, barcodes, colours, sizes and shelves. It may not be recorded yet.</p> : null}
        </div>
      )}
    </div>
  );
}
