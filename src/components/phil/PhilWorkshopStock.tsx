"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Camera, ChevronRight, ClipboardList, Loader2, RefreshCw, Search, X } from "lucide-react";
import { PhilSkeleton } from "./ui/PhilSkeleton";
import { useSheetHistory } from "./useSheetHistory";
import { AddFlow } from "@/components/stock/AddFlow";
import { BrowseSheet, type BrowseMode } from "@/components/stock/BrowseSheet";
import { ListsFlow } from "@/components/stock/ListsFlow";
import { StockItemRow } from "@/components/stock/StockItemRow";
import { StockItemSheet } from "@/components/stock/StockItemSheet";
import { StockReceipt } from "@/components/stock/StockReceipt";
import { TakeFlow } from "@/components/stock/TakeFlow";
import { BigButton, Kicker, MiniButton, Slot } from "@/components/stock/ui";
import { createItem, fetchLists, fetchOperation, fetchStockList, recordMove, type CreateInput, type MoveInput } from "@/domains/workshop-stock/client";
import { errorCopy, matchesSearch, movementSummary, recordedNow } from "@/domains/workshop-stock/format";
import { listSummary, viewList } from "@/domains/workshop-stock/lists";
import { groupByShelf } from "@/domains/workshop-stock/location";
import { clearPending, definitelyNotSaved, isUncertain, readPending, setPendingOwner, type PendingSave } from "@/domains/workshop-stock/pending";
import type { ReadProduct, ShoppingList, StockItem, StockList, WriteResult } from "@/domains/workshop-stock/schema";
import { typeTiles, type FacetChoice } from "@/domains/workshop-stock/types";
import { findByBarcode } from "@/domains/workshop-stock/barcode";
import { useBarcodeScanner } from "@/components/stock/useBarcodeScanner";

type Flow =
  | { kind: "take" }
  | { kind: "add"; seed?: { dataUrl: string | null; thumbDataUrl?: string | null; product: ReadProduct | null; scannedBarcode?: string | null } | null }
  | { kind: "item"; item: StockItem; from?: Extract<Flow, { kind: "browse" }> | null }
  | { kind: "browse"; mode: BrowseMode; choice: FacetChoice }
  | { kind: "lists"; listId?: string | null };

type Reconcile =
  | { p: PendingSave; status: "checking" | "not_saved" | "unknown" | "retrying" }
  | { p: PendingSave; status: "saved"; result: WriteResult };

const RECENT_MS = 3 * 60_000;

/**
 * /phil/stock — Workshop Stock on the phone. "What do we have, and where is it?"
 *
 * Level one is ONE decision (P10): take something out, or put something in —
 * two doors pinned at the bottom over the list, read by shelf, with the
 * recorded quantity the largest thing on every row. Return lives behind "Add or
 * return"; per-item actions sit one tap down. Recorded stock is labelled as
 * recorded (P7): the shelf is the truth, the list is the log of it.
 *
 * What is read is a VIEW (owner pull 2026-11-01: "someone opens stock when they
 * already know what they need — not to scroll a list"): once items have types,
 * level one shows the search and one tile per type ("Switches & GPOs · 14");
 * a tile opens that type with its fields as filter chips (Range · Gang ·
 * Colour). The tiles replace the long shelf list in the same reading slot —
 * the shelf list is one tap down ("Everything, by shelf"), and is still level
 * one until anything has a type. Shopping lists enter as one row under the
 * title (resume your latest list in one tap, P8/P14) and from an item.
 *
 * One slot at the top carries the receipt of the last save (with its Undo) or
 * the saves still waiting for an answer — several collapse into one card so the
 * doors never move. Saves whose answer never arrived are checked with the
 * server — every one of them, when the screen opens, when a sheet closes, and
 * when the phone comes back to the app (the list is re-read then too, so
 * balances aren't hours old).
 */
export function PhilWorkshopStock() {
  const [list, setList] = useState<StockList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState<Flow | null>(null);
  const [last, setLast] = useState<WriteResult | null>(null);
  const [lastUndone, setLastUndone] = useState<WriteResult | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [reconciles, setReconciles] = useState<Reconcile[]>([]);
  const [myList, setMyList] = useState<ShoppingList | null>(null);
  const viewerRef = useRef<string | null>(null);
  const checkingRef = useRef(false);
  const recheckRef = useRef(false);
  const flowOpenRef = useRef(false);

  // Ask the server about every save on this phone that never got its answer
  // (they are only ever this viewer's). A save the server hasn't seen is only
  // called "didn't go through" once it's old enough that it can't still land.
  const checkPending = useCallback(async (): Promise<void> => {
    const viewerId = viewerRef.current;
    if (!viewerId) return;
    if (checkingRef.current) {
      // one is running: look again when it's done (a sheet may just have left a new one)
      recheckRef.current = true;
      return;
    }
    const pending = readPending(viewerId);
    if (!pending.length) {
      setReconciles((rs) => rs.filter((r) => r.status === "saved"));
      return;
    }
    checkingRef.current = true;
    const keys = new Set(pending.map((p) => p.key));
    setReconciles((rs) => [...rs.filter((r) => r.status === "saved" && !keys.has(r.p.key)), ...pending.map((p) => ({ p, status: "checking" as const }))]);
    const results = await Promise.all(pending.map(async (p): Promise<Reconcile> => {
      const r = await fetchOperation(p.key);
      if (!r.ok) return { p, status: "unknown" };
      if (r.data.found && r.data.movement && r.data.item) {
        clearPending(p.key);
        return { p, status: "saved", result: { item: r.data.item, movement: r.data.movement, replayed: true } };
      }
      return { p, status: definitelyNotSaved(p) ? "not_saved" : "unknown" };
    }));
    checkingRef.current = false;
    setReconciles((rs) => [...rs.filter((r) => r.status === "saved" && !keys.has(r.p.key)), ...results]);
    if (recheckRef.current) {
      recheckRef.current = false;
      await checkPending();
    }
  }, []);

  // The latest open list of mine, for the one-tap "resume" row (only once lists exist).
  const loadMyList = useCallback(async (viewerId: string) => {
    const r = await fetchLists();
    if (!r.ok) return;
    setMyList(r.data.lists.find((l) => !l.doneAt && l.ownerId === viewerId) ?? null);
  }, []);

  const load = useCallback(async () => {
    const r = await fetchStockList();
    setLoading(false);
    if (r.ok) {
      setList(r.data);
      if (r.data.capabilities.lists) void loadMyList(r.data.viewer.id);
      setLoadError(null);
      setPendingOwner(r.data.viewer.id);
      const first = viewerRef.current === null;
      viewerRef.current = r.data.viewer.id;
      if (first) void checkPending();
      return;
    }
    setLoadError(r.error.status === 401 ? "You've been signed out. Sign in again to see the workshop stock." : errorCopy(r.error.status, r.error.body, "The list didn't arrive — no signal, or the office server didn't answer."));
  }, [checkPending, loadMyList]);

  useEffect(() => { void load(); }, [load]);

  // Back in the app after a while (the phone slept, another app was open):
  // re-read the list, and check any save still waiting for its answer.
  useEffect(() => {
    let lastRefresh = Date.now();
    function onReturn() {
      if (document.visibilityState !== "visible" || Date.now() - lastRefresh < 15_000) return;
      lastRefresh = Date.now();
      void load();
      if (!flowOpenRef.current) void checkPending();
    }
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [load, checkPending]);

  const items = useMemo(() => list?.items ?? [], [list]);
  const shown = useMemo(() => items.filter((i) => matchesSearch(i, query)), [items, query]);
  const groups = useMemo(() => groupByShelf(shown), [shown]);
  // Browse by type once anything has one; until then the shelf list stays level one.
  const tiles = useMemo(() => (list?.capabilities.types && items.some((i) => i.category) ? typeTiles(items) : null), [list, items]);

  function saved(r: WriteResult) {
    if (r.movement.kind === "reversal") {
      setLastUndone(r);
    } else {
      setLast(r);
      setLastUndone(null);
    }
    setLastError(null);
    // a new receipt replaces the "went through" cards already seen
    setReconciles((rs) => rs.filter((x) => x.status !== "saved"));
    void load();
  }

  async function retryPending(p: PendingSave) {
    setReconciles((rs) => rs.map((r) => (r.p.key === p.key ? { p, status: "retrying" } : r)));
    const r = p.kind === "create" ? await createItem(p.request as unknown as CreateInput, p.key) : await recordMove(p.request as unknown as MoveInput, p.key);
    if (r.ok) {
      clearPending(p.key);
      setReconciles((rs) => rs.filter((x) => x.p.key !== p.key));
      saved(r.data);
      return;
    }
    if (isUncertain(r.error.status, r.error.body)) {
      setReconciles((rs) => rs.map((x) => (x.p.key === p.key ? { p, status: "unknown" } : x)));
      return;
    }
    clearPending(p.key);
    setReconciles((rs) => rs.filter((x) => x.p.key !== p.key));
    setLastError(errorCopy(r.error.status, r.error.body));
  }

  function dismiss(p: PendingSave) {
    clearPending(p.key);
    setReconciles((rs) => rs.filter((x) => x.p.key !== p.key));
  }

  const flowOpen = flow !== null;
  flowOpenRef.current = flowOpen;
  // A barcode scanner on the list (2026-11-03): one match opens that item (Take
  // / Return / Add from there); several narrow the list; an unknown code starts
  // a new item with the barcode kept. Inside a sheet, the sheet listens itself.
  useBarcodeScanner((code) => {
    const hits = findByBarcode(items, code);
    if (hits.length === 1) setFlow({ kind: "item", item: hits[0]!.item });
    else if (hits.length > 1) setQuery(code);
    else setFlow({ kind: "add", seed: { dataUrl: null, product: null, scannedBarcode: code } });
  }, !flowOpen && Boolean(list));
  // A sheet just closed: anything it left unanswered shows here now.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !flowOpen) void checkPending();
    wasOpen.current = flowOpen;
  }, [flowOpen, checkPending]);
  // ONE back-gesture guard for whichever stock sheet is open (P8): the phone's
  // back closes the sheet instead of leaving the page, and a hand-over between
  // sheets (take → "add it as new", item → take) keeps the same marker.
  const { closeWithHistory } = useSheetHistory({ open: flowOpen, onClose: () => setFlow(null) });
  const caps = list?.capabilities;
  const openList = (listId?: string | null) => setFlow({ kind: "lists", listId: listId ?? null });

  const count = list ? `${items.length} ${items.length === 1 ? "item" : "items"}.` : null;
  const recentId = last && Date.now() - Date.parse(last.movement.createdAt ?? "") < RECENT_MS ? last.item.id : null;
  const viewerId = list?.viewer.id ?? null;
  const empty = Boolean(list) && !items.length;
  const doorsReady = Boolean(list) && !loadError;

  return (
    <div className="-mx-4 -mb-4 flex min-h-full flex-col" data-testid="phil-workshop-stock">
      <div className="px-4 pb-2.5 pt-1">
        <h1 className="font-display text-[26px] font-bold leading-tight tracking-tight text-brand-navy">Workshop stock</h1>
        <p className="mt-1 text-[15px] text-text-muted">What we have in the workshop, and where it is.{count ? ` ${count}` : ""}</p>
        {caps?.lists && !loadError ? (
          <button type="button" onClick={() => openList(myList?.id)} className="mt-2.5 flex min-h-[52px] w-full items-center gap-3 rounded-xl border border-border bg-surface-subtle px-3 text-left hover:border-brand-navy" data-testid="stock-lists-entry">
            <ClipboardList aria-hidden="true" className="h-5 w-5 shrink-0 text-brand-navy" />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold text-brand-navy">{myList ? `Your list: ${myList.name}` : "Shopping lists"}</span>
              <span className="block truncate text-[13px] text-text-muted">{myList ? listSummary(viewList(myList, items)) : "what you need — from the workshop or the wholesaler"}</span>
            </span>
            <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-brand-navy" />
          </button>
        ) : null}
      </div>

      {/* the one slot at the top: waiting saves, else the last receipt */}
      {!flowOpen ? (
        <div className="space-y-2 px-4 pb-2.5 empty:hidden">
          {reconciles.length ? (
            <ReconcileSlot list={reconciles} onRetry={retryPending} onDismiss={dismiss} onUndone={saved} />
          ) : last ? (
            <div data-testid="stock-last-write">
              <StockReceipt
                result={last}
                undone={lastUndone}
                onUndone={saved}
                undoTestId="stock-last-undo"
                note={last.photoAttached === false ? <span data-testid="stock-last-photo-missing">The photo couldn&rsquo;t be attached — the office can add one later.</span> : last.locationPhotoAttached === false ? <span data-testid="stock-last-photo-missing">The photo of where it lives couldn&rsquo;t be attached — add it from the item.</span> : null}
              />
            </div>
          ) : null}
          {lastError ? <Slot tone="bad" role="alert">{lastError}</Slot> : null}
        </div>
      ) : null}

      {loadError ? (
        <div className="px-4">
          <Slot tone="warn" role="alert" title="Couldn't load workshop stock" below={<MiniButton onClick={() => { setLoading(true); setLoadError(null); void load(); }}><RefreshCw aria-hidden="true" className="h-4 w-4" /> Try again</MiniButton>}>
            {loadError} No quantities are shown until it loads.
          </Slot>
        </div>
      ) : empty ? (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-9 py-10 text-center">
            <div className="flex h-[72px] w-[72px] items-center justify-center rounded-[20px] border border-border bg-surface-subtle text-brand-navy">
              <Camera aria-hidden="true" className="h-8 w-8" strokeWidth={1.8} />
            </div>
            <p className="font-display text-[22px] font-bold leading-tight text-brand-navy">Nothing recorded yet</p>
            <p className="text-base text-text">Tap Add stock and photograph the first item. The list fills up one photo at a time.</p>
          </div>
          <div className="mx-4 mb-3 rounded-xl border border-border bg-surface-subtle px-3.5 py-3 text-sm leading-snug text-text">
            <strong>Setting up a shelf?</strong> Work one shelf at a time. The shelf you type is filled in for the next item, and Save and add another goes straight back to the camera.
          </div>
        </>
      ) : (
        <>
          <div className="relative px-4 pb-2.5">
            <Search aria-hidden="true" className="pointer-events-none absolute left-7 top-1/2 h-5 w-5 -translate-y-[calc(50%+5px)] text-text-muted" />
            <input
              type="search"
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, code or shelf"
              aria-label="Search workshop stock"
              disabled={loading && !list}
              className="h-12 w-full rounded-xl border border-border-strong bg-surface pl-11 pr-16 text-base text-text focus:border-brand-navy focus:outline-none focus:ring-[3px] focus:ring-accent-yellow/60 disabled:bg-surface-subtle"
              data-testid="stock-search"
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-5 top-1/2 inline-flex h-11 -translate-y-[calc(50%+5px)] items-center gap-1 px-2 text-[15px] font-semibold text-state-info">
                Clear <X aria-hidden="true" className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          {loading && !list ? (
            <div role="status" aria-label="Loading workshop stock" aria-busy="true" className="flex-1">
              {[0, 1].map((g) => (
                <div key={g}>
                  <div className="border-y border-border bg-surface-subtle px-4 py-2.5">
                    <PhilSkeleton className="h-3.5 w-24" />
                  </div>
                  {[0, 1].map((r) => (
                    <div key={r} className="flex min-h-[68px] items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
                      <PhilSkeleton className="h-12 w-12 rounded-[10px]" />
                      <div className="flex-1 space-y-2">
                        <PhilSkeleton className="h-4 w-2/3" />
                        <PhilSkeleton className="h-3 w-1/2" />
                      </div>
                      <PhilSkeleton className="h-6 w-14" />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : tiles && !query.trim() ? (
            <div className="flex-1 px-4 pb-3" data-testid="stock-type-tiles">
              <Kicker className="pb-2 pt-1">What are you after?</Kicker>
              <div className="grid grid-cols-2 gap-2">
                {tiles.map((t) => (
                  <button
                    key={t.key ?? "unsorted"}
                    type="button"
                    onClick={() => setFlow({ kind: "browse", mode: t.key ? { kind: "type", key: t.key } : { kind: "unsorted" }, choice: {} })}
                    className={t.key ? "flex min-h-[84px] flex-col justify-between rounded-[14px] border border-border-strong bg-surface p-3 text-left hover:border-brand-navy" : "flex min-h-[84px] flex-col justify-between rounded-[14px] border border-dashed border-border-strong bg-surface-subtle p-3 text-left hover:border-brand-navy"}
                    data-testid="stock-type-tile"
                    data-type={t.key ?? "unsorted"}
                  >
                    <span className="font-display text-[17px] font-bold leading-tight text-brand-navy">{t.label}</span>
                    <span className="mt-1 block text-[13px] text-text-muted">
                      <span className="font-semibold text-text">{t.count} {t.count === 1 ? "item" : "items"}</span>
                      {t.sample.length ? <span className="block truncate">{t.sample.join(" · ")}</span> : null}
                    </span>
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setFlow({ kind: "browse", mode: { kind: "shelf" }, choice: {} })} className="mt-2 flex min-h-[48px] w-full items-center justify-between rounded-[14px] border border-border px-3 text-left text-[15px] font-semibold text-brand-navy hover:border-brand-navy" data-testid="stock-by-shelf">
                Everything, by shelf
                <ChevronRight aria-hidden="true" className="h-5 w-5" />
              </button>
            </div>
          ) : shown.length ? (
            <div className="flex-1" data-testid="stock-list">
              {groups.map((g) => (
                <section key={g.label} aria-label={g.label}>
                  <div className="flex items-baseline justify-between border-y border-border bg-surface-subtle px-4 pb-1.5 pt-3" data-testid="stock-shelf">
                    <Kicker className="text-[13px] text-brand-navy">{g.label}</Kicker>
                    <span className="text-[13px] font-medium text-text-muted">{g.items.length} {g.items.length === 1 ? "item" : "items"}</span>
                  </div>
                  <ul>
                    {g.items.map((i) => (
                      <li key={i.id}>
                        <StockItemRow item={i} inGroup marker={i.id === recentId ? "just now" : null} highlight={i.id === recentId} onClick={() => setFlow({ kind: "item", item: i })} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-9 py-8 text-center">
              <p className="font-display text-[20px] font-bold leading-tight text-brand-navy">Nothing matches &lsquo;{query.trim()}&rsquo;</p>
              <p className="text-[15px] text-text">Searched names, brands, codes, barcodes, colours, sizes and shelves. It may not be recorded yet.</p>
              <MiniButton onClick={() => setQuery("")}>Clear search</MiniButton>
            </div>
          )}
        </>
      )}

      {/* the two doors, pinned above the tab bar */}
      <div className="sticky bottom-0 z-10 mt-auto border-t border-border bg-surface px-4 pb-3.5 pt-3" data-testid="stock-doors">
        {loadError ? (
          <p className="text-center text-sm text-text-muted">Take stock and Add or return come back once the list loads — they need it to find the item.</p>
        ) : empty ? (
          <div className="space-y-2">
            <BigButton variant="pri" icon={<ArrowDown aria-hidden="true" className="h-5 w-5" strokeWidth={2.5} />} label="Add stock" sub="photograph the first item" onClick={() => setFlow({ kind: "add" })} data-testid="stock-add-button" />
            <p className="text-center text-[13px] text-text-muted">Take stock appears once something is recorded.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            <BigButton variant="pri" icon={<ArrowUp aria-hidden="true" className="h-5 w-5" strokeWidth={2.5} />} label="Take stock" sub="out of the workshop" disabled={!doorsReady} onClick={() => setFlow({ kind: "take" })} data-testid="stock-take-button" />
            <BigButton variant="sec" icon={<ArrowDown aria-hidden="true" className="h-5 w-5" strokeWidth={2.5} />} label="Add or return" sub="into the workshop" disabled={!doorsReady} onClick={() => setFlow({ kind: "add" })} data-testid="stock-add-button" />
          </div>
        )}
      </div>

      {flow?.kind === "take" ? (
        <TakeFlow items={items} viewerId={viewerId} photoReading={Boolean(list?.capabilities.photoRead)} onSaved={saved} onAddNew={(seed) => setFlow({ kind: "add", seed })} onClose={closeWithHistory} />
      ) : null}
      {flow?.kind === "add" && list ? <AddFlow items={items} capabilities={list.capabilities} seed={flow.seed ?? null} onSaved={saved} onClose={closeWithHistory} /> : null}
      {flow?.kind === "item" ? (
        <StockItemSheet
          key={flow.item.id}
          item={flow.item}
          viewerId={viewerId}
          locationPhotoEnabled={caps?.locationPhoto === true}
          listsEnabled={caps?.lists === true}
          onOpenList={openList}
          onBack={flow.from ? () => setFlow(flow.from ?? null) : null}
          onChanged={(r) => { if (r) saved(r); else void load(); }}
          onClose={closeWithHistory}
        />
      ) : null}
      {flow?.kind === "browse" ? (
        <BrowseSheet
          mode={flow.mode}
          items={items}
          choice={flow.choice}
          onChoice={(choice) => setFlow({ ...flow, choice })}
          onPick={(item) => setFlow({ kind: "item", item, from: flow })}
          recentId={recentId}
          onClose={closeWithHistory}
        />
      ) : null}
      {flow?.kind === "lists" ? (
        <ListsFlow
          items={items}
          viewerId={viewerId}
          initialListId={flow.listId ?? null}
          locationPhotoEnabled={caps?.locationPhoto === true}
          onSaved={saved}
          onClose={() => { if (viewerId) void loadMyList(viewerId); closeWithHistory(); }}
        />
      ) : null}
    </div>
  );
}

const ORDER: Record<Reconcile["status"], number> = { saved: 0, not_saved: 1, unknown: 2, retrying: 3, checking: 4 };

/**
 * The saves still waiting for an answer, as ONE card: the first one in full,
 * the rest behind "+ N more — Show all", so the doors never move (critical
 * state is never hidden; it is folded).
 */
function ReconcileSlot({ list, onRetry, onDismiss, onUndone }: { list: Reconcile[]; onRetry: (p: PendingSave) => void; onDismiss: (p: PendingSave) => void; onUndone: (r: WriteResult) => void }) {
  const [all, setAll] = useState(false);
  const sorted = [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const shown = all ? sorted : sorted.slice(0, 1);
  const rest = sorted.length - 1;
  const checking = sorted.filter((r) => r.status === "checking" || r.status === "retrying").length;
  return (
    <div className="space-y-2" data-testid="stock-reconcile-slot">
      {shown.map((r) => <ReconcileCard key={r.p.key} r={r} onRetry={onRetry} onDismiss={onDismiss} onUndone={onUndone} />)}
      {rest > 0 ? (
        <div className="flex items-center justify-between gap-2 px-1 text-[13px] text-text-muted">
          <span>
            {all ? `${sorted.length} saves` : `+ ${rest} more ${rest === 1 ? "save" : "saves"}${checking && !all ? " being checked" : ""}`}
          </span>
          <button type="button" onClick={() => setAll((a) => !a)} className="min-h-[44px] px-2 font-semibold text-state-info underline" data-testid="stock-reconcile-toggle">
            {all ? "Show fewer" : "Show all"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ReconcileCard({ r, onRetry, onDismiss, onUndone }: { r: Reconcile; onRetry: (p: PendingSave) => void; onDismiss: (p: PendingSave) => void; onUndone: (r: WriteResult) => void }) {
  const verb = r.p.kind === "create" ? "New item" : r.p.kind === "take" ? "Take" : r.p.kind === "add" ? "Add" : "Return";
  const what = `${verb} ${r.p.quantityLabel} · ${r.p.itemName}`;
  const lower = `${r.p.kind === "create" ? "new item" : r.p.kind} of ${r.p.quantityLabel} ${r.p.kind === "create" ? `(${r.p.itemName})` : `· ${r.p.itemName}`}`;
  if (r.status === "checking" || r.status === "retrying") {
    return (
      <Slot tone="inf" icon={Loader2} title={r.status === "retrying" ? "Saving it now…" : "Checking a save from earlier…"}>
        {what}. Checking can&rsquo;t record anything twice.
      </Slot>
    );
  }
  if (r.status === "saved") {
    return (
      <div data-testid="stock-reconcile-saved">
        <StockReceipt result={r.result} onUndone={onUndone} title="Your save went through" undoTestId="stock-reconcile-undo" note={<span>{movementSummary(r.result.movement, r.result.item.baseUnit)} · {r.result.item.name} — {recordedNow(r.result.item)}.</span>} />
        <button type="button" onClick={() => onDismiss(r.p)} className="min-h-[44px] px-1 text-sm font-semibold text-brand-navy" data-testid="stock-reconcile-ok">OK</button>
      </div>
    );
  }
  const lost = r.status === "not_saved";
  const records = r.p.kind === "create" ? `Save it now records the new item with its opening count of ${r.p.quantityLabel}.` : `Save it now records ${verb === "Take" ? "Taken" : verb === "Add" ? "Added" : "Returned"} ${r.p.quantityLabel}.`;
  return (
    <Slot
      tone="warn"
      role="alert"
      title={lost ? "A save didn't go through" : "Can't confirm a save yet"}
      testId="stock-reconcile-pending"
      data-status={r.status}
      below={
        <>
          <div className="grid grid-cols-2 gap-2">
            <MiniButton variant="nav" className="w-full" onClick={() => onRetry(r.p)} data-testid="stock-reconcile-retry">{lost ? "Save it now" : "Try again"}</MiniButton>
            <MiniButton className="w-full" onClick={() => onDismiss(r.p)} data-testid="stock-reconcile-dismiss">Discard it</MiniButton>
          </div>
          <p className="mt-2 text-[13px] text-text-muted">{records} Discard it records nothing.</p>
        </>
      }
    >
      Your {lower}{lost ? " was not recorded. Save it now, or discard it." : ". Not confirmed yet — try again; it won't double up."}
    </Slot>
  );
}
