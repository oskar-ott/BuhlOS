"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PackageMinus, PackagePlus, Search, Undo2, X } from "lucide-react";
import { PhilNotice } from "./ui/PhilNotice";
import { PhilPageIntro } from "./ui/PhilPageIntro";
import { PhilSkeleton } from "./ui/PhilSkeleton";
import { useSheetHistory } from "./useSheetHistory";
import { EmptyState } from "@/components/ui/EmptyState";
import { AddFlow } from "@/components/stock/AddFlow";
import { StockItemRow } from "@/components/stock/StockItemRow";
import { StockItemSheet } from "@/components/stock/StockItemSheet";
import { TakeFlow } from "@/components/stock/TakeFlow";
import { createItem, fetchOperation, fetchStockList, newOperationKey, recordMove, undoMovement, type CreateInput, type MoveInput } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, matchesSearch, movementSummary } from "@/domains/workshop-stock/format";
import { clearPending, readPending, setPendingOwner, type PendingSave } from "@/domains/workshop-stock/pending";
import type { ReadProduct, StockItem, StockList, WriteResult } from "@/domains/workshop-stock/schema";

type Flow =
  | { kind: "take" }
  | { kind: "return" }
  | { kind: "add"; seed?: { dataUrl: string | null; product: ReadProduct | null } | null }
  | { kind: "item"; item: StockItem };

type Reconcile =
  | { p: PendingSave; status: "checking" | "not_saved" | "unknown" | "retrying" }
  | { p: PendingSave; status: "saved"; result: WriteResult };

/**
 * /phil/stock — Workshop Stock on the phone. "What do we have, and where is it?"
 *
 * Level one is ONE decision (P10): take something, or add something — two big
 * buttons over a searchable list of what's recorded and where it lives. Return
 * and per-item actions sit one tap down. Recorded stock is labelled as recorded
 * (P7): the shelf is the truth, the list is the log of it.
 */
export function PhilWorkshopStock() {
  const [list, setList] = useState<StockList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState<Flow | null>(null);
  const [last, setLast] = useState<WriteResult | null>(null);
  const [lastUndo, setLastUndo] = useState<"idle" | "undoing" | "undone">("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [reconcile, setReconcile] = useState<Reconcile | null>(null);

  const checkPending = useCallback(async (viewerId: string) => {
    const p = readPending(viewerId);
    if (!p) return;
    setReconcile({ p, status: "checking" });
    const r = await fetchOperation(p.key);
    if (!r.ok) { setReconcile({ p, status: "unknown" }); return; }
    if (r.data.found && r.data.movement && r.data.item) {
      clearPending();
      setReconcile({ p, status: "saved", result: { item: r.data.item, movement: r.data.movement, replayed: true } });
      return;
    }
    setReconcile({ p, status: "not_saved" });
  }, []);

  // A save left pending on this phone is checked after the first successful
  // load — once we know who's looking (it is only ever theirs).
  const reconciled = useRef(false);
  const load = useCallback(async () => {
    const r = await fetchStockList();
    setLoading(false);
    if (r.ok) {
      setList(r.data);
      setLoadError(null);
      setPendingOwner(r.data.viewer.id);
      if (!reconciled.current) {
        reconciled.current = true;
        void checkPending(r.data.viewer.id);
      }
      return;
    }
    setLoadError(r.error.status === 401 ? "You've been signed out. Sign in again to see the workshop stock." : errorCopy(r.error.status, r.error.body, "Couldn't load workshop stock."));
  }, [checkPending]);

  useEffect(() => { void load(); }, [load]);

  const items = useMemo(() => list?.items ?? [], [list]);
  const shown = useMemo(() => items.filter((i) => matchesSearch(i, query)), [items, query]);

  function saved(r: WriteResult) {
    setLast(r);
    setLastUndo(r.movement.kind === "reversal" ? "undone" : "idle");
    setLastError(null);
    void load();
  }

  async function undoLast() {
    if (!last) return;
    setLastUndo("undoing");
    const r = await undoMovement({ movementId: last.movement.id }, newOperationKey());
    if (r.ok) { setLastUndo("undone"); setLast(r.data); void load(); return; }
    setLastUndo("idle");
    setLastError(errorCopy(r.error.status, r.error.body));
  }

  async function retryPending(p: PendingSave) {
    setReconcile({ p, status: "retrying" });
    const r = p.kind === "create" ? await createItem(p.request as unknown as CreateInput, p.key) : await recordMove(p.request as unknown as MoveInput, p.key);
    if (r.ok) { clearPending(); setReconcile(null); saved(r.data); return; }
    if (r.error.status === 0 || r.error.status >= 500) { setReconcile({ p, status: "unknown" }); return; }
    clearPending();
    setReconcile(null);
    setLastError(errorCopy(r.error.status, r.error.body));
  }

  const flowOpen = flow !== null;
  // ONE back-gesture guard for whichever stock sheet is open (P8): the phone's
  // back closes the sheet instead of leaving the page, and a hand-over between
  // sheets (take → "add it as new", item → take) keeps the same marker.
  const { closeWithHistory } = useSheetHistory({ open: flowOpen, onClose: () => setFlow(null) });
  return (
    <div className="space-y-4 pb-6" data-testid="phil-workshop-stock">
      <PhilPageIntro title="Workshop stock" description="What we have in the workshop, and where it is." meta={list ? <span className="text-xs text-text-muted">{items.length} {items.length === 1 ? "item" : "items"}</span> : null} />

      {reconcile ? <ReconcileNotice r={reconcile} onRetry={retryPending} onDismiss={() => { clearPending(); setReconcile(null); }} /> : null}

      {last && !flowOpen ? (
        <div className="space-y-2" data-testid="stock-last-write">
          <PhilNotice tone="success" title={lastUndo === "undone" ? "Undone" : movementSummary(last.movement, last.item.baseUnit)}>
            {last.item.name} — {balanceLabel(last.item)} recorded now.
          </PhilNotice>
          {lastUndo !== "undone" && last.movement.kind !== "reversal" && last.movement.undo?.allowed ? (
            <button type="button" onClick={() => void undoLast()} disabled={lastUndo === "undoing"} className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-card border-2 border-brand-navy font-semibold text-brand-navy" data-testid="stock-last-undo">
              <Undo2 aria-hidden="true" className="h-4 w-4" /> {lastUndo === "undoing" ? "Undoing…" : "Undo"}
            </button>
          ) : null}
          {lastError ? <PhilNotice tone="danger" role="alert">{lastError}</PhilNotice> : null}
        </div>
      ) : lastError && !flowOpen ? (
        <PhilNotice tone="danger" role="alert">{lastError}</PhilNotice>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={() => setFlow({ kind: "take" })} disabled={!list} className="flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-card bg-accent-yellow px-3 font-display text-lg font-semibold text-brand-navy shadow-card active:scale-[0.99] disabled:opacity-60" data-testid="stock-take-button">
          <PackageMinus aria-hidden="true" className="h-6 w-6" /> Take stock
        </button>
        <button type="button" onClick={() => setFlow({ kind: "add" })} disabled={!list} className="flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-card border-2 border-brand-navy bg-surface px-3 font-display text-lg font-semibold text-brand-navy active:scale-[0.99] disabled:opacity-60" data-testid="stock-add-button">
          <PackagePlus aria-hidden="true" className="h-6 w-6" /> Add stock
        </button>
      </div>
      <button type="button" onClick={() => setFlow({ kind: "return" })} disabled={!list || !items.length} className="min-h-[48px] w-full text-center text-sm font-semibold text-brand-navy underline-offset-2 hover:underline disabled:opacity-50" data-testid="stock-return-button">
        Bringing unused stock back? Return it
      </button>

      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted" />
        <input type="search" enterKeyHint="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, code or shelf" aria-label="Search workshop stock" className="h-12 w-full rounded-card border border-border-strong bg-surface pl-10 pr-12 text-base text-text" data-testid="stock-search" />
        {query ? (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-1 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center text-text-muted">
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="space-y-2" role="status" aria-label="Loading workshop stock">
          {[0, 1, 2, 3].map((i) => <PhilSkeleton key={i} className="h-[76px] w-full rounded-card" />)}
        </div>
      ) : loadError ? (
        <PhilNotice tone="danger" role="alert" title="Couldn't load workshop stock">
          {loadError}{" "}
          <button type="button" onClick={() => { setLoading(true); void load(); }} className="min-h-[44px] font-semibold text-brand-navy underline">Try again</button>
        </PhilNotice>
      ) : !items.length ? (
        <EmptyState title="Nothing recorded yet" description="Tap Add stock and photograph the first item — then confirm how many are on the shelf and where." />
      ) : shown.length ? (
        <ul className="space-y-2" data-testid="stock-list">
          {shown.map((i) => (
            <li key={i.id}>
              <StockItemRow item={i} onClick={() => setFlow({ kind: "item", item: i })} />
            </li>
          ))}
        </ul>
      ) : (
        <PhilNotice tone="neutral">
          Nothing matches &ldquo;{query}&rdquo;.{" "}
          <button type="button" onClick={() => setQuery("")} className="min-h-[44px] font-semibold text-brand-navy underline">Clear search</button>
        </PhilNotice>
      )}

      {flow?.kind === "take" || flow?.kind === "return" ? (
        <TakeFlow
          items={items}
          kind={flow.kind}
          photoReading={Boolean(list?.capabilities.photoRead)}
          onSaved={saved}
          onAddNew={(seed) => setFlow({ kind: "add", seed })}
          onClose={closeWithHistory}
        />
      ) : null}
      {flow?.kind === "add" && list ? <AddFlow items={items} capabilities={list.capabilities} seed={flow.seed ?? null} onSaved={saved} onClose={closeWithHistory} /> : null}
      {flow?.kind === "item" ? <StockItemSheet item={flow.item} onChanged={(r) => { if (r) saved(r); else void load(); }} onClose={closeWithHistory} /> : null}
    </div>
  );
}

function ReconcileNotice({ r, onRetry, onDismiss }: { r: Reconcile; onRetry: (p: PendingSave) => void; onDismiss: () => void }) {
  const what = `${r.p.kind === "create" ? "new item" : r.p.kind} of ${r.p.quantityLabel} ${r.p.kind === "create" ? `(${r.p.itemName})` : `· ${r.p.itemName}`}`;
  if (r.status === "checking" || r.status === "retrying") {
    return <PhilNotice tone="info" title="Checking your last save…">Your {what}.</PhilNotice>;
  }
  if (r.status === "saved") {
    return (
      <div data-testid="stock-reconcile-saved">
        <PhilNotice tone="success" title="Your last save went through">
          {movementSummary(r.result.movement, r.result.item.baseUnit)} · {r.result.item.name} — {balanceLabel(r.result.item)} recorded now.
        </PhilNotice>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="stock-reconcile-pending" data-status={r.status}>
      <PhilNotice tone="warning" title={r.status === "not_saved" ? "Your last save didn't go through" : "Can't confirm your last save yet"}>
        Your {what}. {r.status === "not_saved" ? "Save it now, or discard it." : "No signal — try again; it won't double up."}
      </PhilNotice>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onRetry(r.p)} className="min-h-[48px] rounded-card bg-accent-yellow px-3 font-semibold text-brand-navy" data-testid="stock-reconcile-retry">{r.status === "not_saved" ? "Save it now" : "Try again"}</button>
        <button type="button" onClick={onDismiss} className="min-h-[48px] rounded-card border border-border-strong px-3 font-semibold text-text" data-testid="stock-reconcile-dismiss">Discard</button>
      </div>
    </div>
  );
}
