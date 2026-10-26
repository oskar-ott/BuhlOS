"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchItem, fetchOperation, newOperationKey, recordMove, type MoveInput, type PackPick } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, formatQuantity, identityLine, packLabel } from "@/domains/workshop-stock/format";
import { clearPending, isUncertain, rememberPending } from "@/domains/workshop-stock/pending";
import type { JobOption, StockIdentifier, StockItem, StockUnit, WriteResult } from "@/domains/workshop-stock/schema";
import { JobPicker } from "./JobPicker";
import { LocationPhoto } from "./LocationPhoto";
import { QuantityStepper } from "./QuantityStepper";
import { RecordedQuantity } from "./StockItemRow";
import { StockReceipt } from "./StockReceipt";
import { StockThumb } from "./StockThumb";
import { BigButton, LinkButton, SavesLine, Slot } from "./ui";

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
  version: number;
  photoId: string | null;
  /** a photo of where it lives, when the item has one */
  locationPhotoId?: string | null;
  defaultPack: { unit: string; sizeMilli: number } | null;
  identifiers: StockIdentifier[];
}

type Kind = "take" | "add" | "return";

const COPY: Record<Kind, { button: string; howMany: string; packs: string; done: string; job: string }> = {
  take: { button: "Confirm take", howMany: "How many are you taking?", packs: "Taking full", done: "Taken", job: "Note a job" },
  add: { button: "Add to stock", howMany: "How many are going on the shelf?", packs: "Adding full, unopened", done: "Added", job: "Note a job" },
  return: { button: "Return to stock", howMany: "How many came back unused?", packs: "Returning full, unopened", done: "Returned", job: "From job" },
};

function asMoveItem(i: StockItem): MoveItem {
  return {
    id: i.id, name: i.name, brand: i.brand, manufacturerCode: i.manufacturerCode, supplierSku: i.supplierSku, supplierName: i.supplierName,
    colourFinish: i.colourFinish, variant: i.variant, location: i.location, baseUnit: i.baseUnit, balanceMilli: i.balanceMilli,
    estimated: i.estimated, version: i.version, photoId: i.photoId, locationPhotoId: i.locationPhotoId ?? null, defaultPack: i.defaultPack, identifiers: i.identifiers,
  };
}

/**
 * The one confirmation every route reaches (Workshop Stock): the item on top,
 * what is recorded on the shelf, then — pinned at the bottom — how many, and
 * ONE named button that says what it writes ("Confirm take · 2 each").
 *
 *   • only this explicit confirmation writes stock — a photo, a code read or a
 *     candidate tap never does
 *   • the item is re-read when the screen opens: the recorded balance and the
 *     pack sizes shown are the server's current ones, not the list's from
 *     earlier (the "only N recorded" stop needs that fresh copy to block)
 *   • a pack is sent WITH the size the screen showed — if the office changed
 *     it meanwhile the server refuses, and the screen shows the new size
 *   • one operation key per logical save: a retry after a timeout re-sends the
 *     same key and the server replays the saved result; the pending save is
 *     remembered on the phone so a reload can ask the server what happened
 *   • after an UNCERTAIN failure (no signal, 5xx) the form stays locked — and
 *     says why — until the outcome is settled; "Check if it saved" never
 *     unlocks it on a mere "not yet"; a definite refusal unlocks it and says
 *     nothing was saved
 *   • a done save is a receipt with its Undo on it, then Take another / Done
 */
export function MoveConfirm({
  item: initial,
  kind,
  matchedBy,
  packIdentifierId,
  onSaved,
  onAnother,
  anotherLabel,
  anotherSub,
  onWrongItem,
  wrongItemLabel = "Wrong item? Back to the camera",
  doneLabel = "Done",
  doneSub = "back to the list · receipt stays at the top",
  onClose,
}: {
  item: MoveItem;
  kind: Kind;
  matchedBy?: string | null;
  packIdentifierId?: string | null;
  onSaved: (r: WriteResult) => void;
  onAnother?: () => void;
  anotherLabel?: string;
  anotherSub?: string;
  /** the "this isn't it" way out, before anything is written */
  onWrongItem?: () => void;
  wrongItemLabel?: string;
  doneLabel?: string;
  doneSub?: string;
  onClose: () => void;
}) {
  const [item, setItem] = useState<MoveItem>(initial);
  const [fresh, setFresh] = useState(false);
  const unit = item.baseUnit;
  // A barcode that is itself a pack barcode (it carries a pack size) starts the
  // form in packs; a unit barcode or a code match starts in the base unit, with
  // the item's default pack offered as an explicit switch.
  const packBarcode = packIdentifierId ? item.identifiers.find((i) => i.id === packIdentifierId && i.packSizeMilli) ?? null : null;
  const packChoice = (() => {
    if (packBarcode && packBarcode.packSizeMilli) return { pick: { source: "identifier", identifierId: packBarcode.id, sizeMilli: packBarcode.packSizeMilli } as PackPick, unit: packBarcode.packUnit || "pack", sizeMilli: packBarcode.packSizeMilli };
    if (item.defaultPack) return { pick: { source: "default", sizeMilli: item.defaultPack.sizeMilli } as PackPick, unit: item.defaultPack.unit, sizeMilli: item.defaultPack.sizeMilli };
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
  const [undone, setUndone] = useState<WriteResult | null>(null);
  const keyRef = useRef<string | null>(null);
  const requestRef = useRef<MoveInput | null>(null);

  async function refresh() {
    const r = await fetchItem(initial.id);
    if (!r.ok) return false;
    setItem(asMoveItem(r.data.item));
    setFresh(true);
    return true;
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  const totalMilli = usePacks && packChoice ? packCount * packChoice.sizeMilli : qtyMilli;
  const short = kind === "take" && totalMilli > item.balanceMilli;
  // Only a balance read just now may stop a take; an older one is a warning and
  // the server (which has the real balance) decides.
  const blockedShort = short && fresh;
  const locked = phase === "saving" || phase === "uncertain" || phase === "done";
  const copy = COPY[kind];
  const qtyText = formatQuantity(totalMilli, unit);
  const packText = usePacks && packChoice ? `${packCount} ${packLabel(packChoice.unit, packCount)}` : null;
  const afterMilli = kind === "take" ? item.balanceMilli - totalMilli : item.balanceMilli + totalMilli;
  const afterLabel = balanceLabel({ balanceMilli: Math.max(0, afterMilli), baseUnit: unit, estimated: item.estimated || (kind !== "take" && estimated) });

  function buildRequest(): MoveInput {
    const base: MoveInput = { itemId: item.id, kind, jobId: job ? job.id : null, estimated: kind !== "take" && estimated };
    return usePacks && packChoice ? { ...base, packCount, pack: packChoice.pick } : { ...base, quantity: String(totalMilli / 1000) };
  }

  function finish(r: WriteResult) {
    if (keyRef.current) clearPending(keyRef.current);
    keyRef.current = null;
    setResult(r);
    setPhase("done");
    onSaved(r);
  }

  async function send(request: MoveInput, key: string) {
    setPhase("saving");
    setError(null);
    const r = await recordMove(request, key);
    if (r.ok) {
      finish(r.data);
      return;
    }
    if (isUncertain(r.error.status, r.error.body)) {
      setPhase("uncertain");
      setError(r.error.status === 0 ? "Not sure it saved — no signal. Tap Try again: it won't double up." : "Not sure it saved. Tap Try again: it won't double up.");
      return;
    }
    // A definite refusal: nothing was saved, the form unlocks, the next save gets a fresh key.
    clearPending(key);
    keyRef.current = null;
    setPhase("edit");
    const code = (r.error.body as { error?: string } | null)?.error;
    if (code === "insufficient_stock" || code === "pack_changed" || code === "pack_not_found") {
      // show the server's current balance / pack, not the stale one this screen started with
      await refresh();
      if (code === "pack_not_found") setUsePacks(false);
    }
    setError(errorCopy(r.error.status, r.error.body));
  }

  function submit() {
    if (locked || blockedShort || totalMilli <= 0) return;
    const request = buildRequest();
    const key = keyRef.current ?? newOperationKey();
    keyRef.current = key;
    requestRef.current = request;
    rememberPending({ key, kind, itemId: item.id, itemName: item.name, quantityLabel: qtyText, request: request as unknown as Record<string, unknown>, startedAt: new Date().toISOString() });
    void send(request, key);
  }

  async function checkSaved() {
    const key = keyRef.current;
    if (!key) return;
    setPhase("saving");
    const r = await fetchOperation(key);
    if (r.ok && r.data.found && r.data.movement && r.data.item) {
      finish({ item: r.data.item, movement: r.data.movement, replayed: true });
      return;
    }
    // "Not found" may only mean "not landed YET" (the first request can still be
    // on its way): keep the key and stay locked — Try again can never double up.
    setPhase("uncertain");
    setError(r.ok ? "It hasn't saved (yet). Tap Try again — it won't double up." : errorCopy(r.error.status, r.error.body, "Still can't reach the office. Try again in a moment."));
  }

  if (phase === "done" && result) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="stock-move-done">
        <StockReceipt result={result} undone={undone} onUndone={(r) => { setUndone(r); onSaved(r); }} balanceTestId="stock-move-balance" undoTestId="stock-move-undo" />
        <div className="mt-auto space-y-2.5 pt-2">
          {onAnother ? <BigButton variant="pri" label={anotherLabel ?? `${copy.done === "Taken" ? "Take" : copy.done === "Added" ? "Add" : "Return"} another item`} sub={anotherSub ?? "back to the camera"} onClick={onAnother} data-testid="stock-move-another" /> : null}
          <BigButton variant={onAnother ? "sec" : "pri"} label={doneLabel} sub={doneSub} onClick={onClose} data-testid="stock-move-close" />
        </div>
      </div>
    );
  }

  const definiteError = error && phase === "edit";
  const uncertain = phase === "uncertain";
  const saving = phase === "saving";
  const lockedNote = uncertain ? "Locked so it can't record twice" : saving ? "Saving…" : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="stock-move-confirm" data-kind={kind} data-fresh={fresh ? "1" : "0"}>
      <div className="rounded-[14px] border border-border bg-surface p-3">
        <div className="flex gap-3">
          <StockThumb photoId={item.photoId} alt="" size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold leading-tight text-text" data-testid="stock-move-item">{item.name}</p>
            {identityLine(item) ? <p className="mt-0.5 text-[13px] text-text-muted">{identityLine(item)}</p> : null}
            {item.supplierSku ? <p className="text-[13px] text-text-muted">Supplier SKU {item.supplierSku}{item.supplierName ? ` (${item.supplierName})` : ""}</p> : null}
            <p className="mt-1 text-[13px] font-semibold text-text">{item.location || "No shelf set"}</p>
            {matchedBy ? <p className="mt-1 text-xs font-semibold text-state-success">{matchedBy}</p> : null}
          </div>
        </div>
        {item.locationPhotoId ? <LocationPhoto photoId={item.locationPhotoId} location={item.location} className="mt-2.5" /> : null}
        <div className="mt-2.5 flex items-baseline justify-between gap-3 border-t border-border pt-2.5" data-testid="stock-move-recorded">
          <span className="text-[15px] font-semibold text-text-muted">{uncertain ? "Recorded when you opened this" : "Recorded on the shelf"}</span>
          <RecordedQuantity item={item} size="lg" />
        </div>
      </div>
      {onWrongItem && !locked ? <LinkButton onClick={onWrongItem}>{wrongItemLabel}</LinkButton> : null}

      <div className="sticky bottom-0 -mx-4 -mb-3 mt-auto space-y-2.5 border-t border-border bg-surface px-4 pb-3 pt-3">
        {definiteError ? (
          <Slot tone="bad" role="alert" title="That didn't save">
            <span data-testid="stock-move-error">{error}</span>
          </Slot>
        ) : null}

        {packChoice ? (
          <label className="flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border border-border px-3">
            <input type="checkbox" checked={usePacks} disabled={locked} onChange={(e) => setUsePacks(e.target.checked)} className="h-5 w-5 accent-brand-navy" data-testid="stock-move-packs" />
            <span className="text-sm text-text">Count in {packLabel(packChoice.unit, 2)} (1 {packChoice.unit} = {formatQuantity(packChoice.sizeMilli, unit)})</span>
          </label>
        ) : null}

        {usePacks && packChoice ? (
          <div className="space-y-1">
            <QuantityStepper label={`${copy.packs} ${packLabel(packChoice.unit, 2)}`} valueMilli={packCount * 1000} onChange={(m) => setPackCount(Math.max(1, Math.round(m / 1000)))} unit="each" unitLabel={packLabel(packChoice.unit, packCount)} disabled={locked} lockedNote={lockedNote} invalid={blockedShort} testId="stock-move-qty" />
            <p className="text-sm font-semibold text-text" data-testid="stock-move-pack-total">= {qtyText}</p>
          </div>
        ) : (
          <QuantityStepper label={copy.howMany} valueMilli={qtyMilli} onChange={setQtyMilli} unit={unit} disabled={locked} lockedNote={lockedNote} invalid={blockedShort} testId="stock-move-qty" />
        )}

        {kind !== "take" ? (
          <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-1">
            <input type="checkbox" checked={estimated} disabled={locked} onChange={(e) => setEstimated(e.target.checked)} className="h-5 w-5 accent-brand-navy" data-testid="stock-move-estimated" />
            <span className="text-sm text-text">It&rsquo;s a rough count — save as an estimate (e.g. a part-used roll)</span>
          </label>
        ) : null}

        {!locked ? <JobPicker value={job} onChange={setJob} disabled={locked} label={copy.job} /> : job ? <p className="text-[13px] text-text-muted">{copy.job}: {job.code ? `${job.code} · ` : ""}{job.name} · a note only, not a charge</p> : null}

        {short ? (
          <Slot tone="bad" role="status" title={item.balanceMilli === 0 ? "None recorded." : `Only ${balanceLabel(item)} recorded.`}>
            <span data-testid="stock-move-short">{item.balanceMilli === 0 ? "If there's some on the shelf, ask the office to correct the count." : "If there's more on the shelf, ask the office to correct the count."}</span>
          </Slot>
        ) : null}

        {uncertain && error ? (
          <Slot tone="warn" role="alert" title={error.split(". ")[0]}>
            <span data-testid="stock-move-error">{error}</span>
          </Slot>
        ) : null}

        {!short && !uncertain && !saving && totalMilli > 0 ? (
          <SavesLine>
            Saves: {copy.done} {qtyText}{packText ? ` (${packText})` : ""} · {afterLabel} recorded after this
          </SavesLine>
        ) : null}

        {uncertain ? (
          <>
            <BigButton variant="pri" label={`Try again · ${kind} ${qtyText}`} sub="safe · can never record twice" onClick={() => { if (keyRef.current && requestRef.current) void send(requestRef.current, keyRef.current); }} data-testid="stock-move-retry" />
            <BigButton variant="sec" label="Check if it saved" onClick={() => void checkSaved()} data-testid="stock-move-check" />
          </>
        ) : (
          <>
            <BigButton
              variant="pri"
              onClick={submit}
              disabled={locked || blockedShort || totalMilli <= 0}
              aria-busy={saving}
              label={saving ? <span className="flex items-center gap-2"><Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />Saving…</span> : `${copy.button} · ${qtyText}`}
              sub={saving ? "waiting for the office to say saved" : blockedShort ? "can't run: more than is recorded" : item.name}
              data-testid="stock-move-submit"
            />
            {blockedShort && item.balanceMilli > 0 ? (
              <BigButton
                variant="ter"
                label={`Change to ${balanceLabel(item)}`}
                onClick={() => {
                  if (usePacks && packChoice) setPackCount(Math.max(1, Math.floor(item.balanceMilli / packChoice.sizeMilli)));
                  else setQtyMilli(item.balanceMilli);
                }}
                data-testid="stock-move-fit"
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
