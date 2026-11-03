"use client";

import { MapPin } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { StockItemRow } from "@/components/stock/StockItemRow";
import { StockThumb } from "@/components/stock/StockThumb";
import { cn } from "@/lib/cn";
import { formatNumber, identityLine, UNIT_LABEL, verificationLine, whenLabel } from "@/domains/workshop-stock/format";
import { binOf } from "@/domains/workshop-stock/location";
import type { StockItem } from "@/domains/workshop-stock/schema";
import type { GroupBy, ItemGroup } from "@/domains/workshop-stock/views";
import { CODE_SHORT, CODE_TONE } from "./code-status";

/**
 * The office list's three views over the SAME groups (views.ts): a table to
 * read across, cards to recognise items by their photo, and a board with one
 * column per shelf (or type) — the workshop as you'd walk it. Every view opens
 * the same drawer; none adds a number the list doesn't already hold (P7).
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

function GroupHeading({ label, count, className }: { label: string; count: number; className?: string }) {
  return (
    <p className={cn("text-[13px] font-semibold text-text", className)}>
      {label} <span className="font-normal text-text-muted">· {count} {count === 1 ? "item" : "items"}</span>
    </p>
  );
}

// ── table ────────────────────────────────────────────────────────────────────

export function StockTable({ groups, groupBy, archivedView, onOpen }: ViewProps) {
  const all = groups.flatMap((g) => g.items);
  // The where column earns its place only when something in view has one to show.
  const showWhere = archivedView || all.some((i) => whereLabel(i, groupBy));
  const whereHead = archivedView || groupBy !== "shelf" ? "Shelf" : "Bin";
  const cols = (archivedView ? 5 : 6) - (showWhere ? 0 : 1);
  const single = groups.length === 1 && groupBy === "none";

  return (
    <>
      {/* phone: rows with the same facts */}
      <div className="-mx-4 sm:hidden">
        {groups.map((g) => (
          <section key={g.key} aria-label={g.label}>
            {single ? null : (
              <div className="flex items-baseline justify-between border-y border-border bg-surface-subtle px-4 py-2">
                <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text">{g.label}</span>
                <span className="text-xs text-text-muted">{g.items.length} {g.items.length === 1 ? "item" : "items"}</span>
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

      <div className="hidden overflow-x-auto rounded-card border border-border bg-surface sm:block">
        <table className="w-full border-collapse text-left text-sm" data-testid="stock-admin-table">
          <thead>
            <tr className="border-b border-border font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              <th className="px-3 py-2.5">Item</th>
              {showWhere ? <th className="px-3 py-2.5">{whereHead}</th> : null}
              <th className="px-3 py-2.5 text-right">{archivedView ? "Recorded when archived" : "Recorded"}</th>
              <th className="px-3 py-2.5">{archivedView ? "Archived" : "Last moved"}</th>
              <th className="px-3 py-2.5">{archivedView ? "Status" : "Last counted"}</th>
              {archivedView ? null : <th className="px-3 py-2.5">Code</th>}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <TableGroup key={g.key} group={g} groupBy={groupBy} archivedView={archivedView} showWhere={showWhere} cols={cols} heading={!single} onOpen={onOpen} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TableGroup({ group, groupBy, archivedView, showWhere, cols, heading, onOpen }: { group: ItemGroup<StockItem>; groupBy: GroupBy; archivedView: boolean; showWhere: boolean; cols: number; heading: boolean; onOpen: (id: string) => void }) {
  return (
    <>
      {heading ? (
        <tr data-testid="stock-admin-group">
          <td colSpan={cols} className="border-b border-border bg-surface-subtle px-3 pb-1.5 pt-3">
            <GroupHeading label={group.label} count={group.items.length} />
          </td>
        </tr>
      ) : null}
      {group.items.map((i) => (
        <tr key={i.id} className="cursor-pointer border-b border-border last:border-b-0 hover:bg-surface-subtle" onClick={() => onOpen(i.id)} data-testid="stock-admin-row">
          <td className="px-3 py-2">
            <button type="button" className="flex items-center gap-2.5 text-left" onClick={(e) => { e.stopPropagation(); onOpen(i.id); }}>
              <StockThumb photoId={i.photoId} alt="" size="xs" />
              <span className="min-w-0">
                <span className="block font-semibold text-text">{i.name}</span>
                {identityLine(i) ? <span className="block text-[12.5px] text-text-muted">{identityLine(i)}</span> : null}
              </span>
            </button>
          </td>
          {showWhere ? <td className="px-3 py-2 text-[13px] text-text-muted">{(archivedView ? i.location : whereLabel(i, groupBy)) || ""}</td> : null}
          <td className="px-3 py-2 text-right"><RecordedCell item={i} /></td>
          {archivedView ? (
            <>
              <td className="px-3 py-2 text-[13px] text-text">{whenLabel(i.archivedAt)}</td>
              <td className="px-3 py-2"><Pill tone="neutral" dot>Archived</Pill></td>
            </>
          ) : (
            <>
              <td className="whitespace-nowrap px-3 py-2 text-[13px] text-text-muted">{i.lastMovementAt ? whenLabel(i.lastMovementAt) : "Never"}</td>
              <td className="whitespace-nowrap px-3 py-2 text-[13px]">
                {i.lastCountedAt ? (
                  <span className="text-text">{whenLabel(i.lastCountedAt)}{i.lastCountedByName ? <span className="text-text-muted"> · {i.lastCountedByName}</span> : null}</span>
                ) : (
                  <span className="text-text-muted">Never</span>
                )}
              </td>
              <td className="px-3 py-2"><CodePill item={i} /></td>
            </>
          )}
        </tr>
      ))}
    </>
  );
}

// ── cards ────────────────────────────────────────────────────────────────────

export function StockCards({ groups, groupBy, archivedView, onOpen }: ViewProps) {
  const single = groups.length === 1 && groupBy === "none";
  return (
    <div className="space-y-5" data-testid="stock-admin-cards">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label} className="space-y-2">
          {single ? null : <GroupHeading label={g.label} count={g.items.length} />}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {g.items.map((i) => {
              const where = whereLabel(i, groupBy);
              return (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(i.id)}
                    className="flex h-full w-full flex-col overflow-hidden rounded-card border border-border bg-surface text-left hover:border-border-strong hover:shadow-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-navy"
                    data-testid="stock-admin-card"
                  >
                    <StockThumb photoId={i.photoId} alt="" size="lg" className="aspect-[4/3] h-auto w-full rounded-none border-0 border-b border-border" />
                    <span className="flex flex-1 flex-col gap-1.5 p-3">
                      <span className="line-clamp-2 font-semibold leading-snug text-text">{i.name}</span>
                      {identityLine(i) ? <span className="line-clamp-1 text-[12.5px] text-text-muted">{identityLine(i)}</span> : null}
                      <span className="mt-auto flex items-end justify-between gap-2 pt-1">
                        <RecordedCell item={i} size="lg" />
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
                        {archivedView ? <Pill tone="neutral" dot>Archived {whenLabel(i.archivedAt)}</Pill> : <CodePill item={i} />}
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
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ── board ────────────────────────────────────────────────────────────────────

export function StockBoard({ groups, groupBy, archivedView, onOpen }: ViewProps) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" data-testid="stock-admin-board">
      <div className="flex items-start gap-3">
        {groups.map((g) => (
          <section key={g.key} aria-label={g.label} className="w-[296px] shrink-0 rounded-card border border-border bg-surface-subtle">
            <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2.5">
              <span className="truncate font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text" title={g.label}>{g.label}</span>
              <span className="shrink-0 text-xs text-text-muted">{g.items.length}</span>
            </div>
            <ul className="space-y-1.5 p-2">
              {g.items.map((i) => {
                const where = whereLabel(i, groupBy);
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(i.id)}
                      className="flex w-full items-center gap-2.5 rounded-[6px] border border-border bg-surface p-2 text-left hover:border-border-strong"
                      data-testid="stock-admin-board-item"
                    >
                      <StockThumb photoId={i.photoId} alt="" size="xs" />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-text" title={i.name}>{i.name}</span>
                        <span className="block truncate text-xs text-text-muted">
                          {archivedView ? `Archived ${whenLabel(i.archivedAt)}` : [where, i.verificationStatus === "manufacturer_code_matched" ? null : CODE_SHORT[i.verificationStatus]].filter(Boolean).join(" · ") || " "}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        {i.balanceMilli === 0 ? (
                          <span className="text-xs font-semibold text-state-warning">None</span>
                        ) : (
                          <span className="whitespace-nowrap">
                            <span className="font-display text-[14px] font-semibold tabular-nums text-text">{i.estimated ? "≈" : ""}{formatNumber(i.balanceMilli)}</span>
                            <span className="ml-0.5 text-[11px] text-text-muted">{UNIT_LABEL[i.baseUnit].plural}</span>
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
