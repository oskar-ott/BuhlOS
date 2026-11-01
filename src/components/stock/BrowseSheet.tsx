"use client";

import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { groupByShelf } from "@/domains/workshop-stock/location";
import type { StockItem } from "@/domains/workshop-stock/schema";
import { applyFacets, facetsFor, itemsOfType, NOT_SORTED_LABEL, typeOf, type FacetChoice } from "@/domains/workshop-stock/types";
import { FlowSheet } from "./FlowSheet";
import { StockItemRow } from "./StockItemRow";
import { Kicker, LinkButton } from "./ui";

/** What a browse sheet shows: one type, the unsorted items, or everything by shelf. */
export type BrowseMode = { kind: "type"; key: string } | { kind: "unsorted" } | { kind: "shelf" };

export function browseTitle(mode: BrowseMode): string {
  if (mode.kind === "type") return typeOf(mode.key)?.label ?? "Other";
  if (mode.kind === "unsorted") return NOT_SORTED_LABEL;
  return "Everything, by shelf";
}

/**
 * Browsing workshop stock by TYPE (owner pull 2026-11-01): "someone opens stock
 * when they already know what they need — not to scroll a long list". One type
 * at a time, its fields as filter chips built from what is actually in stock —
 * Range: Iconic · Classic, Gang: 1 · 2 · 3, Colour: White · Black — each with
 * how many items it leaves, so a tap never promises something that isn't
 * there. Then the rows, with the recorded quantity and where each lives.
 *
 * The chosen filters live with the host (they come back when the worker
 * returns from an item). Back closes it to the tiles.
 */
export function BrowseSheet({
  mode,
  items,
  choice,
  onChoice,
  onPick,
  onClose,
  recentId,
}: {
  mode: BrowseMode;
  items: readonly StockItem[];
  choice: FacetChoice;
  onChoice: (c: FacetChoice) => void;
  onPick: (item: StockItem) => void;
  onClose: () => void;
  recentId?: string | null;
}) {
  const type = mode.kind === "type" ? typeOf(mode.key) : null;
  const pool = useMemo(() => (mode.kind === "type" ? itemsOfType(items, mode.key) : mode.kind === "unsorted" ? itemsOfType(items, null) : [...items]), [items, mode]);
  const facets = useMemo(() => (type ? facetsFor(type, pool, choice) : []), [type, pool, choice]);
  const shown = useMemo(() => (type ? applyFacets(type, pool, choice) : pool), [type, pool, choice]);
  const groups = useMemo(() => (mode.kind === "shelf" ? groupByShelf(shown) : null), [mode.kind, shown]);
  const chosen = Object.keys(choice).length;

  function toggle(field: string, key: string) {
    const next = { ...choice };
    if (next[field] === key) delete next[field];
    else next[field] = key;
    onChoice(next);
  }

  const row = (i: StockItem, inGroup = false) => (
    <li key={i.id}>
      <StockItemRow item={i} inGroup={inGroup} marker={i.id === recentId ? "just now" : null} highlight={i.id === recentId} onClick={() => onPick(i)} testId="stock-browse-row" />
    </li>
  );

  return (
    <FlowSheet title={browseTitle(mode)} onClose={onClose} onBack={onClose} testId="stock-browse" bodyClassName="gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[15px] font-semibold text-text" data-testid="stock-browse-count">
          {chosen ? `${shown.length} of ${pool.length}` : pool.length} {pool.length === 1 ? "item" : "items"}
        </p>
        {chosen ? <LinkButton onClick={() => onChoice({})} data-testid="stock-browse-clear">Clear filters</LinkButton> : null}
      </div>

      {facets.length ? (
        <div className="space-y-2" data-testid="stock-browse-facets">
          {facets.map((f) => (
            <div key={f.field.key} role="group" aria-label={f.field.label}>
              <Kicker className="text-[11px] text-text-muted">{f.field.label}</Kicker>
              <div className="-mx-4 mt-1 flex gap-1.5 overflow-x-auto px-4 pb-0.5">
                {f.values.map((v) => {
                  const on = choice[f.field.key] === v.key;
                  const empty = !on && v.count === 0;
                  return (
                    <button
                      key={v.key}
                      type="button"
                      aria-pressed={on}
                      disabled={empty}
                      onClick={() => toggle(f.field.key, v.key)}
                      className={cn(
                        "inline-flex min-h-[40px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-3 text-sm font-semibold",
                        on ? "border-brand-navy bg-brand-navy text-text-inverse" : empty ? "border-border bg-surface-subtle text-text-muted" : "border-border-strong bg-surface text-text hover:border-brand-navy",
                      )}
                      data-testid="stock-facet"
                      data-field={f.field.key}
                    >
                      {v.value}
                      <span className={cn("font-mono text-[12px] font-bold tabular-nums", on ? "text-text-inverse/80" : "text-text-muted")}>{v.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {mode.kind === "unsorted" ? (
        <p className="text-[13px] text-text-muted">These haven&rsquo;t been given a type yet. The office can sort them — open one on the office screen and pick what it is.</p>
      ) : null}

      {shown.length ? (
        groups ? (
          <div className="-mx-4" data-testid="stock-browse-list">
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <div className="flex items-baseline justify-between border-y border-border bg-surface-subtle px-4 pb-1.5 pt-3">
                  <Kicker className="text-[13px] text-brand-navy">{g.label}</Kicker>
                  <span className="text-[13px] font-medium text-text-muted">{g.items.length} {g.items.length === 1 ? "item" : "items"}</span>
                </div>
                <ul>{g.items.map((i) => row(i, true))}</ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="-mx-4 border-t border-border" data-testid="stock-browse-list">{shown.map((i) => row(i))}</ul>
        )
      ) : (
        <div className="rounded-[14px] border border-dashed border-border-strong bg-surface-subtle p-4 text-center">
          <p className="font-display text-base font-bold text-brand-navy">Nothing matches those filters</p>
          <LinkButton className="self-center" onClick={() => onChoice({})}>Clear filters</LinkButton>
        </div>
      )}
    </FlowSheet>
  );
}
