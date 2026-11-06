"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Maximize, Minimize, ScanBarcode, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { formatNumber, signedQuantity, UNIT_LABEL } from "@/domains/workshop-stock/format";
import { sessionTotals } from "@/domains/workshop-stock/intake";
import { matrixLocations } from "@/domains/workshop-stock/location-matrix";
import { Block } from "./StockAdminForms";
import { LoggedRow, NeedsYouCard, type Placed } from "./IntakeCards";
import { unlockSound } from "./intake-overlay";
import { NEEDS_YOU, useScanSafeShortcuts, useStatusCues, useStockSession } from "./useStockSession";

/**
 * /stock/scan — the scanner display (owner, 2026-11-03: "i want a separate
 * display for the barcode scanner on web"). The camera table's session with no
 * camera: a USB barcode scanner at the office computer, each scan one
 * placement. A listed code logs by itself (a box's barcode adds a box's worth)
 * and the screen says, large, what it was and where it goes; several items with
 * that code, or none, wait on the right for a person. docs/workshop-stock.md
 */

const NOTE = "Barcode scanner";
const REASON_UNDO = "Scanned by mistake";
const REASON_AMOUNT = "Amount corrected after scanning";
const SOUND_KEY = "buhlos.stock.scan.sound";
const ROWS_SHOWN = 30;
const MANUAL_ID = "stock-scan-manual";

/** Is this page where a scan will land? A scanner types into whatever has focus. */
type Listening = "loading" | "ready" | "field" | "away";

const LISTENING_COPY: Record<Listening, { title: string; body: string }> = {
  loading: { title: "Loading the list", body: "Scans start counting once the stock list has loaded." },
  ready: { title: "Ready", body: "Scan a barcode. A code already on the list logs by itself." },
  field: { title: "Typing in a field", body: "A scan now goes into the field you're in. Click an empty part of the page to scan to the list." },
  away: { title: "Not listening", body: "This window isn't in front, so scans go somewhere else. Click anywhere on this page." },
};

function isField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

function amountText(p: Placed): string {
  if (p.amountMilli === null || !p.unit) return "";
  return p.unit === "each" ? `+${formatNumber(p.amountMilli)}` : signedQuantity(p.amountMilli, p.unit);
}

function Key({ children }: { children: string }) {
  return <kbd className="rounded-[3px] border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-xs font-semibold text-text">{children}</kbd>;
}

/** The newest scan, as big as the screen allows: what it was, and where it goes. */
function LastScan({ placed }: { placed: Placed | null }) {
  if (!placed) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 text-center" data-testid="stock-scan-last" data-status="none">
        <ScanBarcode aria-hidden="true" className="h-16 w-16 text-text-muted" />
        <p className="font-display text-3xl font-semibold text-text">Scan a barcode</p>
        <p className="max-w-md text-sm text-text-muted">Each scan adds one to the stock list. A box&rsquo;s barcode adds a box&rsquo;s worth. Anything new or unsure waits on the right for you.</p>
      </div>
    );
  }
  const status = placed.status;
  const needs = NEEDS_YOU.has(status);
  return (
    <div key={placed.id} className="console-rise flex w-full flex-col gap-4" data-testid="stock-scan-last" data-status={status}>
      <p className={cn("font-mono text-sm font-bold uppercase tracking-[0.1em]", status === "logged" ? "text-state-success" : needs ? "text-state-danger" : "text-text-muted")}>
        {status === "logged" ? "✓ Logged" : status === "saving" || status === "reading" ? "Logging…" : status === "undone" ? "Undone" : status === "ignored" ? "Ignored" : "! Needs you — see the card on the right"}
      </p>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {status === "logged" || status === "saving" ? (
          <span className="font-display text-6xl font-semibold leading-none tabular-nums text-state-success xl:text-7xl" data-testid="stock-scan-last-amount">{amountText(placed)}</span>
        ) : null}
        <span className="min-w-0 font-display text-3xl font-semibold leading-tight text-text xl:text-4xl" data-testid="stock-scan-last-name">
          {placed.itemName ?? (status === "new" ? "New to the stock list" : status === "pick" ? "More than one item has this code" : "—")}
        </span>
      </div>
      {placed.barcode ? <p className="font-mono text-sm text-text-muted">Barcode {placed.barcode}</p> : null}
      {status === "logged" ? (
        <div>
          <p className="console-label">Goes to</p>
          <p className={cn("break-words font-mono text-4xl font-bold uppercase leading-tight xl:text-6xl", placed.location ? "text-accent-yellow" : "text-state-warning")} data-testid="stock-scan-goes-to">
            {placed.location ?? "No location yet"}
          </p>
          {placed.recordedMilli !== null && placed.unit ? (
            <p className="mt-1 font-mono text-sm tabular-nums text-text-muted">{formatNumber(placed.recordedMilli)} {UNIT_LABEL[placed.unit].plural} on record now</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function StockScanStation() {
  const session = useStockSession({ note: NOTE, undoReason: REASON_UNDO, amountReason: REASON_AMOUNT });
  const { placed, items, matrix, matrixAvailable, loadError, loaded, typesEnabled, load, itemsRef, patch, logTo, pickItem, createFromDraft, setLocation, changeAmount, undoPlaced } = session;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [sound, setSound] = useState(true);
  const [full, setFull] = useState(false);
  const [focus, setFocus] = useState<{ window: boolean; field: boolean }>({ window: true, field: false });
  const [showAllRows, setShowAllRows] = useState(false);

  useEffect(() => {
    try {
      setSound(window.localStorage.getItem(SOUND_KEY) !== "off");
    } catch {
      /* only a convenience */
    }
  }, []);

  // Where a scan will land: a scanner types into whatever has focus. The
  // "Won't scan?" box is fine — a scan there ends with Enter and adds it.
  useEffect(() => {
    const read = () => {
      const el = document.activeElement;
      setFocus({ window: document.hasFocus(), field: isField(el) && el?.id !== MANUAL_ID });
    };
    const later = () => setTimeout(read, 0);
    read();
    window.addEventListener("focus", read);
    window.addEventListener("blur", read);
    document.addEventListener("focusin", read);
    document.addEventListener("focusout", later);
    return () => {
      window.removeEventListener("focus", read);
      window.removeEventListener("blur", read);
      document.removeEventListener("focusin", read);
      document.removeEventListener("focusout", later);
    };
  }, []);

  // A scan's closing Enter is a user gesture, so the first scan can turn sound
  // on — not its first key: starting audio mid-scan can stall the page long
  // enough to split the code.
  useEffect(() => {
    let done = false;
    const unlock = (e: Event) => {
      if (done || (e instanceof KeyboardEvent && e.key !== "Enter")) return;
      done = true;
      setTimeout(unlockSound, 0);
    };
    window.addEventListener("keyup", unlock);
    window.addEventListener("pointerdown", unlock);
    return () => {
      window.removeEventListener("keyup", unlock);
      window.removeEventListener("pointerdown", unlock);
    };
  }, []);

  useStatusCues(placed, sound);

  function toggleSound() {
    const next = !sound;
    if (next) unlockSound();
    setSound(next);
    try {
      window.localStorage.setItem(SOUND_KEY, next ? "on" : "off");
    } catch {
      /* only a convenience */
    }
  }

  function toggleFull() {
    const next = !full;
    setFull(next);
    if (next) void rootRef.current?.requestFullscreen?.().catch(() => undefined);
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }

  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFull(false); };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useScanSafeShortcuts((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isField(e.target as Element | null)) return;
    const key = e.key.toLowerCase();
    if (key === "u") session.undoLast();
    else if (key === "f") toggleFull();
    else if (key === "m") toggleSound();
  });

  const listening: Listening = !loaded ? "loading" : !focus.window ? "away" : focus.field ? "field" : "ready";
  const waiting = useMemo(() => placed.filter((p) => NEEDS_YOU.has(p.status)), [placed]);
  const logged = useMemo(() => placed.filter((p) => p.status === "logged"), [placed]);
  const totals = useMemo(() => sessionTotals(placed), [placed]);
  const shownRows = useMemo(() => placed.filter((p) => p.status === "logged" || p.status === "undone"), [placed]);
  const locations = useMemo(() => matrixLocations(matrix), [matrix]);
  const last = placed[0] ?? null;

  return (
    <div ref={rootRef} data-theme="console" className={cn("flex flex-col gap-2 bg-surface-subtle p-2 text-text", full ? "fixed inset-0 z-[60] h-screen" : "rounded-[6px] lg:h-[calc(100vh-150px)] lg:min-h-[640px]")} data-testid="stock-scan">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[4px] border border-border bg-surface px-3 py-1.5">
        <span className="inline-flex items-center gap-2 font-mono text-[13px] font-bold uppercase tracking-[0.1em] text-text" data-testid="stock-scan-status" data-listening={listening}>
          <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-full", listening === "ready" ? "console-live bg-state-success" : listening === "loading" ? "bg-text-muted" : "bg-state-warning")} />
          {LISTENING_COPY[listening].title}
        </span>
        <span className="hidden min-w-0 flex-1 truncate text-sm text-text-muted md:block">{LISTENING_COPY[listening].body}</span>
        <span className="flex-1 md:hidden" />
        {loaded ? (
          <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="console-label">On the list</span>
            <span className="font-mono text-[13px] font-semibold tabular-nums text-text">{items.filter((i) => !i.archivedAt).length}</span>
          </span>
        ) : null}
        {matrix ? (
          <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="console-label">Bin rules</span>
            <span className={cn("font-mono text-[13px] font-semibold tabular-nums", matrix.rules.length ? "text-text" : "text-state-warning")}>{matrix.rules.length}</span>
          </span>
        ) : null}
        <div className="flex items-center gap-1">
          <button type="button" onClick={toggleSound} aria-pressed={sound} aria-label={sound ? "Turn sound off" : "Turn sound on"} title={sound ? "Sound on" : "Sound off"} className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-text-muted hover:bg-surface-raised hover:text-text" data-testid="stock-scan-sound">
            {sound ? <Volume2 aria-hidden="true" className="h-4 w-4" /> : <VolumeX aria-hidden="true" className="h-4 w-4" />}
          </button>
          <button type="button" onClick={toggleFull} aria-pressed={full} aria-label={full ? "Leave full screen" : "Full screen"} title={full ? "Leave full screen" : "Full screen"} className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-text-muted hover:bg-surface-raised hover:text-text" data-testid="stock-scan-full">
            {full ? <Minimize aria-hidden="true" className="h-4 w-4" /> : <Maximize aria-hidden="true" className="h-4 w-4" />}
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <section
            aria-label="Last scan"
            className={cn(
              "flex min-h-[320px] flex-1 items-center rounded-[4px] border bg-surface p-6 lg:min-h-0 lg:p-10",
              listening === "away" || listening === "field" ? "border-state-warning" : last?.status === "logged" ? "border-state-success" : last && NEEDS_YOU.has(last.status) ? "border-state-danger" : "border-border",
            )}
          >
            {listening === "loading" && !loadError ? (
              <p className="mx-auto flex items-center gap-2 text-text-muted" role="status"><Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> Loading the stock list…</p>
            ) : (
              <LastScan placed={last} />
            )}
          </section>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[4px] border border-border bg-surface px-4 py-2.5" data-testid="stock-scan-readout">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-5xl font-semibold leading-none tabular-nums text-state-success" data-testid="stock-scan-logged">{logged.length}</span>
              <span className="console-label">Logged</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className={cn("font-mono text-[15px] font-bold tabular-nums", waiting.length ? "text-state-danger" : "text-text-muted")} data-testid="stock-scan-waiting">{waiting.length}</span>
              <span className="console-label">Waiting on you</span>
            </div>
            <span className="flex-1" />
            <ManualCode onCode={session.scan} disabled={!loaded} />
          </div>

          <p className="sr-only" aria-live="polite">
            {last?.status === "logged" ? `Logged ${amountText(last)} ${last.itemName ?? ""}. ${last.location ? `Goes to ${last.location}.` : "No location yet."}` : ""}
            {waiting.length ? ` ${waiting.length} waiting on you.` : ""}
          </p>

          <div className="hidden flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-text-muted lg:flex">
            <span className="flex items-center gap-1.5"><Key>U</Key> undo last</span>
            <span className="flex items-center gap-1.5"><Key>F</Key> full screen</span>
            <span className="flex items-center gap-1.5"><Key>M</Key> sound</span>
            <span className="flex-1" />
            <span>Each scan is its own entry in the item&rsquo;s history, marked &ldquo;{NOTE}&rdquo;.</span>
          </div>
        </div>

        <aside className="min-h-0 min-w-0 space-y-2 overflow-y-auto" aria-label="This session">
          {loadError ? (
            <Block tone="warn" title="Couldn't load the stock list" role="alert">
              <p>{loadError}</p>
              <Button type="button" variant="secondary" size="sm" className="mt-1" onClick={() => void load()}>Try again</Button>
            </Block>
          ) : null}
          {!matrixAvailable ? (
            <Block tone="warn" title="No location matrix yet" role="status">
              <p>Scans still log, but nothing is given a location until migration 20261102100000_workshop_stock_location_matrix.sql is applied.</p>
            </Block>
          ) : matrix && !matrix.rules.length ? (
            <Block tone="warn" title="No bin rules yet" role="status">
              <p>New items will log without a location until you set up the <a href="/stock/locations" className="font-semibold underline">location matrix</a>.</p>
            </Block>
          ) : null}

          {waiting.map((p) => (
            <NeedsYouCard
              key={p.id}
              placed={p}
              items={items}
              matrix={matrix}
              locations={locations}
              typesEnabled={typesEnabled}
              onPick={(item) => void pickItem(p.id, item)}
              onChooseProduct={() => undefined}
              onCreate={(draft) => void createFromDraft(p.id, draft)}
              onAmount={(milli) => { const item = itemsRef.current.find((x) => x.id === p.itemId); if (item) void logTo(p.id, item, milli); }}
              onRetry={() => { const item = itemsRef.current.find((x) => x.id === p.itemId); if (item) void logTo(p.id, item, p.retryMilli ?? p.amountMilli); }}
              onIgnore={() => patch(p.id, { status: "ignored", problem: null })}
            />
          ))}

          {totals.length ? (
            <details className="rounded-[4px] border border-border bg-surface" open data-testid="stock-scan-by-item">
              <summary className="console-label cursor-pointer px-3 py-2">By item · {totals.length}</summary>
              <ul className="divide-y divide-border border-t border-border">
                {totals.map((t) => (
                  <li key={t.itemId} className="flex items-baseline gap-2 px-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate text-text">{t.name}</span>
                    <span className={cn("shrink-0 font-mono text-xs", t.location ? "text-text-muted" : "text-state-warning")}>{t.location ?? "No location"}</span>
                    <span className="shrink-0 font-mono font-bold tabular-nums text-state-success">{signedQuantity(t.milli, t.unit)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {shownRows.length ? (
            <section className="rounded-[4px] border border-border bg-surface" aria-label="Scanned this session">
              <p className="console-label px-3 py-2">Log · newest first</p>
              <ul className="divide-y divide-border border-t border-border" data-testid="stock-scan-rows">
                {(showAllRows ? shownRows : shownRows.slice(0, ROWS_SHOWN)).map((p) => (
                  <LoggedRow
                    key={p.id}
                    placed={p}
                    locked={false}
                    locations={locations}
                    onChangeAmount={(milli) => void changeAmount(p.id, milli)}
                    onSetLocation={(text) => void setLocation(p.id, text)}
                    onUndo={() => void undoPlaced(p.id)}
                  />
                ))}
              </ul>
              {!showAllRows && shownRows.length > ROWS_SHOWN ? (
                <div className="border-t border-border p-2 text-center">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowAllRows(true)}>Show all {shownRows.length}</Button>
                </div>
              ) : null}
            </section>
          ) : null}

          {!placed.length ? (
            <ol className="space-y-3 rounded-[4px] border border-border bg-surface p-3 text-sm text-text-muted" data-testid="stock-scan-howto">
              <li><span className="console-label block text-text">1 · Scan it</span> Point the scanner at the barcode. Nothing to click first.</li>
              <li><span className="console-label block text-text">2 · It logs it</span> A barcode already on the list adds one by itself (a box&rsquo;s barcode adds the box).</li>
              <li><span className="console-label block text-text">3 · Put it away</span> &ldquo;Goes to&rdquo; shows the bin. A new or unsure code waits here for you.</li>
            </ol>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

/** When a barcode won't scan: type the digits under it. */
function ManualCode({ onCode, disabled }: { onCode: (code: string) => void; disabled: boolean }) {
  const [text, setText] = useState("");
  const code = text.replace(/[\s-]/g, "");
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!code) return;
        onCode(code);
        setText("");
      }}
    >
      <label className="console-label" htmlFor={MANUAL_ID}>Won&rsquo;t scan?</label>
      <input
        id={MANUAL_ID}
        value={text}
        onChange={(e) => setText(e.target.value)}
        inputMode="numeric"
        autoComplete="off"
        placeholder="Type the digits"
        className="h-9 w-52 rounded-[4px] border border-border-strong bg-surface-subtle px-2.5 font-mono text-sm text-text focus:border-accent-yellow focus:outline-none"
        data-testid="stock-scan-manual"
      />
      <Button type="submit" variant="secondary" size="sm" disabled={disabled || !code} data-testid="stock-scan-manual-add">Add</Button>
    </form>
  );
}
