"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutGrid, List, Plus, RefreshCw, Search, Tags, X } from "lucide-react";
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
import { applyFacets, facetsFor, typeOf, typeTiles, type FacetChoice } from "@/domains/workshop-stock/types";
import { CATALOG_SORTS, isCatalogSort, sortCatalog, type CatalogSort } from "@/domains/workshop-stock/catalog";
import { StockAdminAdd } from "./StockAdminAdd";
import { CatalogDepartments, CatalogGrid } from "./StockCatalog";
import { StockCategories } from "./StockCategories";
import { findByBarcode } from "@/domains/workshop-stock/barcode";
import { useBarcodeScanner } from "@/components/stock/useBarcodeScanner";
import { StockItemDrawer } from "./StockItemDrawer";

type Filter = "all" | "zero" | "estimated" | "check" | "unsorted" | "archived";
type View = "catalog" | "list";

/** The office's choice of cards or table, and the sort, kept per browser (a convenience — the page works without it). */
const VIEW_KEY = "buhlos.stock.view";
const SORT_KEY = "buhlos.stock.sort";
function remember(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* private window: not remembered */ }
}
function recall(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

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
  unsorted: "Items without a type yet. The crew browse the phone by type (Switches & GPOs, LED strip, Cable…) — open one, Catalogue → Details, and pick what it is; its fields fill in from the name for you to check.",
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
 * /stock — the office view of Workshop Stock. Opens as a catalogue (owner
 * pull 2026-11-09: "feel like an online store catalog"): product cards with
 * their photo, departments by item type with their filters, a sort. The list
 * is one click away: every item read by shelf, its recorded balance, when it
 * last moved and was last counted, and how well its product code is confirmed.
 * Click a card or row for counts, the movement history and audited Undo, the
 * catalogue, and archive. No KPI row, no gauges, no prices: the facts on record.
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
  const [view, setViewState] = useState<View>("catalog");
  const [sort, setSortState] = useState<CatalogSort>("name");
  const [facetChoice, setFacetChoice] = useState<FacetChoice>({});
  useEffect(() => {
    const v = recall(VIEW_KEY);
    if (v === "list" || v === "catalog") setViewState(v);
    const so = recall(SORT_KEY);
    if (isCatalogSort(so)) setSortState(so);
  }, []);
  const setView = (v: View) => { setViewState(v); remember(VIEW_KEY, v); };
  const setSort = (v: CatalogSort) => { setSortState(v); remember(SORT_KEY, v); };
  const pickType = (key: string) => { setTypeFilter(key); setFacetChoice({}); };

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
  // In view before the department: the status filter and the search.
  const inView = useMemo(() => items.filter((i) => {
    if (filter === "archived") return Boolean(i.archivedAt);
    if (i.archivedAt) return false;
    if (filter === "zero") return i.balanceMilli === 0;
    if (filter === "estimated") return i.estimated;
    if (filter === "check") return i.verificationStatus !== "manufacturer_code_matched";
    if (filter === "unsorted") return !i.category;
    return true;
  }).filter((i) => matchesSearch(i, q)), [items, filter, q]);
  const typesEnabled = list?.capabilities.types === true;
  const activeType = typesEnabled && typeFilter ? typeOf(typeFilter) : null;
  const tiles = useMemo(() => {
    if (!typesEnabled) return [];
    const t = typeTiles(inView).filter((x) => x.key !== null);
    // the department picked stays in the list (at 0) when a search empties it
    if (activeType && !t.some((x) => x.key === activeType.key)) t.push({ key: activeType.key, label: activeType.label, count: 0, sample: [] });
    return t;
  }, [inView, typesEnabled, activeType]);
  const ofType = useMemo(() => (activeType ? inView.filter((i) => (i.category ? typeOf(i.category)!.key === activeType.key : false)) : inView), [inView, activeType]);
  const facets = useMemo(() => (activeType ? facetsFor(activeType, ofType, facetChoice) : []), [activeType, ofType, facetChoice]);
  const shown = useMemo(() => (activeType ? applyFacets(activeType, ofType, facetChoice) : ofType), [activeType, ofType, facetChoice]);
  const catalogItems = useMemo(() => sortCatalog(shown, sort), [shown, sort]);
  const groups = useMemo(() => groupByShelf(shown), [shown]);
  const chosen = facets.flatMap((f) => {
    const v = f.values.find((x) => x.key === facetChoice[f.field.key]);
    return v ? [{ field: f.field, value: v }] : [];
  });
  const archivedView = filter === "archived";
  const nothingYet = state === "ready" && !items.length && !archivedView;

  const showSide = typesEnabled && !failed && Boolean(list) && !nothingYet;
  const dropChoice = (key: string) => setFacetChoice((c) => { const n = { ...c }; delete n[key]; return n; });

  return (
    <div className="space-y-4" data-testid="stock-admin">
      {/* the shop's search bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-72">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-text-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the workshop — name, code, barcode or shelf" aria-label="Search workshop stock" className="h-11 w-full rounded-pill border border-border-strong bg-surface pl-10 pr-4 text-[15px] shadow-card placeholder:text-text-muted" data-testid="stock-admin-search" />
        </div>
        {typesEnabled && list?.capabilities.customTypes ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setCategories(true)} data-testid="stock-admin-categories">
            <Tags aria-hidden="true" className="h-4 w-4" /> Categories
          </Button>
        ) : null}
        <Button type="button" size="sm" onClick={() => setAdding({ scannedBarcode: null })} disabled={!list} data-testid="stock-admin-add">
          <Plus aria-hidden="true" className="h-4 w-4" /> Add item
        </Button>
      </div>
      <div role="tablist" aria-label="Filter workshop stock" className="flex flex-wrap gap-1.5">
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
              className={cn("inline-flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[13px] font-medium", active ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border bg-surface text-text hover:border-border-strong")}
            >
              {f.label}
              <span className={cn("font-mono text-[12px] font-bold tabular-nums", active ? "text-text-inverse" : "text-text-muted")}>{n === null ? "—" : n}</span>
            </button>
          );
        })}
      </div>
      {EXPLAIN[filter] && !failed ? <p className="text-sm text-text-muted">{EXPLAIN[filter]}</p> : null}

      <div className={cn(showSide && "lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start lg:gap-8")}>
        {showSide ? (
          <aside className="mb-4 lg:sticky lg:top-4 lg:mb-0">
            <CatalogDepartments tiles={tiles} total={inView.length} active={activeType?.key ?? ""} onPick={pickType} facets={facets} choice={facetChoice} onChoose={(k, v) => (v === null ? dropChoice(k) : setFacetChoice((c) => ({ ...c, [k]: v })))} />
          </aside>
        ) : null}
        <div className="min-w-0 space-y-3">
          {list && !failed && !nothingYet ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="stock-admin-results">
              <h2 className="font-display text-lg font-semibold text-text">{activeType?.label ?? (archivedView ? "Archived" : "All items")}</h2>
              <span className="text-sm text-text-muted">{shown.length} {shown.length === 1 ? "item" : "items"}</span>
              {chosen.map((c) => (
                <button key={c.field.key} type="button" onClick={() => dropChoice(c.field.key)} aria-label={`Remove filter ${c.field.label}: ${c.value.value}`} className="inline-flex h-7 items-center gap-1 rounded-pill border border-border-strong bg-surface-subtle px-2.5 text-[12.5px] font-medium text-text hover:border-brand-navy">
                  <span className="text-text-muted">{c.field.label}:</span> {c.value.value}
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              ))}
              {chosen.length > 1 ? (
                <button type="button" onClick={() => setFacetChoice({})} className="text-[13px] font-medium text-text underline decoration-accent-yellow decoration-2 underline-offset-2">Clear filters</button>
              ) : null}
              <span className="flex-1" />
              {view === "catalog" ? (
                <label className="inline-flex items-center gap-1.5 text-[13px] text-text-muted">
                  Sort
                  <select value={sort} onChange={(e) => setSort(e.target.value as CatalogSort)} className="h-8 rounded-[4px] border border-border-strong bg-surface px-2 text-[13px] text-text" data-testid="stock-admin-sort">
                    {CATALOG_SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
              ) : null}
              <div role="group" aria-label="Show as" className="inline-flex overflow-hidden rounded-[4px] border border-border-strong">
                {([["catalog", "Catalogue", LayoutGrid], ["list", "List", List]] as const).map(([v, label, Icon]) => (
                  <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} data-testid={`stock-view-${v}`} className={cn("inline-flex h-8 items-center gap-1.5 px-2.5 text-[13px] font-medium", view === v ? "bg-brand-navy text-text-inverse" : "bg-surface text-text hover:bg-surface-subtle")}>
                    <Icon aria-hidden="true" className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {state === "loading" && !list ? (
            view === "catalog" ? (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4" aria-busy="true" role="status" aria-label="Loading workshop stock">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <li key={i} className="overflow-hidden rounded-card border border-border bg-surface">
                    <div className="aspect-square animate-pulse bg-surface-subtle" />
                    <div className="space-y-2 p-3"><div className="h-3 w-1/3 animate-pulse rounded bg-surface-subtle" /><div className="h-4 w-4/5 animate-pulse rounded bg-surface-subtle" /><div className="h-4 w-1/2 animate-pulse rounded bg-surface-subtle" /></div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="space-y-2" aria-busy="true" role="status" aria-label="Loading workshop stock">
                {[0, 1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-[4px] bg-surface-subtle" />)}
              </div>
            )
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
              {q.trim() ? `Nothing matches "${q.trim()}".` : chosen.length ? "Nothing matches those filters." : archivedView ? "Nothing has been archived." : "Nothing in this view."}
            </p>
          ) : view === "catalog" ? (
            <CatalogGrid items={catalogItems} archived={archivedView} byShelf={sort === "shelf"} showType={typesEnabled && !activeType} onOpen={setOpenId} />
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
        </div>
      </div>

      {openId && list ? <StockItemDrawer key={`${openId}-${openLabel}`} labelOpenAtStart={openLabel} itemId={openId} lookupEnabled={list.capabilities.lookup} locationPhotoEnabled={list.capabilities.locationPhoto === true} typesEnabled={typesEnabled} onClose={() => { setOpenId(null); setOpenLabel(false); }} onChanged={() => void load(filter === "archived")} /> : null}
      {categories && list ? <StockCategories customTypes={list.customTypes ?? []} items={items} onSaved={() => void load(filter === "archived")} onClose={() => setCategories(false)} /> : null}
      {adding && list ? <StockAdminAdd scannedBarcode={adding.scannedBarcode} items={items} capabilities={list.capabilities} onSaved={() => void load(filter === "archived")} onOpenItem={(id, opts) => { setAdding(false); setOpenLabel(Boolean(opts?.label)); setOpenId(id); }} onClose={() => setAdding(false)} /> : null}
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

