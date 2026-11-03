"use client";

import { useMemo, useState, type ButtonHTMLAttributes } from "react";
import { Loader2, Lock, MapPin, Pencil, ScanBarcode, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { productLabel } from "@/domains/workshop-stock/flow";
import { balanceLabel, formatNumber, matchesSearch, parseTypedQuantity, signedQuantity, UNIT_LABEL } from "@/domains/workshop-stock/format";
import { draftFor, labelTexts, type NewItemDraft } from "@/domains/workshop-stock/intake";
import type { Box } from "@/domains/workshop-stock/intake-tracker";
import type { LocationMatrix } from "@/domains/workshop-stock/location-matrix";
import { UNIT_KEYS, type CandidateItem, type ReadPhotoResult, type ReadProduct, type StockItem, type StockUnit } from "@/domains/workshop-stock/schema";
import { guessSpecs, STOCK_TYPES } from "@/domains/workshop-stock/types";

export type PlacedStatus = "reading" | "saving" | "logged" | "pick" | "several" | "new" | "amount" | "problem" | "ignored" | "undone";

/** One object placed on the camera table, from red to green. */
export interface Placed {
  id: number;
  at: number;
  box: Box;
  onTable: boolean;
  crop: string;
  thumb: string | null;
  status: PlacedStatus;
  barcode: string | null;
  product: ReadProduct | null;
  readResult: ReadPhotoResult | null;
  choices: CandidateItem[];
  problem: string | null;
  note: string | null;
  busy: boolean;
  itemId: string | null;
  itemName: string | null;
  unit: StockUnit | null;
  location: string | null;
  amountMilli: number | null;
  fromLabel: boolean;
  recordedMilli: number | null;
  movementId: string | null;
  /** held across retries, so a save whose answer was lost is never counted twice */
  moveKey: string | null;
  photoId: string | null;
  retryMilli: number | null;
}

const INPUT = "h-9 w-full rounded-[4px] border border-border-strong bg-surface-subtle px-2.5 text-sm text-text focus:border-accent-yellow focus:outline-none";
const LABEL = "console-label block";
const CHOICE = "w-full rounded-[4px] border border-border bg-surface-raised px-2.5 py-1.5 text-left text-sm text-text hover:border-accent-yellow focus-visible:border-accent-yellow focus-visible:outline-none";

function CropThumb({ placed, className }: { placed: Placed; className?: string }) {
  // a scan from the USB scanner has no picture: show that it was scanned
  if (!placed.thumb && !placed.crop) {
    return <span aria-label="Scanned" className={cn("inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[4px] border border-border bg-surface-subtle", className)}><ScanBarcode aria-hidden="true" className="h-6 w-6 text-text-muted" /></span>;
  }
  // eslint-disable-next-line @next/next/no-img-element -- a local crop, never uploaded for this
  return <img src={placed.thumb ?? placed.crop} alt="What the camera saw" className={cn("h-14 w-14 shrink-0 rounded-[4px] border border-border object-cover", className)} />;
}

function IconAction({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={cn("inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-text-muted hover:bg-surface-raised hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-yellow disabled:opacity-40", className)} {...rest}>
      {children}
    </button>
  );
}

function ItemSearch({ items, onPick, testId }: { items: StockItem[]; onPick: (item: StockItem) => void; testId?: string }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => (q.trim() ? items.filter((i) => !i.archivedAt && matchesSearch(i, q)).slice(0, 5) : []), [items, q]);
  return (
    <div className="space-y-1">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the stock list" aria-label="Search the stock list" className={INPUT} data-testid={testId} />
      {q.trim() ? (
        shown.length ? (
          <ul className="space-y-1">
            {shown.map((i) => (
              <li key={i.id}>
                <button type="button" onClick={() => onPick(i)} className={CHOICE}>
                  {i.name} <span className="text-text-muted">· {i.location ?? "no location"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">Nothing on the list matches.</p>
        )
      ) : null}
    </div>
  );
}

function NewItemCard({ placed, matrix, locations, typesEnabled, busy, onCreate }: { placed: Placed; matrix: LocationMatrix | null; locations: string[]; typesEnabled: boolean; busy: boolean; onCreate: (d: NewItemDraft) => void }) {
  const [draft, setDraft] = useState<NewItemDraft>(() => draftFor(placed.product, matrix));
  const listId = `stock-intake-locations-${placed.id}`;
  function chooseType(key: string) {
    const category = key || null;
    setDraft({ ...draft, category, specs: category ? guessSpecs(category, labelTexts(placed.product)) : {} });
  }
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onCreate(draft); }}>
      <label className={LABEL}>
        Name
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={160} className={cn(INPUT, "mt-1 font-sans normal-case tracking-normal")} data-testid="stock-intake-new-name" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={LABEL}>
          Adding
          <input value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} inputMode={draft.unit === "metre" ? "decimal" : "numeric"} className={cn(INPUT, "mt-1 font-sans normal-case tracking-normal")} data-testid="stock-intake-new-amount" />
        </label>
        <label className={LABEL}>
          Counted in
          <select value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value as StockUnit })} className={cn(INPUT, "mt-1 font-sans normal-case tracking-normal")}>
            {UNIT_KEYS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u].chip}</option>)}
          </select>
        </label>
      </div>
      {typesEnabled ? (
        <label className={LABEL}>
          Type
          <select value={draft.category ?? ""} onChange={(e) => chooseType(e.target.value)} className={cn(INPUT, "mt-1 font-sans normal-case tracking-normal")} data-testid="stock-intake-new-type">
            <option value="">Not sorted</option>
            {STOCK_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
      ) : null}
      <label className={LABEL}>
        Goes to{draft.locationFrom ? ` · from “${draft.locationFrom}”` : ""}
        <input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value, locationFrom: null })} maxLength={60} list={listId} placeholder="No rule fits: pick or type a bin" className={cn(INPUT, "mt-1 font-sans normal-case tracking-normal")} data-testid="stock-intake-new-location" />
        <datalist id={listId}>{locations.map((l) => <option key={l} value={l} />)}</datalist>
      </label>
      {placed.product?.manufacturerCode || placed.barcode ? (
        <p className="text-xs text-text-muted">Saves with {[placed.product?.manufacturerCode ? `code ${placed.product.manufacturerCode}` : null, placed.barcode ? `barcode ${placed.barcode}` : null].filter(Boolean).join(" and ")}, so the next one logs itself.</p>
      ) : (
        <p className="text-xs text-text-muted">No code or barcode was read, so the next one will ask again.</p>
      )}
      <Button type="submit" size="sm" disabled={busy} data-testid="stock-intake-new-save">
        {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null} Add to stock
      </Button>
    </form>
  );
}

function AmountForm({ unit, onAmount }: { unit: StockUnit; onAmount: (milli: number) => void }) {
  const [text, setText] = useState("");
  const milli = parseTypedQuantity(text, unit);
  return (
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (milli !== null) onAmount(milli); }}>
      <input value={text} onChange={(e) => setText(e.target.value)} inputMode={unit === "metre" ? "decimal" : "numeric"} autoFocus aria-label={`How many ${UNIT_LABEL[unit].plural}`} className={cn(INPUT, "w-24")} data-testid="stock-intake-amount" />
      <span className="text-sm text-text-muted">{UNIT_LABEL[unit].plural}</span>
      <Button type="submit" size="sm" disabled={milli === null}>Log it</Button>
    </form>
  );
}

/** A red box that needs a person: one card, one decision. */
export function NeedsYouCard({
  placed, items, matrix, locations, typesEnabled, onPick, onChooseProduct, onCreate, onAmount, onRetry, onReadAgain, onIgnore,
}: {
  placed: Placed;
  items: StockItem[];
  matrix: LocationMatrix | null;
  locations: string[];
  typesEnabled: boolean;
  onPick: (item: Pick<StockItem, "id">) => void;
  onChooseProduct: (index: number) => void;
  onCreate: (d: NewItemDraft) => void;
  onAmount: (milli: number) => void;
  onRetry: () => void;
  onReadAgain: () => void;
  onIgnore: () => void;
}) {
  const title = { pick: "Which item is this?", several: "More than one product here", new: "New to the stock list", amount: `How much is this ${placed.itemName ?? ""}?`, problem: "Needs you" }[placed.status as "pick" | "several" | "new" | "amount" | "problem"];
  const products = placed.readResult?.reading?.products ?? [];
  return (
    <div className="console-rise space-y-2.5 rounded-[4px] border border-state-danger bg-surface p-3" data-testid="stock-intake-card" data-status={placed.status}>
      <div className="flex items-start gap-3">
        <CropThumb placed={placed} />
        <div className="min-w-0 flex-1">
          <p className="font-display text-[15px] font-semibold leading-snug text-text">{title}</p>
          {placed.product ? <p className="truncate text-sm text-text-muted">{[placed.product.brand, placed.product.description || placed.product.manufacturerCode].filter(Boolean).join(" ")}</p> : null}
          {!placed.onTable ? <p className="text-xs text-text-muted">Off the table now.</p> : null}
        </div>
      </div>
      {placed.problem ? <p className="text-sm text-state-danger" role="alert">{placed.problem}</p> : null}

      {placed.status === "new" ? (
        <>
          <NewItemCard placed={placed} matrix={matrix} locations={locations} typesEnabled={typesEnabled} busy={placed.busy} onCreate={onCreate} />
          <details className="text-sm">
            <summary className="cursor-pointer text-text-muted">It&rsquo;s already on the list</summary>
            <div className="mt-1"><ItemSearch items={items} onPick={onPick} testId="stock-intake-search" /></div>
          </details>
        </>
      ) : null}
      {placed.status === "pick" ? (
        <>
          <ul className="space-y-1">
            {placed.choices.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => onPick(c)} className={CHOICE} data-testid="stock-intake-choice">
                  {c.name} <span className="text-text-muted">· {balanceLabel(c)}{c.location ? ` · ${c.location}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
          <ItemSearch items={items} onPick={onPick} testId="stock-intake-search" />
        </>
      ) : null}
      {placed.status === "several" ? (
        <ul className="space-y-1">
          {products.map((p, i) => (
            <li key={i}>
              <button type="button" onClick={() => onChooseProduct(i)} className={CHOICE}>{productLabel(p, i)}</button>
            </li>
          ))}
        </ul>
      ) : null}
      {placed.status === "amount" && placed.unit ? <AmountForm unit={placed.unit} onAmount={onAmount} /> : null}
      {placed.status === "problem" ? <ItemSearch items={items} onPick={onPick} testId="stock-intake-search" /> : null}

      <div className="flex flex-wrap gap-1">
        {placed.status === "problem" ? <Button type="button" variant="secondary" size="sm" onClick={onRetry} data-testid="stock-intake-retry">{placed.itemId ? "Try again" : "Read it again"}</Button> : null}
        {placed.status === "new" || placed.status === "pick" ? <Button type="button" variant="ghost" size="sm" onClick={onReadAgain} data-testid="stock-intake-read-again">Read it again</Button> : null}
        <Button type="button" variant="ghost" size="sm" onClick={onIgnore} data-testid="stock-intake-ignore">Not stock, ignore</Button>
      </div>
    </div>
  );
}

/** A green one: what it added and where it goes, with the amount, location and Undo a tap away. */
export function LoggedRow({ placed, locked, locations, onChangeAmount, onSetLocation, onUndo, onLock }: { placed: Placed; locked: boolean; locations: string[]; onChangeAmount: (milli: number) => void; onSetLocation: (text: string) => void; onUndo: () => void; onLock: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const unit = placed.unit ?? "each";
  const milli = editing === null ? null : parseTypedQuantity(editing, unit);
  const listId = `stock-intake-row-locations-${placed.id}`;
  if (placed.status === "undone") {
    return (
      <li className="flex items-center gap-3 px-3 py-2 opacity-60" data-testid="stock-intake-row" data-status="undone">
        <CropThumb placed={placed} className="h-9 w-9" />
        <p className="min-w-0 flex-1 truncate text-sm text-text-muted line-through">{placed.itemName}</p>
        <span className="console-label">Undone</span>
      </li>
    );
  }
  return (
    <li className="console-rise space-y-1.5 px-3 py-2" data-testid="stock-intake-row" data-status="logged">
      <div className="flex items-center gap-3">
        <CropThumb placed={placed} className="h-10 w-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text">{placed.itemName}</p>
          <p className="truncate font-mono text-xs text-text-muted" data-testid="stock-intake-row-location">
            {placed.location ?? <span className="text-state-warning">No location</span>}
          </p>
          {placed.fromLabel ? <p className="text-xs text-text-muted">Pack size from the label.</p> : null}
          {placed.note ? <p className="text-xs text-state-danger">{placed.note}</p> : null}
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-sm font-bold tabular-nums text-state-success" data-testid="stock-intake-row-amount">{placed.amountMilli !== null ? signedQuantity(placed.amountMilli, unit) : ""}</p>
          {placed.recordedMilli !== null ? <p className="font-mono text-xs tabular-nums text-text-muted">{formatNumber(placed.recordedMilli)} on record</p> : null}
        </div>
      </div>
      {placed.problem ? <p className="text-sm text-state-danger" role="alert">{placed.problem}</p> : null}
      {editing !== null ? (
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (milli !== null) { onChangeAmount(milli); setEditing(null); } }}>
          <input value={editing} onChange={(e) => setEditing(e.target.value)} inputMode={unit === "metre" ? "decimal" : "numeric"} autoFocus aria-label={`New amount in ${UNIT_LABEL[unit].plural}`} className={cn(INPUT, "w-24")} data-testid="stock-intake-row-edit-input" />
          <Button type="submit" size="sm" disabled={milli === null} data-testid="stock-intake-row-edit-save">Save</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
        </form>
      ) : placing !== null ? (
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (placing.trim()) { onSetLocation(placing.trim()); setPlacing(null); } }}>
          <input value={placing} onChange={(e) => setPlacing(e.target.value)} maxLength={60} list={listId} autoFocus placeholder="Pick or type a bin" aria-label="Where this goes" className={cn(INPUT, "min-w-0 flex-1")} data-testid="stock-intake-row-location-input" />
          <datalist id={listId}>{locations.map((l) => <option key={l} value={l} />)}</datalist>
          <Button type="submit" size="sm" disabled={!placing.trim()} data-testid="stock-intake-row-location-save">Save</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setPlacing(null)}>Cancel</Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-0.5">
          {!placed.location ? (
            <button type="button" disabled={placed.busy} onClick={() => setPlacing("")} className="mr-auto inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-state-warning-subtle-border bg-state-warning-subtle-bg px-2 text-xs font-semibold text-state-warning-subtle-text" data-testid="stock-intake-row-set-location">
              <MapPin aria-hidden="true" className="h-3.5 w-3.5" /> Set location
            </button>
          ) : null}
          <IconAction label="Change amount" disabled={placed.busy} onClick={() => setEditing(placed.amountMilli !== null ? formatNumber(placed.amountMilli) : "")} data-testid="stock-intake-row-edit"><Pencil aria-hidden="true" className="h-4 w-4" /></IconAction>
          <IconAction label="Undo this one" disabled={placed.busy} onClick={onUndo} data-testid="stock-intake-row-undo"><Undo2 aria-hidden="true" className="h-4 w-4" /></IconAction>
          {!locked ? <IconAction label="Everything placed next is the same as this" onClick={onLock} data-testid="stock-intake-row-lock"><Lock aria-hidden="true" className="h-4 w-4" /></IconAction> : null}
        </div>
      )}
    </li>
  );
}
