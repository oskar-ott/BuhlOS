"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Seg } from "@/components/ui/Seg";
import { StockItemRow } from "@/components/stock/StockItemRow";
import { fetchStockList } from "@/domains/workshop-stock/client";
import { errorCopy, matchesSearch, verificationHint, whenLabel } from "@/domains/workshop-stock/format";
import { groupByShelf } from "@/domains/workshop-stock/location";
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
  zero: "Nothing recorded on the shelf — what's logged, not a check of the shelf.",
  estimated: "The recorded quantity is a rough count (a part-used roll). A count clears it.",
  check: "The maker's code hasn't been confirmed online. Open one to check it or correct the details.",
  archived: "Off the crew's list; codes no longer match photos. Open one to read its history or restore it.",
};

export const CODE_TONE: Record<VerificationStatus, "success" | "warning" | "neutral"> = { manufacturer_code_matched: "success", possible_match: "warning", unverified: "neutral" };

/**
 * /stock — the office view of Workshop Stock, read the way the workshop is
 * laid out: one card per shelf, the rows inside it the same rows the crew see
 * (photo, name, identity, the recorded quantity as the largest thing), with
 * the office's two facts under the identity line — when it last moved and was
 * last counted. Only a POSSIBLE code match earns a hint on a row; a confirmed
 * code is nothing to flag and an unchecked one is the normal state. Click a
 * row for the count correction, the history with its audited Undo, the
 * catalogue, and archive. No KPI row, no gauges.
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

  // The archived count is only known once that list has been read (the list
  // endpoint returns live items unless asked); every other count is live.
  const segOptions = FILTERS.map((f) => {
    const known = !failed && list && (f.value === "archived" ? archivedView : true);
    return { value: f.value, label: f.label, ...(known ? { count: counts[f.value] } : {}) };
  });

  const meta = (i: StockItem) =>
    archivedView
      ? `Archived ${whenLabel(i.archivedAt)}`
      : `Moved ${i.lastMovementAt ? whenLabel(i.lastMovementAt) : "never"} · counted ${i.lastCountedAt ? `${whenLabel(i.lastCountedAt)}${i.lastCountedByName ? ` by ${i.lastCountedByName}` : ""}` : "never"}`;

  return (
    <div className="space-y-4" data-testid="stock-admin">
      <div className="flex flex-wrap items-center gap-3">
        <Seg options={segOptions} value={filter} onChange={setFilter} aria-label="Filter workshop stock" />
        <span className="flex-1" />
        <div className="relative w-full sm:w-[280px]">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, code, barcode or shelf"
            aria-label="Search workshop stock"
            className="h-9 w-full rounded-card border border-border-strong bg-surface pl-8 pr-3 text-sm [&::-webkit-search-cancel-button]:appearance-none"
            data-testid="stock-admin-search"
          />
        </div>
        <Button type="button" size="sm" onClick={() => setAdding(true)} disabled={!list} data-testid="stock-admin-add">
          <Plus aria-hidden="true" className="h-4 w-4" /> Add item
        </Button>
      </div>
      {EXPLAIN[filter] && !failed ? <p className="text-sm text-text-muted">{EXPLAIN[filter]}</p> : null}

      {state === "loading" && !list ? (
        <div className="grid gap-4 lg:grid-cols-2" aria-busy="true" role="status" aria-label="Loading workshop stock">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-40 animate-pulse rounded-card bg-surface-subtle" />)}
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
          <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">The crew add stock from the phone by photographing each item. You can also add one here by hand.</p>
          <Button type="button" size="sm" className="mt-4" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" className="h-4 w-4" /> Add item
          </Button>
        </div>
      ) : !shown.length ? (
        <p className="rounded-card border border-dashed border-border bg-surface-subtle p-6 text-center text-sm text-text-muted">
          {q.trim() ? `Nothing matches "${q.trim()}".` : archivedView ? "Nothing has been archived." : "Nothing in this view."}
        </p>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2" data-testid="stock-admin-table">
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label} className="overflow-hidden rounded-card border border-border bg-surface-raised shadow-card" data-testid="stock-admin-group">
              <div className="flex items-baseline justify-between gap-3 border-b border-border bg-surface-subtle px-4 py-2.5">
                <h2 className="font-display text-base font-semibold text-text">{g.label}</h2>
                <span className="text-xs text-text-muted">{g.items.length} {g.items.length === 1 ? "item" : "items"}</span>
              </div>
              <ul>
                {g.items.map((i) => (
                  <li key={i.id} data-testid="stock-admin-row" className="[&>button]:border-b-0 [&>button]:border-t [&>button]:border-border first:[&>button]:border-t-0">
                    <StockItemRow item={i} inGroup onClick={() => setOpenId(i.id)} meta={meta(i)} hint={archivedView ? null : verificationHint(i)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {openId && list ? <StockItemDrawer itemId={openId} lookupEnabled={list.capabilities.lookup} locationPhotoEnabled={list.capabilities.locationPhoto === true} onClose={() => setOpenId(null)} onChanged={() => void load(filter === "archived")} /> : null}
      {adding && list ? <StockAdminAdd items={items} capabilities={list.capabilities} onSaved={() => void load(filter === "archived")} onOpenItem={(id) => { setAdding(false); setOpenId(id); }} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
