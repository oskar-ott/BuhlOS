"use client";

import { useMemo, useState } from "react";
import { Package, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { balanceLabel, matchesSearch, photoUrl } from "@/domains/workshop-stock/format";
import type { StockItem } from "@/domains/workshop-stock/schema";
import { itemsOfType, typeTiles } from "@/domains/workshop-stock/types";

/**
 * Pick it by sight (owner pull 2026-11-03: "some items aren't always in
 * packaging"). Out of its box there's no barcode or label to read, so the crew
 * pick the item by how it looks: its photo, big, in a grid — narrowed by
 * category and by typing. Items with a photo come first; the rest follow by
 * name. Tapping one goes to the same confirmation as every other way in;
 * nothing is taken here.
 */
export function SightPicker({ items, onPick, initialType = undefined }: { items: StockItem[]; onPick: (item: StockItem) => void; initialType?: string | null }) {
  const live = useMemo(() => items.filter((i) => !i.archivedAt), [items]);
  const tiles = useMemo(() => typeTiles(live), [live]);
  const [type, setType] = useState<string | null | undefined>(initialType && tiles.some((t) => t.key === initialType) ? initialType : undefined);
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const ofType = type === undefined ? live : itemsOfType(live, type);
    const found = ofType.filter((i) => matchesSearch(i, q));
    return [...found].sort((a, b) => Number(Boolean(b.photoId)) - Number(Boolean(a.photoId)) || a.name.localeCompare(b.name));
  }, [live, type, q]);

  return (
    <div className="space-y-3" data-testid="stock-sight">
      <p className="text-sm text-text-muted">Out of its box? Find it by how it looks. Tap the one in your hand.</p>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Narrow it: white, 2 gang, 20mm…" aria-label="Narrow the photos" className="h-12 w-full rounded-xl border border-border-strong bg-surface pl-9 pr-3 text-base text-text" data-testid="stock-sight-search" />
      </div>
      {tiles.length > 1 ? (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Category">
          {[{ key: undefined as string | null | undefined, label: "All", count: live.length }, ...tiles].map((t) => {
            const on = t.key === type;
            return (
              <button key={String(t.key)} type="button" aria-pressed={on} onClick={() => setType(t.key)} className={cn("inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold", on ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border-strong bg-surface text-text")} data-testid="stock-sight-type">
                {t.label}<span className={cn("text-xs font-bold tabular-nums", on ? "text-text-inverse" : "text-text-muted")}>{t.count}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {shown.length ? (
        <ul className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3" data-testid="stock-sight-grid">
          {shown.slice(0, 120).map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => onPick(i)} className="flex w-full flex-col overflow-hidden rounded-[14px] border border-border bg-surface text-left active:border-brand-navy" data-testid="stock-sight-item">
                <span className="flex aspect-square w-full items-center justify-center bg-surface-subtle">
                  {i.photoId ? (
                    // eslint-disable-next-line @next/next/no-img-element -- an authenticated same-origin proxy
                    <img src={photoUrl(i.photoId, "thumb")} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <Package aria-hidden="true" className="h-8 w-8 text-text-muted" />
                  )}
                </span>
                <span className="block px-2.5 pb-2 pt-1.5">
                  <span className="line-clamp-2 block text-[13px] font-semibold leading-snug text-text">{i.name}</span>
                  <span className="block truncate text-[12px] text-text-muted">{[i.location, balanceLabel(i)].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-border bg-surface-subtle p-4 text-center text-sm text-text-muted">{q.trim() ? `Nothing matches “${q.trim()}”.` : "Nothing in this category."}</p>
      )}
      {shown.length > 120 ? <p className="text-center text-[13px] text-text-muted">Showing 120 of {shown.length} — narrow it down to see the rest.</p> : null}
    </div>
  );
}
