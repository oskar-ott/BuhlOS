"use client";

import { useState } from "react";
import { Loader2, PencilLine, Search } from "lucide-react";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { newOperationKey, readPhoto, undoMovement } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, EVIDENCE_LABEL, matchedInWorkshop, READ_STATUS_COPY } from "@/domains/workshop-stock/format";
import { decideRead, productLabel, type ReadOutcome } from "@/domains/workshop-stock/flow";
import type { CandidateItem, ReadPhotoResult, ReadProduct, StockItem, WriteResult } from "@/domains/workshop-stock/schema";
import { FlowSheet } from "./FlowSheet";
import { ItemPicker } from "./ItemPicker";
import { MoveConfirm, type MoveItem } from "./MoveConfirm";
import { NewItemForm, type NewItemSeed } from "./NewItemForm";
import { PhotoCapture } from "./PhotoCapture";
import { StockItemRow } from "./StockItemRow";

type Step =
  | { s: "photo" }
  | { s: "reading" }
  | { s: "outcome"; outcome: ReadOutcome }
  | { s: "search" }
  | { s: "existing"; item: MoveItem; matchedBy: string | null; packIdentifierId: string | null }
  | { s: "new"; seed: NewItemSeed; formKey: number };

const GUIDANCE = "Photograph the item or its box. Include the label or product code if you can.";

/**
 * "Add stock" (Workshop Stock).
 *
 *   photo → read the label → is it already in the workshop?
 *     yes → confirm the quantity being added (no duplicate item)
 *     no  → one short new-item form, checked against a public listing → save
 *
 * Built for setting up the workshop too: "Save and add another" goes straight
 * back to the camera. Photo reading and the online check are helpers — the
 * whole flow works by hand when they are off or failing.
 */
export function AddFlow({
  items,
  capabilities,
  seed,
  onSaved,
  onClose,
}: {
  items: StockItem[];
  capabilities: { photoRead: boolean; lookup: boolean };
  seed?: { dataUrl: string | null; product: ReadProduct | null } | null;
  onSaved: (r: WriteResult) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(() =>
    seed ? { s: "new", seed: { product: seed.product, photoId: null, dataUrl: seed.dataUrl }, formKey: 1 } : capabilities.photoRead ? { s: "photo" } : { s: "new", seed: { product: null, photoId: null, dataUrl: null }, formKey: 1 },
  );
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const [read, setRead] = useState<ReadPhotoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<WriteResult | null>(null);
  const [undoState, setUndoState] = useState<"idle" | "undoing" | "undone">("idle");
  const [undoError, setUndoError] = useState<string | null>(null);

  function asMoveItem(c: CandidateItem | StockItem): MoveItem {
    const full = items.find((i) => i.id === c.id);
    return { ...(full ?? c), identifiers: (full ?? c).identifiers } as MoveItem;
  }

  function newSeed(product: ReadProduct | null): NewItemSeed {
    return { product, photoId: read?.photoId ?? null, dataUrl };
  }

  async function onPhoto(url: string, isDark: boolean) {
    setDataUrl(url);
    setDark(isDark);
    setError(null);
    setStep({ s: "reading" });
    const r = await readPhoto(url, "add");
    if (!r.ok) {
      setError(errorCopy(r.error.status, r.error.body, "Couldn't read the photo. Enter it by hand, or try again."));
      setStep({ s: "photo" });
      return;
    }
    setRead(r.data);
    route(r.data, null, url);
  }

  function route(result: ReadPhotoResult, chosen: number | null, url: string | null = dataUrl) {
    const outcome = decideRead(result, chosen);
    if (outcome.kind === "none") {
      const product = result.reading?.products[outcome.productIndex] ?? null;
      setStep({ s: "new", seed: { product, photoId: result.photoId, dataUrl: url }, formKey: Date.now() });
      return;
    }
    setStep({ s: "outcome", outcome });
  }

  function saved(r: WriteResult, again: boolean) {
    setLastSaved(r);
    setUndoState("idle");
    setUndoError(null);
    onSaved(r);
    if (!again) {
      // the list screen shows what was saved, with its Undo
      onClose();
      return;
    }
    setDataUrl(null);
    setRead(null);
    setStep(capabilities.photoRead ? { s: "photo" } : { s: "new", seed: { product: null, photoId: null, dataUrl: null }, formKey: Date.now() });
  }

  async function undoLast() {
    if (!lastSaved) return;
    setUndoState("undoing");
    const r = await undoMovement({ movementId: lastSaved.movement.id }, newOperationKey());
    if (r.ok) {
      setUndoState("undone");
      onSaved(r.data);
      return;
    }
    setUndoState("idle");
    setUndoError(errorCopy(r.error.status, r.error.body));
  }

  const back = step.s !== "photo" && step.s !== "reading" ? () => { setError(null); setStep({ s: "photo" }); } : null;
  const banner = lastSaved ? (
    <div className="space-y-2" data-testid="stock-add-saved">
      <PhilNotice tone="success" title={undoState === "undone" ? "Undone" : "Saved"}>
        {lastSaved.item.name} — {balanceLabel(undoState === "undone" ? { ...lastSaved.item, balanceMilli: lastSaved.item.balanceMilli - lastSaved.movement.quantityMilli } : lastSaved.item)} recorded{lastSaved.item.location ? ` at ${lastSaved.item.location}` : ""}.
        {lastSaved.photoAttached === false ? " The photo couldn't be attached." : ""}
      </PhilNotice>
      {undoState !== "undone" && lastSaved.movement.undo?.allowed ? (
        <button type="button" onClick={() => void undoLast()} disabled={undoState === "undoing"} className="min-h-[48px] w-full rounded-card border-2 border-brand-navy font-semibold text-brand-navy" data-testid="stock-add-undo">
          {undoState === "undoing" ? "Undoing…" : "Undo that"}
        </button>
      ) : null}
      {undoError ? <PhilNotice tone="danger" role="alert">{undoError}</PhilNotice> : null}
    </div>
  ) : null;

  return (
    <FlowSheet title="Add stock" onClose={onClose} onBack={back} testId="stock-add-flow">
      {step.s === "photo" ? (
        <>
          {banner}
          {capabilities.photoRead ? (
            <PhotoCapture guidance={GUIDANCE} onPhoto={(u, d) => void onPhoto(u, d)} previewUrl={null} />
          ) : (
            <PhilNotice tone="info">Photo reading isn&rsquo;t set up — enter the item by hand.</PhilNotice>
          )}
          {dark ? <PhilNotice tone="warning">That photo looks dark — a brighter one reads better.</PhilNotice> : null}
          {error ? <PhilNotice tone="danger" role="alert">{error}</PhilNotice> : null}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setStep({ s: "search" })} className="flex min-h-[56px] items-center justify-center gap-2 rounded-card border border-border-strong px-2 font-semibold text-text" data-testid="stock-add-search">
              <Search aria-hidden="true" className="h-5 w-5" /> It&rsquo;s already listed
            </button>
            <button type="button" onClick={() => setStep({ s: "new", seed: { product: null, photoId: null, dataUrl: null }, formKey: Date.now() })} className="flex min-h-[56px] items-center justify-center gap-2 rounded-card border border-border-strong px-2 font-semibold text-text" data-testid="stock-add-manual">
              <PencilLine aria-hidden="true" className="h-5 w-5" /> Enter by hand
            </button>
          </div>
        </>
      ) : null}

      {step.s === "reading" ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center" role="status" data-testid="stock-reading">
          {/* eslint-disable-next-line @next/next/no-img-element -- local preview */}
          {dataUrl ? <img src={dataUrl} alt="Your photo" className="h-32 w-32 rounded-card border border-border object-cover" /> : null}
          <Loader2 aria-hidden="true" className="h-6 w-6 animate-spin text-text-muted" />
          <p className="text-sm text-text">Reading the label… this can take up to 20 seconds.</p>
        </div>
      ) : null}

      {step.s === "outcome" ? (
        <AddOutcome
          outcome={step.outcome}
          read={read}
          onProduct={(i) => read && route(read, i)}
          onExisting={(item, matchedBy, packIdentifierId) => setStep({ s: "existing", item: asMoveItem(item), matchedBy, packIdentifierId })}
          onNew={(product) => setStep({ s: "new", seed: newSeed(product), formKey: Date.now() })}
          onRetake={() => setStep({ s: "photo" })}
        />
      ) : null}

      {step.s === "search" ? <ItemPicker items={items} onPick={(i) => setStep({ s: "existing", item: asMoveItem(i), matchedBy: null, packIdentifierId: null })} /> : null}

      {step.s === "existing" ? (
        <MoveConfirm key={step.item.id} item={step.item} kind="add" matchedBy={step.matchedBy} packIdentifierId={step.packIdentifierId} onSaved={onSaved} onAnother={() => setStep({ s: "photo" })} onClose={onClose} />
      ) : null}

      {step.s === "new" ? (
        <NewItemForm
          key={step.formKey}
          seed={step.seed}
          items={items}
          lookupEnabled={capabilities.lookup}
          onSaved={saved}
          onUseExisting={(item) => setStep({ s: "existing", item: asMoveItem(item), matchedBy: "Matched in workshop · same code", packIdentifierId: null })}
        />
      ) : null}
    </FlowSheet>
  );
}

function AddOutcome({
  outcome,
  read,
  onProduct,
  onExisting,
  onNew,
  onRetake,
}: {
  outcome: ReadOutcome;
  read: ReadPhotoResult | null;
  onProduct: (i: number) => void;
  onExisting: (item: CandidateItem, matchedBy: string | null, packIdentifierId: string | null) => void;
  onNew: (product: ReadProduct | null) => void;
  onRetake: () => void;
}) {
  const product = outcome.kind !== "status" && outcome.kind !== "pick-product" ? read?.reading?.products[outcome.productIndex] ?? null : null;
  if (outcome.kind === "status") {
    const copy = READ_STATUS_COPY[outcome.status];
    return (
      <div className="space-y-3" data-testid="stock-outcome-status" data-status={outcome.status}>
        <PhilNotice tone="warning" title={copy.title}>{read?.reading?.note || "Enter it by hand — the photo is kept for the item."}</PhilNotice>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => onNew(null)} className="min-h-[56px] rounded-card border border-border-strong px-3 font-semibold text-text" data-testid="stock-outcome-manual">Enter by hand</button>
          <button type="button" onClick={onRetake} className="min-h-[56px] rounded-card border border-border-strong px-3 font-semibold text-text">Retake</button>
        </div>
      </div>
    );
  }
  if (outcome.kind === "pick-product") {
    return (
      <div className="space-y-3" data-testid="stock-outcome-products">
        <p className="font-display text-base font-semibold text-text">There&rsquo;s more than one product in the photo. Which one are you adding?</p>
        <ul className="space-y-2">
          {outcome.products.map((p, i) => (
            <li key={i}>
              <button type="button" onClick={() => onProduct(i)} className="flex min-h-[56px] w-full items-center rounded-card border border-border bg-surface-raised px-3 text-left text-sm font-semibold text-text" data-testid="stock-outcome-product">
                {productLabel(p, i)}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (outcome.kind === "exact") {
    const status = matchedInWorkshop(outcome.candidate);
    const useIt = () => onExisting(outcome.item, status, outcome.candidate.evidence === "barcode" ? outcome.candidate.identifierId : null);
    return (
      <div className="space-y-3" data-testid="stock-outcome-existing">
        <PhilNotice tone="success" title="Matched in workshop">Add to the existing item — no need for a new one.</PhilNotice>
        <StockItemRow item={{ ...outcome.item, archivedAt: null }} onClick={useIt} hint={status} testId="stock-existing-match" />
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={useIt} className="min-h-[56px] rounded-card bg-accent-yellow px-3 font-semibold text-brand-navy" data-testid="stock-add-to-existing">Add to this item</button>
          <button type="button" onClick={() => onNew(product)} className="min-h-[56px] rounded-card border border-border-strong px-3 font-semibold text-text" data-testid="stock-not-this">It&rsquo;s a different product</button>
        </div>
      </div>
    );
  }
  if (outcome.kind === "candidates") {
    return (
      <div className="space-y-3" data-testid="stock-outcome-candidates">
        <p className="font-display text-base font-semibold text-text">Is it one of these already in the workshop?</p>
        <ul className="space-y-2">
          {outcome.candidates.map(({ candidate, item }) => (
            <li key={item.id}>
              <StockItemRow item={{ ...item, archivedAt: null }} onClick={() => onExisting(item, `Picked by you · ${EVIDENCE_LABEL[candidate.evidence] ?? ""}`, null)} hint={[EVIDENCE_LABEL[candidate.evidence], ...candidate.conflicts.map((c) => `${c.field} differs`)].join(" · ")} testId="stock-candidate" />
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => onNew(product)} className="min-h-[56px] w-full rounded-card border border-border-strong font-semibold text-text" data-testid="stock-none-of-these">None of these — it&rsquo;s new</button>
      </div>
    );
  }
  return null;
}
