"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, MapPin, Package } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { StockItemRow } from "@/components/stock/StockItemRow";
import { StockThumb } from "@/components/stock/StockThumb";
import { cn } from "@/lib/cn";
import { formatNumber, identityLine, UNIT_LABEL, verificationLine, whenLabel } from "@/domains/workshop-stock/format";
import { binOf } from "@/domains/workshop-stock/location";
import type { StockItem } from "@/domains/workshop-stock/schema";
import { noneRecorded, type GroupBy, type ItemGroup, type SortKey, type StockSort } from "@/domains/workshop-stock/views";
import { CODE_SHORT, CODE_TONE } from "./code-status";

/**
 * The office list's three views over the SAME groups (views.ts), already
 * filtered and sorted: a table to read across, cards to recognise items by
 * their photo, and a board with one column per shelf (or type) — the workshop
 * as you'd walk it. Every view opens the same drawer; none adds a number the
 * list doesn't already hold (P7) — a group's "none recorded" is a count of its
 * own rows.
 */
export interface ViewProps {
  groups: Array<ItemGroup<StockItem>>;
  groupBy: GroupBy;
  archivedView: boolean;
  onOpen: (id: string) => void;
}

/** Where it lives, as much as the group header doesn't already say. */
function whereLabel(item: StockItem, groupBy: GroupBy): string | null {
  return groupBy === "shelf" ? binOf(item.location) : item.location;
}

/** The recorded quantity: the number leads, the unit follows; zero is a pill, an estimate says "≈". */
export function RecordedCell({ item, size = "md" }: { item: StockItem; size?: "md" | "lg" }) {
  if (item.balanceMilli === 0) return <Pill tone="warning" dot className="whitespace-nowrap">None recorded</Pill>;
  return (
    <span className="whitespace-nowrap" title={item.estimated ? "An estimate — a count clears it" : undefined}>
      <span className={cn("font-display font-semibold tabular-nums text-text", size === "lg" ? "text-[22px] leading-none" : "text-[15px]")}>{item.estimated ? "≈ " : ""}{formatNumber(item.balanceMilli)}</span>{" "}
      <span className="text-[13px] text-text-muted">{UNIT_LABEL[item.baseUnit].plural}</span>
    </span>
  );
}

function CodePill({ item }: { item: StockItem }) {
  return (
    <span title={verificationLine(item)}>
      <Pill tone={CODE_TONE[item.verificationStatus]} dot className="whitespace-nowrap font-medium normal-case tracking-normal">{CODE_SHORT[item.verificationStatus]}</Pill>
    </span>
  );
}

function countedLine(i: StockItem): string {
  return i.lastCountedAt ? `Counted ${whenLabel(i.lastCountedAt)}${i.lastCountedByName ? ` · ${i.lastCountedByName}` : ""}` : "Never counted";
}

/** "3 items · 1 none recorded" — the group's own rows, nothing more. */
function GroupMeta({ items, archivedView }: { items: StockItem[]; archivedView: boolean }) {
  const none = archivedView ? 0 : noneRecorded(items);
  return (
    <span className="font-normal text-text-muted">
      {items.length} {items.length === 1 ? "item" : "items"}
      {none ? <span className="text-state-warning"> · {none} none recorded</span> : null}
    </span>
  );
}

/** Groups that are folded away, per view, for this visit only. */
function useCollapsed() {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((key: string) => setClosed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; }), []);
  return { closed, toggle };
}

function GroupToggle({ label, open, onClick, children, className }: { label: string; open: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={open} className={cn("group flex w-full items-center gap-1.5 text-left text-[13px] font-semibold text-text", className)} data-testid="stock-group-toggle">
      <ChevronDown aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-text-muted transition-transform", open ? "" : "-rotate-90")} />
      <span>{label}</span>
      <span className="text-text-muted">·</span>
      {children}
    </button>
  );
}

// ── table ────────────────────────────────────────────────────────────────────

export function StockTable({ groups, groupBy, archivedView, onOpen, sort, onSort }: ViewProps & { sort: StockSort; onSort: (key: SortKey) => void }) {
  const { closed, toggle } = useCollapsed();
  const all = groups.flatMap((g) => g.items);
  // The where column earns its place only when something in view has one to show.
  const showWhere = archivedView || all.some((i) => whereLabel(i, groupBy));
  const whereHead = archivedView || groupBy !== "shelf" ? "Shelf" : "Bin";
  const cols = (archivedView ? 5 : 6) - (showWhere ? 0 : 1);
  const single = groups.length === 1 && groupBy === "none";

  const head = (label: string, key: SortKey | null, align: "left" | "right" = "left") => {
    const active = key !== null && sort.key === key;
    const Arrow = active && sort.reversed ? ArrowUp : ArrowDown;
    return (
      <th className={cn("sticky -top-6 z-10 border-b border-border bg-surface px-3 py-2.5 first:rounded-tl-card last:rounded-tr-card", align === "right" && "text-right")} aria-sort={active ? (sort.reversed ? "descending" : "ascending") : undefined}>
        {key ? (
          <button type="button" onClick={() => onSort(key)} className={cn("inline-flex items-center gap-1 uppercase hover:text-text", active && "text-text")} title={active ? "Click to reverse" : "Sort by this"} data-testid={`stock-sort-${key}`}>
            {label}
            <Arrow aria-hidden="true" className={cn("h-3 w-3", active ? "opacity-100" : "opacity-0")} />
          </button>
        ) : (
          label
        )}
      </th>
    );
  };

  return (
    <>
      {/* phone: rows with the same facts */}
      <div className="-mx-4 sm:hidden">
        {groups.map((g) => (
          <section key={g.key} aria-label={g.label}>
            {single ? null : (
              <div className="flex items-baseline justify-between border-y border-border bg-surface-subtle px-4 py-2">
                <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text">{g.label}</span>
                <span className="text-xs"><GroupMeta items={g.items} archivedView={archivedView} /></span>
              </div>
            )}
            <ul>
              {g.items.map((i) => (
                <li key={i.id}>
                  <StockItemRow
                    item={i}
                    inGroup={groupBy === "shelf"}
                    onClick={() => onOpen(i.id)}
                    meta={archivedView ? `Archived ${whenLabel(i.archivedAt)}` : `Last moved ${i.lastMovementAt ? whenLabel(i.lastMovementAt) : "never"} · counted ${i.lastCountedAt ? whenLabel(i.lastCountedAt) : "never"}`}
                    hint={!archivedView && i.verificationStatus !== "manufacturer_code_matched" ? verificationLine(i) : null}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {/* wide screens: no inner scroll box, so the column heads stay pinned while the page scrolls */}
      <div className="hidden overflow-x-auto rounded-card border border-border bg-surface sm:block lg:overflow-visible">
        <table className="w-full border-separate border-spacing-0 text-left text-sm [&>tbody>tr:last-child>td]:border-b-0" data-testid="stock-admin-table">
          <thead>
            <tr className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              {head("Item", "name")}
              {showWhere ? head(whereHead, null) : null}
              {head(archivedView ? "Recorded when archived" : "Recorded", "recorded", "right")}
              {archivedView ? head("Archived", null) : head("Last moved", "moved")}
              {archivedView ? head("Status", null) : head("Last counted", "counted")}
              {archivedView ? null : head("Code", null)}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const open = single || !closed.has(g.key);
              return (
                <TableGroup key={g.key} group={g} open={open} onToggle={() => toggle(g.key)} groupBy={groupBy} archivedView={archivedView} showWhere={showWhere} cols={cols} heading={!single} onOpen={onOpen} />
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

const CELL = "border-b border-border px-3";

function TableGroup({ group, open, onToggle, groupBy, archivedView, showWhere, cols, heading, onOpen }: { group: ItemGroup<StockItem>; open: boolean; onToggle: () => void; groupBy: GroupBy; archivedView: boolean; showWhere: boolean; cols: number; heading: boolean; onOpen: (id: string) => void }) {
  return (
    <>
      {heading ? (
        <tr data-testid="stock-admin-group">
          <td colSpan={cols} className={cn(CELL, "bg-surface-subtle pb-1.5 pt-2.5")}>
            <GroupToggle label={group.label} open={open} onClick={onToggle}>
              <GroupMeta items={group.items} archivedView={archivedView} />
            </GroupToggle>
          </td>
        </tr>
      ) : null}
      {open
        ? group.items.map((i) => (
            <tr key={i.id} className="cursor-pointer hover:bg-surface-subtle" onClick={() => onOpen(i.id)} data-testid="stock-admin-row">
              <td className={cn(CELL, "py-2")}>
                <button type="button" className="flex items-center gap-2.5 text-left" onClick={(e) => { e.stopPropagation(); onOpen(i.id); }}>
                  <StockThumb photoId={i.photoId} alt="" size="xs" />
                  <span className="min-w-0">
                    <span className="block font-semibold text-text">{i.name}</span>
                    {identityLine(i) ? <span className="block text-[12.5px] text-text-muted">{identityLine(i)}</span> : null}
                  </span>
                </button>
              </td>
              {showWhere ? <td className={cn(CELL, "py-2 text-[13px] text-text-muted")}>{(archivedView ? i.location : whereLabel(i, groupBy)) || ""}</td> : null}
              <td className={cn(CELL, "py-2 text-right")}><RecordedCell item={i} /></td>
              {archivedView ? (
                <>
                  <td className={cn(CELL, "py-2 text-[13px] text-text")}>{whenLabel(i.archivedAt)}</td>
                  <td className={cn(CELL, "py-2")}><Pill tone="neutral" dot>Archived</Pill></td>
                </>
              ) : (
                <>
                  <td className={cn(CELL, "whitespace-nowrap py-2 text-[13px] text-text-muted")}>{i.lastMovementAt ? whenLabel(i.lastMovementAt) : "Never"}</td>
                  <td className={cn(CELL, "whitespace-nowrap py-2 text-[13px]")}>
                    {i.lastCountedAt ? (
                      <span className="text-text">{whenLabel(i.lastCountedAt)}{i.lastCountedByName ? <span className="text-text-muted"> · {i.lastCountedByName}</span> : null}</span>
                    ) : (
                      <span className="text-text-muted">Never</span>
                    )}
                  </td>
                  <td className={cn(CELL, "py-2")}><CodePill item={i} /></td>
                </>
              )}
            </tr>
          ))
        : null}
    </>
  );
}

// ── cards ────────────────────────────────────────────────────────────────────

export function StockCards({ groups, groupBy, archivedView, onOpen }: ViewProps) {
  const { closed, toggle } = useCollapsed();
  const single = groups.length === 1 && groupBy === "none";
  return (
    <div className="space-y-6" data-testid="stock-admin-cards">
      {groups.map((g) => {
        const open = single || !closed.has(g.key);
        return (
          <section key={g.key} aria-label={g.label} className="space-y-2.5">
            {single ? null : (
              <GroupToggle label={g.label} open={open} onClick={() => toggle(g.key)} className="border-b border-border pb-1.5">
                <GroupMeta items={g.items} archivedView={archivedView} />
              </GroupToggle>
            )}
            {open ? (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {g.items.map((i) => <StockCard key={i.id} item={i} groupBy={groupBy} archivedView={archivedView} onOpen={onOpen} />)}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function StockCard({ item: i, groupBy, archivedView, onOpen }: { item: StockItem; groupBy: GroupBy; archivedView: boolean; onOpen: (id: string) => void }) {
  const where = whereLabel(i, groupBy);
  const empty = !archivedView && i.balanceMilli === 0;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(i.id)}
        className={cn(
          "group flex h-full w-full flex-col overflow-hidden rounded-card border bg-surface text-left transition-shadow hover:border-border-strong hover:shadow-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-navy",
          empty ? "border-state-warning-subtle-border" : "border-border",
        )}
        data-testid="stock-admin-card"
      >
        <span className="relative block aspect-[4/3] w-full overflow-hidden border-b border-border bg-surface-subtle">
          {i.photoId ? (
            <StockThumb photoId={i.photoId} alt="" size="lg" className="h-full w-full rounded-none border-0 transition-transform duration-300 group-hover:scale-[1.03]" />
          ) : (
            <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-text-muted">
              <Package aria-hidden="true" className="h-7 w-7 opacity-60" />
              <span className="text-[11px]">No photo</span>
            </span>
          )}
          {/* what needs attention sits on the photo, where the eye lands first */}
          <span className="absolute left-2 top-2 flex flex-wrap gap-1">
            {archivedView ? <Pill tone="neutral" dot className="bg-surface/95 shadow-sm">Archived</Pill> : null}
            {empty ? <Pill tone="warning" dot className="shadow-sm">None recorded</Pill> : null}
            {!archivedView && i.estimated && !empty ? <Pill tone="warning" className="shadow-sm">Estimate</Pill> : null}
          </span>
        </span>
        <span className="flex flex-1 flex-col gap-1 p-3">
          <span className="line-clamp-2 font-semibold leading-snug text-text" title={i.name}>{i.name}</span>
          {identityLine(i) ? <span className="line-clamp-1 text-[12.5px] text-text-muted">{identityLine(i)}</span> : null}
          <span className="mt-auto flex items-baseline justify-between gap-2 pt-2">
            {empty ? (
              <span className="font-display text-[22px] font-semibold leading-none tabular-nums text-text-muted">0 <span className="font-sans text-[13px] font-normal">{UNIT_LABEL[i.baseUnit].plural}</span></span>
            ) : (
              <RecordedCell item={i} size="lg" />
            )}
            {archivedView ? null : <CodePill item={i} />}
          </span>
          <span className="flex flex-col gap-0.5 border-t border-border pt-2 text-xs text-text-muted">
            <span className="truncate">{archivedView ? `Archived ${whenLabel(i.archivedAt)}` : countedLine(i)}</span>
            {where ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <MapPin aria-hidden="true" className="h-3 w-3 shrink-0" />
                <span className="truncate">{where}</span>
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

// ── board ────────────────────────────────────────────────────────────────────

export function StockBoard({ groups, groupBy, archivedView, onOpen }: ViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdge({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, groups]);
  const nudge = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * 312, behavior: "smooth" });

  return (
    <div className="relative" data-testid="stock-admin-board">
      {/* more columns off to one side: a fade and a button say so */}
      {edge.left ? (
        <>
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-surface to-transparent" />
          <button type="button" onClick={() => nudge(-1)} aria-label="Scroll to earlier columns" className="absolute -left-3 top-1/2 z-20 -translate-y-1/2 hidden h-7 w-7 items-center justify-center rounded-full border border-border-strong bg-surface shadow-raised sm:flex">
            <ChevronLeft aria-hidden="true" className="h-4 w-4" />
          </button>
        </>
      ) : null}
      {edge.right ? (
        <>
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-surface to-transparent" />
          <button type="button" onClick={() => nudge(1)} aria-label="Scroll to more columns" className="absolute -right-3 top-1/2 z-20 -translate-y-1/2 hidden h-7 w-7 items-center justify-center rounded-full border border-border-strong bg-surface shadow-raised sm:flex">
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </button>
        </>
      ) : null}
      <div ref={scroller} onScroll={measure} className="-mx-4 snap-x overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        <div className="flex items-start gap-3">
          {groups.map((g) => {
            const none = archivedView ? 0 : noneRecorded(g.items);
            return (
              <section key={g.key} aria-label={g.label} className="flex max-h-[calc(100vh-17rem)] min-h-[8rem] w-[296px] shrink-0 snap-start flex-col rounded-card border border-border bg-surface-subtle" data-testid="stock-board-column">
                <div className="flex shrink-0 items-baseline justify-between gap-2 border-b border-border px-3 py-2.5">
                  <span className="truncate font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text" title={g.label}>{g.label}</span>
                  <span className="shrink-0 text-xs text-text-muted">
                    {g.items.length}
                    {none ? <span className="font-medium text-state-warning"> · {none} none</span> : null}
                  </span>
                </div>
                <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
                  {g.items.map((i) => <BoardItem key={i.id} item={i} groupBy={groupBy} archivedView={archivedView} onOpen={onOpen} />)}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BoardItem({ item: i, groupBy, archivedView, onOpen }: { item: StockItem; groupBy: GroupBy; archivedView: boolean; onOpen: (id: string) => void }) {
  const where = whereLabel(i, groupBy);
  const empty = !archivedView && i.balanceMilli === 0;
  const sub = archivedView
    ? `Archived ${whenLabel(i.archivedAt)}`
    : [where, i.verificationStatus === "manufacturer_code_matched" ? null : CODE_SHORT[i.verificationStatus]].filter(Boolean).join(" · ");
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(i.id)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-[6px] border border-l-[3px] bg-surface p-2 text-left hover:border-border-strong",
          empty ? "border-state-warning-subtle-border border-l-state-warning" : i.estimated && !archivedView ? "border-border border-l-state-warning-subtle-border" : "border-border border-l-border",
        )}
        data-testid="stock-admin-board-item"
      >
        <StockThumb photoId={i.photoId} alt="" size="sm" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-text" title={i.name}>{i.name}</span>
          {sub ? <span className="block truncate text-xs text-text-muted">{sub}</span> : null}
        </span>
        <span className="shrink-0 text-right">
          {empty ? (
            <span className="text-xs font-semibold text-state-warning">None</span>
          ) : (
            <span className="block whitespace-nowrap" title={i.estimated ? "An estimate — a count clears it" : undefined}>
              <span className="font-display text-[15px] font-semibold tabular-nums text-text">{i.estimated ? "≈" : ""}{formatNumber(i.balanceMilli)}</span>
              <span className="ml-0.5 text-[11px] text-text-muted">{UNIT_LABEL[i.baseUnit].plural}</span>
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
