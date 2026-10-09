"use client";

import { useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { PhilActionButton } from "@/components/phil/ui/PhilActionButton";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { fetchOperation, newOperationKey, recordMove, undoMovement, type MoveInput, type PackPick } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, formatQuantity, packLabel, toQuantityString } from "@/domains/workshop-stock/format";
import { clearPending, isUncertain, rememberPending } from "@/domains/workshop-stock/pending";
import type { JobOption, StockIdentifier, StockMovement, StockUnit, WriteResult } from "@/domains/workshop-stock/schema";
import { JobPicker } from "./JobPicker";
import { QuantityStepper } from "./QuantityStepper";
import { StockThumb } from "./StockThumb";

export interface MoveItem {
  id: string;
  name: string;
  brand: string | null;
  manufacturerCode: string | null;
  supplierSku: string | null;
  supplierName: string | null;
  colourFinish: string | null;
  variant: string | null;
  location: string | null;
  baseUnit: StockUnit;
  balanceMilli: number;
  estimated: boolean;
  photoId: string | null;
  defaultPack: { unit: string; sizeMilli: number } | null;
  identifiers: StockIdentifier[];
}

type Kind = "take" | "add" | "return";

const VERB: Record<Kind, { button: string; field: string; done: string }> = {
  take: { button: "Confirm take", field: "Taking", done: "Taken" },
  add: { button: "Add to stock", field: "Adding", done: "Added" },
  return: { button: "Return to stock", field: "Returning", done: "Returned" },
};

/**
 * Confirm the item and quantity, then save ONE movement (Workshop Stock).
 *
 *   • only this explicit confirmation writes stock — a photo, a reading or a
 *     candidate tap never does
 *   • one operation key per logical save: a retry after a timeout re-sends the
 *     same key and the server replays the saved result; the pending save is
 *     remembered on the phone so a reload can ask the server what happened
 *   • after an UNCERTAIN failure (no signal, 5xx) the form is locked until the
 *     outcome is settled — changing the quantity then could double-record
 *   • a done take shows the new recorded balance and an immediate Undo
 */
export function MoveConfirm({
  item,
  kind,
  matchedBy,
  packIdentifierId,
  onSaved,
  onAnother,
  onClose,
}: {
  item: MoveItem;
  kind: Kind;
  matchedBy?: string | null;
  packIdentifierId?: string | null;
  onSaved: (r: WriteResult) => void;
  onAnother?: () => void;
  onClose: () => void;
}) {
  const unit = item.baseUnit;
  // A barcode that is itself a pack barcode (it carries a pack size) starts the
  // form in packs; a unit barcode or a code match starts in the base unit, with
  // the item's default pack offered as an explicit switch.
  const packBarcode = packIdentifierId ? item.identifiers.find((i) => i.id === packIdentifierId && i.packSizeMilli) ?? null : null;
  const packChoice = (() => {
    if (packBarcode && packBarcode.packSizeMilli) return { pick: { source: "identifier", identifierId: packBarcode.id } as PackPick, unit: packBarcode.packUnit || "pack", sizeMilli: packBarcode.packSizeMilli };
    if (item.defaultPack) return { pick: { source: "default" } as PackPick, unit: item.defaultPack.unit, sizeMilli: item.defaultPack.sizeMilli };
    return null;
  })();
  const [usePacks, setUsePacks] = useState(Boolean(packBarcode));
  const [qtyMilli, setQtyMilli] = useState(1000);
  const [packCount, setPackCount] = useState(1);
  const [job, setJob] = useState<JobOption | null>(null);
  const [estimated, setEstimated] = useState(false);
  const [phase, setPhase] = useState<"edit" | "saving" | "uncertain" | "done">("edit");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [undoState, setUndoState] = useState<"idle" | "undoing" | "undone">("idle");
  const [undoError, setUndoError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const undoKeyRef = useRef<string | null>(null);
  const requestRef = useRef<MoveInput | null>(null);

  const totalMilli = usePacks && packChoice ? packCount * packChoice.sizeMilli : qtyMilli;
  const short = kind === "take" && totalMilli > item.balanceMilli;
  const locked = phase === "saving" || phase === "uncertain" || phase === "done";

  function buildRequest(): MoveInput {
    const base: MoveInput = { itemId: item.id, kind, jobId: job ? job.id : null, estimated: kind !== "take" && estimated };
    return usePacks && packChoice ? { ...base, packCount, pack: packChoice.pick } : { ...base, quantity: toQuantityString(qtyMilli) };
  }

  async function send(request: MoveInput, key: string) {
    setPhase("saving");
    setError(null);
    const r = await recordMove(request, key);
    if (r.ok) {
      clearPending();
      keyRef.current = null;
      setResult(r.data);
      setPhase("done");
      onSaved(r.data);
      return;
    }
    if (isUncertain(r.error.status)) {
      setPhase("uncertain");
      setError(r.error.status === 0 ? "Not sure it saved — no signal. Tap Try again: it won't double up." : "Not sure it saved. Tap Try again: it won't double up.");
      return;
    }
    clearPending();
    keyRef.current = null;
    setPhase("edit");
    setError(errorCopy(r.error.status, r.error.body));
  }

  function submit() {
    if (locked || short) return;
    const request = buildRequest();
    const key = keyRef.current ?? newOperationKey();
    keyRef.current = key;
    requestRef.current = request;
    rememberPending({ key, kind, itemId: item.id, itemName: item.name, quantityLabel: formatQuantity(totalMilli, unit), request: request as unknown as Record<string, unknown>, startedAt: new Date().toISOString() });
    void send(request, key);
  }

  async function checkSaved() {
    const key = keyRef.current;
    if (!key) return;
    setPhase("saving");
    const r = await fetchOperation(key);
    if (r.ok && r.data.found && r.data.movement && r.data.item) {
      clearPending();
      keyRef.current = null;
      const done = { item: r.data.item, movement: r.data.movement, replayed: true };
      setResult(done);
      setPhase("done");
      onSaved(done);
      return;
    }
    if (r.ok && !r.data.found) {
      // Definitely not saved: unlock the form; the next save gets a fresh key.
      clearPending();
      keyRef.current = null;
      setPhase("edit");
      setError("It didn't save. Check the quantity and save again.");
      return;
    }
    setPhase("uncertain");
    setError(errorCopy(r.ok ? 500 : r.error.status, r.ok ? null : r.error.body, "Still can't reach the office. Try again in a moment."));
  }

  async function undo(m: StockMovement) {
    setUndoState("undoing");
    setUndoError(null);
    const key = undoKeyRef.current ?? newOperationKey();
    undoKeyRef.current = key;
    const r = await undoMovement({ movementId: m.id }, key);
    if (r.ok) {
      undoKeyRef.current = null;
      setUndoState("undone");
      setResult({ ...r.data });
      onSaved(r.data);
      return;
    }
    if (!isUncertain(r.error.status)) undoKeyRef.current = null;
    setUndoState("idle");
    setUndoError(isUncertain(r.error.status) ? "Not sure the undo went through — tap Undo again (it won't double up)." : errorCopy(r.error.status, r.error.body));
  }

  if (phase === "done" && result) {
    const m = result.movement;
    const after = result.item;
    const isUndo = undoState === "undone";
    return (
      <div className="space-y-4" data-testid="stock-move-done">
        <PhilNotice tone="success" title={isUndo ? "Undone" : `${VERB[kind].done}: ${formatQuantity(Math.abs(m.quantityMilli), unit)}${m.pack ? ` (${m.pack.count} ${packLabel(m.pack.unit, m.pack.count)})` : ""}`}>
          <span data-testid="stock-move-balance">
            {item.name} — {balanceLabel(after)} recorded now{result.replayed && !isUndo ? " (already saved earlier)" : ""}.
          </span>
        </PhilNotice>
        {!isUndo && m.undo?.allowed ? (
          <button type="button" onClick={() => void undo(m)} disabled={undoState === "undoing"} className="min-h-[56px] w-full rounded-card border-2 border-brand-navy bg-surface px-4 font-semibold text-brand-navy disabled:opacity-60" data-testid="stock-move-undo">
            {undoState === "undoing" ? "Undoing…" : "Undo"}
          </button>
        ) : null}
        {undoError ? <PhilNotice tone="danger" role="alert">{undoError}</PhilNotice> : null}
        <div className="grid grid-cols-2 gap-2">
          {onAnother ? (
            <button type="button" onClick={onAnother} className="min-h-[56px] rounded-card border border-border-strong px-3 font-semibold text-text" data-testid="stock-move-another">
              {kind === "take" ? "Take another" : kind === "add" ? "Add another" : "Return another"}
            </button>
          ) : <span />}
          <PhilActionButton size="lg" onClick={onClose} className="min-h-[56px]" data-testid="stock-move-close">Done</PhilActionButton>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="stock-move-confirm" data-kind={kind}>
      <div className="flex gap-3 rounded-card border border-border bg-surface-raised p-3">
        <StockThumb photoId={item.photoId} alt="" size="md" />
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-semibold text-text" data-testid="stock-move-item">{item.name}</p>
          <p className="text-sm text-text-muted">
            {[item.brand, item.manufacturerCode ? `Code ${item.manufacturerCode}` : null, item.colourFinish, item.variant].filter(Boolean).join(" · ")}
          </p>
          {item.supplierSku ? <p className="text-sm text-text-muted">Supplier SKU {item.supplierSku}{item.supplierName ? ` (${item.supplierName})` : ""}</p> : null}
          <p className="mt-1 flex items-center gap-1 text-sm text-text">
            <MapPin aria-hidden="true" className="h-3.5 w-3.5" /> Workshop: {item.location || "no location set"}
          </p>
          <p className="text-sm text-text" data-testid="stock-move-recorded">Recorded stock: {balanceLabel(item)}</p>
          {matchedBy ? <p className="mt-1 text-xs font-semibold text-state-success">{matchedBy}</p> : null}
        </div>
      </div>

      {packChoice ? (
        <label className="flex min-h-[48px] cursor-pointer items-center gap-3 rounded-card border border-border px-3">
          <input type="checkbox" checked={usePacks} disabled={locked} onChange={(e) => setUsePacks(e.target.checked)} className="h-5 w-5" data-testid="stock-move-packs" />
          <span className="text-sm text-text">Count in {packLabel(packChoice.unit, 2)} (1 {packChoice.unit} = {formatQuantity(packChoice.sizeMilli, unit)})</span>
        </label>
      ) : null}

      {usePacks && packChoice ? (
        <div className="space-y-1">
          <QuantityStepper label={VERB[kind].field} valueMilli={packCount * 1000} onChange={(m) => setPackCount(Math.max(1, Math.round(m / 1000)))} unit="each" unitLabel={packLabel(packChoice.unit, packCount)} disabled={locked} testId="stock-move-qty" />
          <p className="text-sm font-semibold text-text" data-testid="stock-move-pack-total">= {formatQuantity(totalMilli, unit)}</p>
        </div>
      ) : (
        <QuantityStepper label={VERB[kind].field} valueMilli={qtyMilli} onChange={setQtyMilli} unit={unit} disabled={locked} testId="stock-move-qty" />
      )}

      {short ? (
        <PhilNotice tone="warning" role="status">
          <span data-testid="stock-move-short">
            {item.balanceMilli === 0
              ? "None recorded. If there's some on the shelf, ask the office to correct the count."
              : `Only ${balanceLabel(item)} recorded. If there's more on the shelf, ask the office to correct the count.`}
          </span>
        </PhilNotice>
      ) : null}

      {kind !== "take" ? (
        <label className="flex min-h-[48px] cursor-pointer items-center gap-3 rounded-card border border-border px-3">
          <input type="checkbox" checked={estimated} disabled={locked} onChange={(e) => setEstimated(e.target.checked)} className="h-5 w-5" data-testid="stock-move-estimated" />
          <span className="text-sm text-text">This is an estimate (e.g. a part-used roll)</span>
        </label>
      ) : null}

      <JobPicker value={job} onChange={setJob} disabled={locked} />

      {error ? (
        <PhilNotice tone={phase === "uncertain" ? "warning" : "danger"} role="alert">
          <span data-testid="stock-move-error">{error}</span>
        </PhilNotice>
      ) : null}

      {phase === "uncertain" ? (
        <div className="grid grid-cols-2 gap-2">
          <PhilActionButton size="lg" onClick={() => { if (keyRef.current && requestRef.current) void send(requestRef.current, keyRef.current); }} data-testid="stock-move-retry">
            Try again
          </PhilActionButton>
          <button type="button" onClick={() => void checkSaved()} className="min-h-[48px] rounded-card border border-border-strong px-3 font-semibold text-text" data-testid="stock-move-check">
            Check if it saved
          </button>
        </div>
      ) : (
        <PhilActionButton size="lg" onClick={submit} disabled={locked || short || totalMilli <= 0} aria-busy={phase === "saving"} className="min-h-[56px]" data-testid="stock-move-submit">
          {phase === "saving" ? "Saving…" : VERB[kind].button}
        </PhilActionButton>
      )}
    </div>
  );
}
