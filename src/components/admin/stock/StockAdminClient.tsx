"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { StockItemRow } from "@/components/stock/StockItemRow";
import { StockThumb } from "@/components/stock/StockThumb";
import { cn } from "@/lib/cn";
import { fetchStockList } from "@/domains/workshop-stock/client";
import { errorCopy, formatNumber, identityLine, matchesSearch, UNIT_LABEL, verificationLine, whenLabel } from "@/domains/workshop-stock/format";
import { binOf, groupByShelf } from "@/domains/workshop-stock/location";
import { setPendingOwner } from "@/domains/workshop-stock/pending";
import type { StockItem, StockList, VerificationStatus } from "@/domains/workshop-stock/schema";
import { StockAdminAdd } from "./StockAdminAdd";
import { StockItemDrawer } from "./StockItemDrawer";

type Filter = "all" | "zero" | "estimated" | "check" | "archived";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "zero", label: "None recorded" },
  { value: "estimated", label: "Estimates" },
  { value: "check", label: "Code not confirmed" },
  { value: "archived", label: "Archived" },
];

const EXPLAIN: Partial<Record<Filter, string>> = {
  zero: "Items where nothing is recorded on the shelf. That is what's logged, not a check of the shelf.",
  estimated: "Items whose recorded quantity is an estimate — a rough count or a part-used roll. A count clears it.",
  check: "Items whose product code the online check couldn't fully confirm. Open one to re-run the check or correct the details.",
  archived: "Archived items are off the crew's list and their codes don't match photos. Open one to read its history or restore it.",
};

export const CODE_TONE: Record<VerificationStatus, "success" | "warning" | "neutral"> = { manufacturer_code_matched: "success", possible_match: "warning", unverified: "neutral" };

/** The recorded quantity in a table cell: the number leads, the unit follows; zero is a pill, an estimate says so. */
function RecordedCell({ item }: { item: StockItem }) {
  if (item.balanceMilli === 0) return <Pill tone="warning" dot>None recorded</Pill>;
  return (
    <span className="whitespace-nowrap">
      <span className="font-display text-[15px] font-semibold tabular-nums text-text">{item.estimated ? "≈ " : ""}{formatNumber(item.balanceMilli)}</span>{" "}
      <span className="text-[13px] font-medium text-text-muted">{UNIT_LABEL[item.baseUnit].plural}{item.estimated ? " · estimate" : ""}</span>
    </span>
  );
}

/**
 * /stock — the office view of Workshop Stock: every item read by shelf, its
 * recorded balance, when it last moved and was last counted, and how well its
 * product code is confirmed (with the reason). Click a row for counts, the
 * movement history and audited Undo, the catalogue, and archive. No KPI row,
 * no gauges: a list and the facts on it.
 */
export function StockAdminClient({ initialItemId }: { initialItemId?: string | null }) {
  const [list, setList] = useState<StockList | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(initialItemId ?? null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (archived: boolean) => {
    const r = await fetchStockList({ archived });
    if (r.ok) { setList(r.data); setState("ready"); setError(null); setPendingOwner(r.data.viewer.id); }
    else { setState("error"); setError(errorCopy(r.error.status, r.error.body, "The server didn't answer, so no quantities are shown — not even old ones. Nothing has changed on the record.")); }
  }, []);
  useEffect(() => { void load(filter === "archived"); }, [load, filter]);

  const items = useMemo(() => list?.items ?? [], [list]);
  const failed = state === "error";
  const counts = useMemo(() => ({
    all: items.filter((i) => !i.archivedAt).length,
    zero: items.filter((i) => !i.archivedAt && i.balanceMilli === 0).length,
    estimated: items.filter((i) => !i.archivedAt && i.estimated).length,
    check: items.filter((i) => !i.archivedAt && i.verificationStatus !== "manufacturer_code_matched").length,
    archived: items.filter((i) => Boolean(i.archivedAt)).length,
  }), [items]);
  const shown = useMemo(() => items.filter((i) => {
    if (filter === "archived") return Boolean(i.archivedAt);
    if (i.archivedAt) return false;
    if (filter === "zero") return i.balanceMilli === 0;
    if (filter === "estimated") return i.estimated;
    if (filter === "check") return i.verificationStatus !== "manufacturer_code_matched";
    return true;
  }).filter((i) => matchesSearch(i, q)), [items, filter, q]);
  const groups = useMemo(() => groupByShelf(shown), [shown]);
  const archivedView = filter === "archived";
  const nothingYet = state === "ready" && !items.length && !archivedView;

  return (
    <div className="space-y-4" data-testid="stock-admin">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Filter workshop stock" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const active = f.value === filter;
            const n = failed || !list ? null : filter === "archived" && f.value !== "archived" ? counts[f.value] : f.value === "archived" && filter !== "archived" ? null : counts[f.value];
            return (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f.value)}
                className={cn("inline-flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[13px] font-medium", active ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border bg-surface text-text hover:border-border-strong")}
              >
                {f.label}
                <span className={cn("font-mono text-[12px] font-bold tabular-nums", active ? "text-text-inverse" : "text-text-muted")}>{n === null ? "—" : n}</span>
              </button>
            );
          })}
        </div>
        <span className="flex-1" />
        <div className="relative w-full sm:w-[300px]">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, barcode or shelf" aria-label="Search workshop stock" className="h-9 w-full rounded-[4px] border border-border-strong bg-surface pl-8 pr-3 text-sm" data-testid="stock-admin-search" />
        </div>
        <Button type="button" size="sm" onClick={() => setAdding(true)} disabled={!list} data-testid="stock-admin-add">
          <Plus aria-hidden="true" className="h-4 w-4" /> Add item
        </Button>
      </div>
      {EXPLAIN[filter] && !failed ? <p className="text-sm text-text-muted">{EXPLAIN[filter]}</p> : null}

      {state === "loading" && !list ? (
        <div className="space-y-2" aria-busy="true" role="status" aria-label="Loading workshop stock">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-[4px] bg-surface-subtle" />)}
        </div>
      ) : failed ? (
        <div className="flex items-start gap-3 rounded-card border border-state-warning-subtle-border bg-state-warning-subtle-bg p-4" role="alert">
          <RefreshCw aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-state-warning" />
          <div>
            <p className="font-display text-base font-semibold text-text">Couldn&rsquo;t load workshop stock</p>
            <p className="mt-1 text-sm text-text-muted">{error}</p>
            <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => { setState("loading"); void load(filter === "archived"); }}>Refresh</Button>
          </div>
        </div>
      ) : nothingYet ? (
        <div className="rounded-card border border-dashed border-border-strong bg-surface-subtle px-6 py-12 text-center">
          <p className="font-display text-lg font-semibold text-text">Nothing recorded yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">The crew add stock from the phone by photographing each item — Add or return, then Add stock. You can also add one here by hand.</p>
          <Button type="button" size="sm" className="mt-4" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" className="h-4 w-4" /> Add item
          </Button>
        </div>
      ) : !shown.length ? (
        <p className="rounded-card border border-dashed border-border bg-surface-subtle p-6 text-center text-sm text-text-muted">
          {q.trim() ? `Nothing matches "${q.trim()}".` : archivedView ? "Nothing has been archived." : "Nothing in this view."}
        </p>
      ) : (
        <>
          {/* phone: rows with the same facts */}
          <div className="-mx-4 sm:hidden">
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <div className="flex items-baseline justify-between border-y border-border bg-surface-subtle px-4 py-2">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text">{g.label}</span>
                  <span className="text-xs text-text-muted">{g.items.length} {g.items.length === 1 ? "item" : "items"}</span>
                </div>
                <ul>
                  {g.items.map((i) => (
                    <li key={i.id}>
                      <StockItemRow
                        item={i}
                        inGroup
                        onClick={() => setOpenId(i.id)}
                        meta={archivedView ? `Archived ${whenLabel(i.archivedAt)}` : `Last moved ${i.lastMovementAt ? whenLabel(i.lastMovementAt) : "never"} · counted ${i.lastCountedAt ? whenLabel(i.lastCountedAt) : "never"}`}
                        hint={!archivedView && i.verificationStatus !== "manufacturer_code_matched" ? verificationLine(i) : null}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full border-collapse text-left text-sm" data-testid="stock-admin-table">
              <thead>
                <tr className="border-b border-border-strong font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                  <th className="w-[30%] px-3 py-2.5">Item</th>
                  <th className="px-3 py-2.5">{archivedView ? "Shelf" : "Bin"}</th>
                  <th className="px-3 py-2.5">{archivedView ? "Recorded when archived" : "Recorded"}</th>
                  <th className="px-3 py-2.5">{archivedView ? "Archived" : "Last movement"}</th>
                  <th className="px-3 py-2.5">{archivedView ? "Status" : "Last counted"}</th>
                  {archivedView ? null : <th className="px-3 py-2.5">Product code</th>}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows key={g.label} label={g.label} items={g.items} archivedView={archivedView} onOpen={setOpenId} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {openId && list ? <StockItemDrawer itemId={openId} lookupEnabled={list.capabilities.lookup} onClose={() => setOpenId(null)} onChanged={() => void load(filter === "archived")} /> : null}
      {adding && list ? <StockAdminAdd items={items} capabilities={list.capabilities} onSaved={() => void load(filter === "archived")} onOpenItem={(id) => { setAdding(false); setOpenId(id); }} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function GroupRows({ label, items, archivedView, onOpen }: { label: string; items: StockItem[]; archivedView: boolean; onOpen: (id: string) => void }) {
  return (
    <>
      <tr data-testid="stock-admin-group">
        <td colSpan={archivedView ? 5 : 6} className="border-b border-border bg-surface-subtle px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text">
          {label} · {items.length} {items.length === 1 ? "item" : "items"}
        </td>
      </tr>
      {items.map((i) => (
        <tr key={i.id} className="cursor-pointer border-b border-border hover:bg-surface-subtle" onClick={() => onOpen(i.id)} data-testid="stock-admin-row">
          <td className="px-3 py-2">
            <button type="button" className="flex items-center gap-2.5 text-left" onClick={(e) => { e.stopPropagation(); onOpen(i.id); }}>
              <StockThumb photoId={i.photoId} alt="" size="xs" />
              <span>
                <span className="block font-semibold text-text">{i.name}</span>
                <span className="block text-[12.5px] text-text-muted">{identityLine(i) || "—"}</span>
              </span>
            </button>
          </td>
          <td className="px-3 py-2 text-[13px] text-text-muted">{(archivedView ? i.location : binOf(i.location)) || "—"}</td>
          <td className="px-3 py-2"><RecordedCell item={i} /></td>
          {archivedView ? (
            <>
              <td className="px-3 py-2 text-[13px] text-text">{whenLabel(i.archivedAt)}</td>
              <td className="px-3 py-2"><Pill tone="neutral" dot>Archived</Pill></td>
            </>
          ) : (
            <>
              <td className="px-3 py-2 text-[13px] text-text-muted">{i.lastMovementAt ? whenLabel(i.lastMovementAt) : "—"}</td>
              <td className="px-3 py-2 text-[13px]">
                {i.lastCountedAt ? (
                  <>
                    <span className="block text-text">{whenLabel(i.lastCountedAt)}</span>
                    {i.lastCountedByName ? <span className="block text-xs text-text-muted">{i.lastCountedByName}</span> : null}
                  </>
                ) : (
                  <span className="text-text-muted">Never</span>
                )}
              </td>
              <td className="px-3 py-2">
                <Pill tone={CODE_TONE[i.verificationStatus]} dot className="whitespace-nowrap font-medium normal-case tracking-normal">{verificationLine(i)}</Pill>
              </td>
            </>
          )}
        </tr>
      ))}
    </>
  );
}

