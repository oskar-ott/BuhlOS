"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Seg } from "@/components/ui/Seg";
import { AddFlow } from "@/components/stock/AddFlow";
import { StockItemRow } from "@/components/stock/StockItemRow";
import { StockThumb } from "@/components/stock/StockThumb";
import { fetchStockList } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, identityLine, matchesSearch, timeAgo, VERIFICATION_LABEL } from "@/domains/workshop-stock/format";
import { setPendingOwner } from "@/domains/workshop-stock/pending";
import type { StockItem, StockList } from "@/domains/workshop-stock/schema";
import { StockItemDrawer } from "./StockItemDrawer";

type Filter = "all" | "zero" | "estimated" | "check" | "archived";

const CHECK_SHORT = { manufacturer_code_matched: "Code matched", possible_match: "Possible match", unverified: "Not verified" } as const;

/**
 * /stock — the office view of Workshop Stock: every item, its recorded balance,
 * where it lives, when it last moved and was last counted, and how well its
 * product code is confirmed. Click a row for counts, catalogue edits, codes,
 * history and archive.
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
    else { setState("error"); setError(errorCopy(r.error.status, r.error.body, "Couldn't load workshop stock.")); }
  }, []);
  useEffect(() => { void load(filter === "archived"); }, [load, filter]);

  const items = useMemo(() => list?.items ?? [], [list]);
  const counts = useMemo(() => ({
    all: items.filter((i) => !i.archivedAt).length,
    zero: items.filter((i) => !i.archivedAt && i.balanceMilli === 0).length,
    estimated: items.filter((i) => !i.archivedAt && i.estimated).length,
    check: items.filter((i) => !i.archivedAt && i.verificationStatus !== "manufacturer_code_matched").length,
  }), [items]);
  const shown = useMemo(() => items.filter((i) => {
    if (filter === "archived") return Boolean(i.archivedAt);
    if (i.archivedAt) return false;
    if (filter === "zero") return i.balanceMilli === 0;
    if (filter === "estimated") return i.estimated;
    if (filter === "check") return i.verificationStatus !== "manufacturer_code_matched";
    return true;
  }).filter((i) => matchesSearch(i, q)), [items, filter, q]);

  return (
    <div className="space-y-4" data-testid="stock-admin">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Seg<Filter>
            aria-label="Filter workshop stock"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: counts.all },
              { value: "zero", label: "None recorded", count: counts.zero },
              { value: "estimated", label: "Estimates", count: counts.estimated },
              { value: "check", label: "Code not confirmed", count: counts.check },
              { value: "archived", label: "Archived" },
            ]}
          />
          <div className="flex w-full gap-2 sm:w-auto">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, shelf" aria-label="Search workshop stock" className="h-9 min-w-0 flex-1 rounded-[4px] border border-border bg-surface px-3 text-sm sm:w-72" data-testid="stock-admin-search" />
            <Button type="button" size="sm" onClick={() => setAdding(true)} disabled={!list} data-testid="stock-admin-add">Add item</Button>
          </div>
        </div>
      </Card>

      {state === "loading" && !list ? (
        <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-card bg-surface-subtle" />)}</div>
      ) : state === "error" ? (
        <Card>
          <p role="alert" className="text-sm text-state-danger">{error}</p>
          <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void load(filter === "archived")}>Try again</Button>
        </Card>
      ) : !shown.length ? (
        <Card><p className="text-sm text-text-muted">{items.length ? "Nothing matches." : "No workshop stock recorded yet. Add the first item, or let the crew add it from their phones."}</p></Card>
      ) : (
        <>
          <ul className="space-y-2 sm:hidden">
            {shown.map((i) => <li key={i.id}><StockItemRow item={i} onClick={() => setOpenId(i.id)} /></li>)}
          </ul>
          <div className="hidden overflow-x-auto rounded-card border border-border bg-surface sm:block">
            <table className="w-full text-left text-sm" data-testid="stock-admin-table">
              <thead className="bg-surface-subtle text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Location</th>
                  <th className="px-3 py-2">Recorded</th>
                  <th className="px-3 py-2">Last movement</th>
                  <th className="px-3 py-2">Last counted</th>
                  <th className="px-3 py-2">Product code</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i: StockItem) => (
                  <tr key={i.id} className="cursor-pointer border-t border-border hover:bg-surface-subtle" onClick={() => setOpenId(i.id)} data-testid="stock-admin-row">
                    <td className="px-3 py-2">
                      <button type="button" className="flex items-center gap-2 text-left" onClick={(e) => { e.stopPropagation(); setOpenId(i.id); }}>
                        <StockThumb photoId={i.photoId} alt="" size="sm" />
                        <span>
                          <span className="block font-semibold text-text">{i.name}</span>
                          <span className="block text-xs text-text-muted">{identityLine(i)}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-2 text-text">{i.location || <span className="text-text-muted">—</span>}</td>
                    <td className={`px-3 py-2 font-semibold ${i.balanceMilli === 0 ? "text-state-warning" : "text-text"}`}>{balanceLabel(i)}</td>
                    <td className="px-3 py-2 text-text-muted">{timeAgo(i.lastMovementAt)}</td>
                    <td className="px-3 py-2 text-text-muted">{i.lastCountedAt ? timeAgo(i.lastCountedAt) : "never"}</td>
                    <td className="px-3 py-2 text-text-muted" title={VERIFICATION_LABEL[i.verificationStatus]}>{CHECK_SHORT[i.verificationStatus]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {openId && list ? <StockItemDrawer itemId={openId} lookupEnabled={list.capabilities.lookup} onClose={() => setOpenId(null)} onChanged={() => void load(filter === "archived")} /> : null}
      {adding && list ? <AddFlow items={items} capabilities={list.capabilities} onSaved={() => void load(filter === "archived")} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
