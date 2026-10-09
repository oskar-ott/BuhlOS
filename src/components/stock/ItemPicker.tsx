"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { matchesSearch } from "@/domains/workshop-stock/format";
import type { StockItem } from "@/domains/workshop-stock/schema";
import { StockItemRow } from "./StockItemRow";

/**
 * Manual search over the loaded catalogue — always available, and the whole
 * fallback when photo reading is off or fails. Matches name, brand, codes,
 * SKUs, barcodes, colour, variant and shelf/bin; punctuation-insensitive.
 */
export function ItemPicker({ items, onPick, autoFocus = true, placeholder = "Search name, code or shelf" }: { items: StockItem[]; onPick: (item: StockItem) => void; autoFocus?: boolean; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => items.filter((i) => !i.archivedAt && matchesSearch(i, query)).slice(0, 60), [items, query]);
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted" />
        <input
          type="search"
          enterKeyHint="search"
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label="Search workshop stock"
          className="h-12 w-full rounded-card border border-border-strong bg-surface pl-10 pr-12 text-base text-text"
          data-testid="stock-picker-search"
        />
        {query ? (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-1 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center text-text-muted">
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        ) : null}
      </div>
      {shown.length ? (
        <ul className="space-y-2">
          {shown.map((i) => (
            <li key={i.id}>
              <StockItemRow item={i} onClick={() => onPick(i)} testId="stock-picker-row" />
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
          {items.length ? `Nothing matches “${query}”.` : "Nothing is recorded in the workshop yet."}
        </p>
      )}
    </div>
  );
}
