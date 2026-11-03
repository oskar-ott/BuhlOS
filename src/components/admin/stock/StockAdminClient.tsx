"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, Columns3, Grid3x3, LayoutGrid, Plus, RefreshCw, Rows3, Search, Tags } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { fetchStockList } from "@/domains/workshop-stock/client";
import { errorCopy, matchesSearch } from "@/domains/workshop-stock/format";
import { groupItems, isGroupBy, isView, type GroupBy, type StockView } from "@/domains/workshop-stock/views";
import { setPendingOwner } from "@/domains/workshop-stock/pending";
import type { StockList } from "@/domains/workshop-stock/schema";
import { STOCK_TYPES, typeOf } from "@/domains/workshop-stock/types";
import { StockAdminAdd } from "./StockAdminAdd";
import { StockCategories } from "./StockCategories";
import { findByBarcode } from "@/domains/workshop-stock/barcode";
import { useBarcodeScanner } from "@/components/stock/useBarcodeScanner";
import { StockItemDrawer } from "./StockItemDrawer";
import { StockBoard, StockCards, StockTable } from "./StockViews";

type Filter = "all" | "zero" | "estimated" | "check" | "unsorted" | "archived";

const FILTERS: Array<{ value: Filter; label: string; types?: true }> = [
  { value: "all", label: "All" },
  { value: "zero", label: "None recorded" },
  { value: "estimated", label: "Estimates" },
  { value: "check", label: "Code not confirmed" },
  { value: "unsorted", label: "Not sorted", types: true },
  { value: "archived", label: "Archived" },
];

const EXPLAIN: Partial<Record<Filter, string>> = {
  zero: "Items where nothing is recorded on the shelf. That is what's logged, not a check of the shelf.",
  estimated: "Items whose recorded quantity is an estimate — a rough count or a part-used roll. A count clears it.",
  check: "Items whose product code the online check couldn't fully confirm. Open one to re-run the check or correct the details.",
  unsorted: "Items without a type yet. The crew browse the phone by type (Switches & GPOs, LED strip, Cable…) — open one, the Details tab, and pick what it is; its fields fill in from the name for you to check.",
  archived: "Archived items are off the crew's list and their codes don't match photos. Open one to read its history or restore it.",
};


const TOOL = "inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-border bg-surface px-3 text-[13px] font-medium text-text hover:border-border-strong";

const VIEW_OPTIONS: Array<{ value: StockView; label: string; Icon: typeof Rows3 }> = [
  { value: "table", label: "Table", Icon: Rows3 },
  { value: "cards", label: "Cards", Icon: LayoutGrid },
  { value: "board", label: "Board", Icon: Columns3 },
];
const GROUP_OPTIONS: Array<{ value: GroupBy; label: string; types?: true }> = [
  { value: "shelf", label: "Shelf" },
  { value: "type", label: "Type", types: true },
  { value: "none", label: "Nothing (A–Z)" },
];

// The chosen view and grouping are a per-viewer convenience: remembered on
// this browser only, and the page works the same without it.
const PREF_KEY = "buhlos.stock.office.view";
function readPref(): { view: StockView; groupBy: GroupBy } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PREF_KEY) ?? "null") as { view?: unknown; groupBy?: unknown } | null;
    return { view: isView(raw?.view) ? raw.view : "table", groupBy: isGroupBy(raw?.groupBy) ? raw.groupBy : "shelf" };
  } catch {
    return { view: "table", groupBy: "shelf" };
  }
}
function writePref(p: { view: StockView; groupBy: GroupBy }) {
  try { window.localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* storage off: nothing to remember */ }
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
  const [typeFilter, setTypeFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(initialItemId ?? null);
  const [openLabel, setOpenLabel] = useState(false);
  const [adding, setAdding] = useState<false | { scannedBarcode: string | null }>(false);
  const [categories, setCategories] = useState(false);
  const [view, setView] = useState<StockView>("table");
  const [groupByPref, setGroupBy] = useState<GroupBy>("shelf");
  useEffect(() => { const p = readPref(); setView(p.view); setGroupBy(p.groupBy); }, []);
  function choose(next: { view?: StockView; groupBy?: GroupBy }) {
    const p = { view: next.view ?? view, groupBy: next.groupBy ?? groupByPref };
    setView(p.view); setGroupBy(p.groupBy); writePref(p);
  }

  const load = useCallback(async (archived: boolean) => {
    const r = await fetchStockList({ archived });
    if (r.ok) { setList(r.data); setState("ready"); setError(null); setPendingOwner(r.data.viewer.id); }
    else { setState("error"); setError(errorCopy(r.error.status, r.error.body, "The server didn't answer, so no quantities are shown — not even old ones. Nothing has changed on the record.")); }
  }, []);
  useEffect(() => { void load(filter === "archived"); }, [load, filter]);

  const items = useMemo(() => list?.items ?? [], [list]);
  // A barcode scanner at the office computer (2026-11-03): a listed item opens;
  // several narrow the search; an unknown code opens Add item with it kept.
  useBarcodeScanner((code) => {
    const hits = findByBarcode(items, code);
    if (hits.length === 1) { setOpenId(hits[0]!.item.id); return; }
    if (hits.length > 1) { setQ(code); return; }
    setOpenId(null);
    setAdding({ scannedBarcode: code });
  }, Boolean(list) && !adding && !categories);
  const failed = state === "error";
  const counts = useMemo(() => ({
    all: items.filter((i) => !i.archivedAt).length,
    zero: items.filter((i) => !i.archivedAt && i.balanceMilli === 0).length,
    estimated: items.filter((i) => !i.archivedAt && i.estimated).length,
    check: items.filter((i) => !i.archivedAt && i.verificationStatus !== "manufacturer_code_matched").length,
    unsorted: items.filter((i) => !i.archivedAt && !i.category).length,
    archived: items.filter((i) => Boolean(i.archivedAt)).length,
  }), [items]);
  const shown = useMemo(() => items.filter((i) => {
    if (filter === "archived") return Boolean(i.archivedAt);
    if (i.archivedAt) return false;
    if (filter === "zero") return i.balanceMilli === 0;
    if (filter === "estimated") return i.estimated;
    if (filter === "check") return i.verificationStatus !== "manufacturer_code_matched";
    if (filter === "unsorted") return !i.category;
    return true;
  }).filter((i) => !typeFilter || (i.category ? typeOf(i.category)!.key === typeFilter : false)).filter((i) => matchesSearch(i, q)), [items, filter, typeFilter, q]);
  const typesEnabled = list?.capabilities.types === true;
  // grouping by type needs types on the server; otherwise it reads as by shelf
  const groupBy: GroupBy = groupByPref === "type" && !typesEnabled ? "shelf" : groupByPref;
  const groups = useMemo(() => groupItems(shown, groupBy), [shown, groupBy]);
  const archivedView = filter === "archived";
  const nothingYet = state === "ready" && !items.length && !archivedView;

  return (
    <div className="space-y-3" data-testid="stock-admin">
      {/* one toolbar: find on the left, the tools and Add item on the right */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1 lg:max-w-[360px]">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, barcode or shelf" aria-label="Search workshop stock" className="h-9 w-full rounded-[4px] border border-border-strong bg-surface pl-8 pr-3 text-sm" data-testid="stock-admin-search" />
        </div>
        {typesEnabled ? (
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Type of item" className="h-9 rounded-[4px] border border-border-strong bg-surface px-2 text-sm" data-testid="stock-admin-type">
            <option value="">All types</option>
            {STOCK_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <Link href="/stock/intake" className={TOOL} data-testid="stock-open-intake">
            <Camera aria-hidden="true" className="h-4 w-4" /> Camera table
          </Link>
          <Link href="/stock/locations" className={TOOL} data-testid="stock-open-matrix">
            <Grid3x3 aria-hidden="true" className="h-4 w-4" /> Location matrix
          </Link>
          {typesEnabled && list?.capabilities.customTypes ? (
            <button type="button" className={TOOL} onClick={() => setCategories(true)} data-testid="stock-admin-categories">
              <Tags aria-hidden="true" className="h-4 w-4" /> Categories
            </button>
          ) : null}
          <Button type="button" size="sm" className="h-9" onClick={() => setAdding({ scannedBarcode: null })} disabled={!list} data-testid="stock-admin-add">
            <Plus aria-hidden="true" className="h-4 w-4" /> Add item
          </Button>
        </div>
      </div>

      {/* the filters as tabs on the list; how it's laid out and grouped on the right */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border">
      <div role="tablist" aria-label="Filter workshop stock" className="-mx-4 -mb-px flex w-full min-w-0 gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0 lg:w-auto lg:flex-1">
        {FILTERS.filter((f) => !f.types || typesEnabled).map((f) => {
          const active = f.value === filter;
          const n = failed || !list ? null : filter === "archived" && f.value !== "archived" ? counts[f.value] : f.value === "archived" && filter !== "archived" ? null : counts[f.value];
          return (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(f.value)}
              className={cn("-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 pb-2 pt-1.5 text-[13px] font-medium", active ? "border-brand-navy text-text" : "border-transparent text-text-muted hover:text-text")}
            >
              {f.label}
              {n === null ? null : (
                <span className={cn("rounded-full px-1.5 py-px font-mono text-[11px] font-bold tabular-nums", active ? "bg-brand-navy text-text-inverse" : n > 0 && f.value !== "all" ? "bg-surface-subtle text-text" : "bg-surface-subtle text-text-muted")}>{n}</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="order-first flex items-center gap-2 pb-1.5 lg:order-none">
        <label className="flex items-center gap-1.5 text-[13px] text-text-muted">
          Group by
          <select value={groupBy} onChange={(e) => choose({ groupBy: e.target.value as GroupBy })} className="h-8 rounded-[4px] border border-border-strong bg-surface px-1.5 text-[13px] text-text" data-testid="stock-admin-group-by">
            {GROUP_OPTIONS.filter((g) => !g.types || typesEnabled).map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </label>
        <div role="radiogroup" aria-label="View" className="inline-flex rounded-[4px] border border-border-strong bg-surface p-0.5">
          {VIEW_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={view === value}
              title={label}
              onClick={() => choose({ view: value })}
              className={cn("inline-flex h-7 items-center gap-1.5 rounded-[3px] px-2 text-[13px] font-medium", view === value ? "bg-brand-navy text-text-inverse" : "text-text-muted hover:text-text")}
              data-testid={`stock-admin-view-${value}`}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              <span className="hidden md:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>
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
          <Button type="button" size="sm" className="mt-4" onClick={() => setAdding({ scannedBarcode: null })}>
            <Plus aria-hidden="true" className="h-4 w-4" /> Add item
          </Button>
        </div>
      ) : !shown.length ? (
        <p className="rounded-card border border-dashed border-border bg-surface-subtle p-6 text-center text-sm text-text-muted">
          {q.trim() ? `Nothing matches "${q.trim()}".` : archivedView ? "Nothing has been archived." : "Nothing in this view."}
        </p>
      ) : (
        <>
          {view === "cards" ? (
            <StockCards groups={groups} groupBy={groupBy} archivedView={archivedView} onOpen={setOpenId} />
          ) : view === "board" ? (
            <StockBoard groups={groups} groupBy={groupBy} archivedView={archivedView} onOpen={setOpenId} />
          ) : (
            <StockTable groups={groups} groupBy={groupBy} archivedView={archivedView} onOpen={setOpenId} />
          )}
          <p className="text-xs text-text-muted">Quantities are what the crew recorded — not a guarantee of what&rsquo;s on the shelf; correct one with a count. Taking stock never adds a job cost.</p>
        </>
      )}

      {openId && list ? <StockItemDrawer key={`${openId}-${openLabel}`} labelOpenAtStart={openLabel} itemId={openId} lookupEnabled={list.capabilities.lookup} locationPhotoEnabled={list.capabilities.locationPhoto === true} typesEnabled={typesEnabled} onClose={() => { setOpenId(null); setOpenLabel(false); }} onChanged={() => void load(filter === "archived")} /> : null}
      {categories && list ? <StockCategories customTypes={list.customTypes ?? []} items={items} onSaved={() => void load(filter === "archived")} onClose={() => setCategories(false)} /> : null}
      {adding && list ? <StockAdminAdd scannedBarcode={adding.scannedBarcode} items={items} capabilities={list.capabilities} onSaved={() => void load(filter === "archived")} onOpenItem={(id, opts) => { setAdding(false); setOpenLabel(Boolean(opts?.label)); setOpenId(id); }} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

