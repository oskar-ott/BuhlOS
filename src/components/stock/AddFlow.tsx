"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Camera, Check, ChevronRight, Images, Loader2, PencilLine } from "lucide-react";
import { cn } from "@/lib/cn";
import { readPhoto } from "@/domains/workshop-stock/client";
import { findByBarcode } from "@/domains/workshop-stock/barcode";
import { balanceLabel, errorCopy, EVIDENCE_LABEL, identityLine, matchedInWorkshop, movementSummary, READ_STATUS_COPY, recordedNow, undoLabelFor } from "@/domains/workshop-stock/format";
import { decideRead, focusBatch, freshestItem, productLabel, settleBatch, startBatch, type PhotoBatch, type ReadOutcome } from "@/domains/workshop-stock/flow";
import { splitLocation } from "@/domains/workshop-stock/location";
import type { CandidateItem, ReadPhotoResult, ReadProduct, StockItem, WriteResult } from "@/domains/workshop-stock/schema";
import { FlowSheet } from "./FlowSheet";
import { ItemPicker } from "./ItemPicker";
import { MoveConfirm, type MoveItem } from "./MoveConfirm";
import { NewItemForm, type LastLocationPhoto, type NewItemSeed } from "./NewItemForm";
import { PhotoCapture } from "./PhotoCapture";
import { NoneRecorded, RecordedQuantity } from "./StockItemRow";
import { StockReceipt } from "./StockReceipt";
import { StockThumb } from "./StockThumb";
import { BigButton, LinkButton, MiniButton, Slot } from "./ui";
import { UndoControl } from "./UndoControl";
import { useBarcodeScanner } from "./useBarcodeScanner";
import { BarcodeLabel } from "./BarcodeLabel";

type Found = { item: MoveItem; matchedBy: string | null; packIdentifierId: string | null; product: ReadProduct | null };

type Step =
  | { s: "home" }
  | { s: "reading" }
  | { s: "outcome"; outcome: ReadOutcome }
  | { s: "going"; found: Found }
  | { s: "existing"; found: Found; kind: "add" | "return" }
  | { s: "new"; seed: NewItemSeed; formKey: number }
  | { s: "setup"; last: WriteResult }
  | { s: "label"; last: WriteResult; then: "setup" | "close" | "batch" }
  | { s: "batchDone" };

/** Several products from one photo, added one at a time: where we are, and what was saved. */
type Batch = PhotoBatch & { results: WriteResult[] };

/**
 * "Add or return" (Workshop Stock) — everything that goes INTO the workshop.
 *
 *   find the item (photo of the label or box, or search)
 *     already listed → "What's going in?": add to it · return to it · a different product
 *     not listed     → one short new-item form, checked against a public listing → save
 *
 * Built for setting up the workshop too: "Save and add another" shows the
 * receipt, the shelf filling up, and goes straight back to the camera; "Done for
 * now" ends it with nothing waiting. Photo reading and the online check are
 * helpers — the whole flow works by hand when they are off or failing.
 */
export function AddFlow({
  items,
  capabilities,
  seed,
  onSaved,
  onClose,
}: {
  items: StockItem[];
  capabilities: { photoRead: boolean; lookup: boolean; locationPhoto?: boolean; types?: boolean };
  seed?: { dataUrl: string | null; thumbDataUrl?: string | null; product: ReadProduct | null; scannedBarcode?: string | null } | null;
  onSaved: (r: WriteResult) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(() => (seed ? { s: "new", seed: { product: seed.product, photoId: null, dataUrl: seed.dataUrl, thumbDataUrl: seed.thumbDataUrl ?? null, scannedBarcode: seed.scannedBarcode ?? null }, formKey: 1 } : { s: "home" }));

  // A barcode scanner (2026-11-03) on the first screen: a listed item goes to
  // "What's going in?"; an unknown code starts a new item with the barcode kept.
  useBarcodeScanner((code) => {
    const hits = findByBarcode(items, code);
    if (hits.length >= 1) {
      const h = hits[0]!;
      setStep({ s: "going", found: { item: asMoveItem(h.item), matchedBy: matchedInWorkshop({ evidence: "barcode", matchedValue: code }), packIdentifierId: h.identifier.packSizeMilli ? h.identifier.id : null, product: null } });
    } else {
      setStep({ s: "new", seed: { product: null, photoId: null, dataUrl: null, scannedBarcode: code }, formKey: Date.now() });
    }
  }, step.s === "home");
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [thumbDataUrl, setThumbDataUrl] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const [read, setRead] = useState<ReadPhotoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<WriteResult[]>([]);
  const [undone, setUndone] = useState<WriteResult | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  // The photo's own row can be claimed by ONE new item; later new items from the
  // same photo upload their own copy of it (NewItemForm does, when photoId is null).
  const photoUsedRef = useRef(false);
  const lastLocation = useMemo(() => [...session].reverse().find((r) => r.item.location)?.item.location ?? null, [session]);
  // the last photo of where an item lives this session — offered again for the same shelf
  const lastLocationPhoto = useMemo<LastLocationPhoto | null>(() => {
    const r = [...session].reverse().find((x) => x.item.locationPhotoId);
    return r && r.item.locationPhotoId ? { itemId: r.item.id, photoId: r.item.locationPhotoId, itemName: r.item.name, location: r.item.location } : null;
  }, [session]);

  // The list's copy or the one the photo read just returned, whichever is newer
  // (the confirm screen re-reads it from the server either way).
  function asMoveItem(c: CandidateItem | StockItem): MoveItem {
    const pick = freshestItem<CandidateItem | StockItem>(items.find((i) => i.id === c.id), c);
    return { ...pick, identifiers: pick.identifiers } as MoveItem;
  }

  function newSeed(product: ReadProduct | null): NewItemSeed {
    return { product, photoId: photoUsedRef.current ? null : read?.photoId ?? null, dataUrl, thumbDataUrl };
  }

  function home() {
    setError(null);
    setStep({ s: "home" });
  }

  function fresh() {
    setDataUrl(null);
    setThumbDataUrl(null);
    setRead(null);
    setDark(false);
    setBatch(null);
    photoUsedRef.current = false;
  }

  // ── several products from one photo ─────────────────────────────────────────
  function startAll() {
    const total = read?.reading?.products.length ?? 0;
    if (!read || total < 2) return;
    photoUsedRef.current = false;
    setBatch({ ...startBatch(total), results: [] });
    route(read, 0);
  }

  /** Back to the photo's list of products (the progress shows on it). */
  function batchOverview() {
    if (!read) return home();
    setStep({ s: "outcome", outcome: decideRead(read, null) });
  }

  /** The product on screen was added (or skipped): on to the next one, or the summary. */
  function continueBatch(how: "added" | "skipped") {
    if (!batch || !read) return;
    const { batch: settled, next } = settleBatch(batch, how);
    setBatch((b) => (b ? { ...b, total: settled.total, current: settled.current, added: settled.added, skipped: settled.skipped } : b));
    if (next === null) setStep({ s: "batchDone" });
    else route(read, next);
  }

  async function onPhoto(url: string, isDark: boolean, thumb: string | null) {
    setBatch(null);
    photoUsedRef.current = false;
    setDataUrl(url);
    setThumbDataUrl(thumb);
    setDark(isDark);
    setError(null);
    setStep({ s: "reading" });
    const r = await readPhoto(url, "add", thumb);
    if (!r.ok) {
      setError(errorCopy(r.error.status, r.error.body, "Couldn't read the photo. Enter it by hand, or try again."));
      setStep({ s: "home" });
      return;
    }
    setRead(r.data);
    route(r.data, null, url, thumb);
  }

  function route(result: ReadPhotoResult, chosen: number | null, url: string | null = dataUrl, thumb: string | null = thumbDataUrl) {
    const outcome = decideRead(result, chosen);
    const product = outcome.kind !== "status" && outcome.kind !== "pick-product" ? result.reading?.products[outcome.productIndex] ?? null : null;
    if (outcome.kind === "none") {
      setStep({ s: "new", seed: { product, photoId: photoUsedRef.current ? null : result.photoId, dataUrl: url, thumbDataUrl: thumb }, formKey: Date.now() });
      return;
    }
    if (outcome.kind === "exact") {
      setStep({ s: "going", found: { item: asMoveItem(outcome.item), matchedBy: matchedInWorkshop(outcome.candidate), packIdentifierId: outcome.candidate.evidence === "barcode" ? outcome.candidate.identifierId : null, product } });
      return;
    }
    setStep({ s: "outcome", outcome });
  }

  function savedNew(r: WriteResult, again: boolean, opts?: { label: boolean }) {
    setSession((s) => [...s, r]);
    setUndone(null);
    onSaved(r);
    // It was given one of our barcodes: print its label first, then carry on.
    if (opts?.label) {
      if (batch) {
        photoUsedRef.current = true;
        setBatch((b) => (b ? { ...b, results: [...b.results, r] } : b));
      }
      setStep({ s: "label", last: r, then: batch ? (again ? "batch" : "close") : again ? "setup" : "close" });
      return;
    }
    if (batch) {
      photoUsedRef.current = true;
      setBatch((b) => (b ? { ...b, results: [...b.results, r] } : b));
      if (!again) {
        onClose();
        return;
      }
      continueBatch("added");
      return;
    }
    if (!again) {
      // the list screen shows what was saved, with its Undo
      onClose();
      return;
    }
    fresh();
    setStep({ s: "setup", last: r });
  }

  function savedMove(r: WriteResult) {
    if (r.movement.kind !== "reversal") setSession((s) => [...s, r]);
    if (batch) {
      setBatch((b) =>
        !b ? b : r.movement.kind === "reversal" ? { ...b, results: b.results.filter((x) => x.movement.id !== r.movement.reversesMovementId) } : { ...b, results: [...b.results, r] },
      );
    }
    onSaved(r);
  }

  const n = session.length;
  const setupNote = n ? `Setting up · ${n} ${n === 1 ? "item" : "items"} so far` : null;
  const photoReading = capabilities.photoRead;

  const inBatch = Boolean(batch && read?.reading && batch.current >= 0);
  const batchProduct = inBatch ? read!.reading!.products[batch!.current] ?? null : null;
  const remaining = batch ? batch.total - batch.added.length - batch.skipped.length : 0;
  const lastOfBatch = remaining <= 1;
  const batchBanner = inBatch && batch && batchProduct ? (
    <Slot
      tone="inf"
      icon={Images}
      title={`From your photo · ${batch.current + 1} of ${batch.total}`}
      action={<MiniButton onClick={() => continueBatch("skipped")} data-testid="stock-batch-skip">Skip</MiniButton>}
      testId="stock-batch-banner"
    >
      {productLabel(batchProduct, batch.current)}
    </Slot>
  ) : null;
  const backFromStep = inBatch ? batchOverview : home;

  // ── home: find the item ──────────────────────────────────────────────────────
  if (step.s === "home") {
    const whenEmpty = (
      <>
        {error ? <Slot tone="bad" role="alert">{error}</Slot> : null}
        {dark && !error ? <Slot tone="warn">That photo looked dark — a brighter one reads better.</Slot> : null}
        {photoReading ? (
          <div className="flex min-h-[160px] flex-1 flex-col items-center justify-center rounded-2xl bg-accent-ink p-4 text-center">
            <Camera aria-hidden="true" className="mb-2 h-7 w-7 text-[#dfe6ee]" />
            <p className="max-w-[260px] text-sm font-medium leading-snug text-[#eef2f7]">Photograph the item or its box — label or product code in shot. If it&rsquo;s already listed, you add to it; if not, the label fills the form.</p>
          </div>
        ) : (
          <Slot tone="neu" title="Photo reading isn't set up">Search for the item above, or enter a new one by hand.</Slot>
        )}
      </>
    );
    return (
      <FlowSheet
        title="Add or return"
        direction="in"
        directionNote={setupNote}
        onClose={onClose}
        testId="stock-add-flow"
        footer={
          <>
            {photoReading ? <PhotoCapture variant="single" label={n ? "Take photo of the next item" : "Take photo of the item"} sub="label or code in shot · reads it for you" onPhoto={(u, d, t) => void onPhoto(u, d, t)} /> : null}
            <BigButton variant="ter" icon={<PencilLine aria-hidden="true" className="h-5 w-5" />} label="Enter a new item by hand" onClick={() => setStep({ s: "new", seed: { product: null, photoId: null, dataUrl: null }, formKey: Date.now() })} data-testid="stock-add-manual" />
            {n ? <BigButton variant="sec" label="Done for now" sub="back to the list · nothing waiting" onClick={onClose} data-testid="stock-add-done" /> : null}
          </>
        }
      >
        <ItemPicker items={items} onPick={(i) => setStep({ s: "going", found: { item: asMoveItem(i), matchedBy: null, packIdentifierId: null, product: null } })} whenEmpty={whenEmpty} />
      </FlowSheet>
    );
  }

  if (step.s === "reading") {
    return (
      <FlowSheet title="Add or return" direction="in" directionNote={setupNote} onClose={onClose} onBack={() => { fresh(); home(); }} testId="stock-add-flow" footer={<BigButton variant="sec" label="Search instead" onClick={() => { fresh(); home(); }} />}>
        <div className="flex flex-1 flex-col gap-3" role="status" data-testid="stock-reading">
          {dataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local preview
            <img src={dataUrl} alt="Your photo" className="min-h-[200px] w-full flex-1 rounded-[14px] border border-border object-cover" />
          ) : null}
          <Slot tone="inf" icon={Loader2} title="Reading the label… usually under 8 seconds">
            Nothing changes until you confirm. No need to tap again.
          </Slot>
        </div>
      </FlowSheet>
    );
  }

  if (step.s === "outcome") {
    return (
      <AddOutcome
        outcome={step.outcome}
        read={read}
        dataUrl={dataUrl}
        note={setupNote}
        onClose={onClose}
        onBack={inBatch && step.outcome.kind !== "pick-product" ? batchOverview : home}
        onProduct={(i) => {
          if (!read) return;
          if (batch) setBatch((b) => (b ? { ...b, ...focusBatch(b, i) } : b));
          route(read, i);
        }}
        batch={batch}
        banner={batchBanner}
        onAddAll={startAll}
        onFinishBatch={() => setStep({ s: "batchDone" })}
        onExisting={(item, matchedBy, packIdentifierId, product) => setStep({ s: "going", found: { item: asMoveItem(item), matchedBy, packIdentifierId, product } })}
        onNew={(product) => setStep({ s: "new", seed: newSeed(product), formKey: Date.now() })}
        onPhoto={(u, d, t) => void onPhoto(u, d, t)}
      />
    );
  }

  // ── already listed: what's going in? ─────────────────────────────────────────
  if (step.s === "going") {
    const f = step.found;
    return (
      <FlowSheet
        title="Add or return"
        direction="in"
        directionNote={setupNote}
        onClose={onClose}
        onBack={backFromStep}
        testId="stock-add-flow"
        footer={
          <>
            <BigButton variant="nav" label="Add to this item" sub="new stock bought · no new item" onClick={() => setStep({ s: "existing", found: f, kind: "add" })} data-testid="stock-going-add" />
            <BigButton variant="sec" label="Return to this item" sub="unused, back from a job" onClick={() => setStep({ s: "existing", found: f, kind: "return" })} data-testid="stock-going-return" />
            <BigButton variant="ter" label="It's a different product" sub="new item · this one is unchanged" onClick={() => setStep({ s: "new", seed: newSeed(f.product), formKey: Date.now() })} data-testid="stock-going-new" />
          </>
        }
      >
        {batchBanner}
        <div className="rounded-[14px] border border-border bg-surface p-3" data-testid="stock-outcome-existing">
          <div className="flex gap-3">
            <StockThumb photoId={f.item.photoId} alt="" size="lg" />
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold leading-tight text-text">{f.item.name}</p>
              {identityLine(f.item) ? <p className="mt-0.5 text-[13px] text-text-muted">{identityLine(f.item)}</p> : null}
              <p className="mt-1 text-[13px] font-semibold text-text">{f.item.location || "No shelf set"}</p>
            </div>
          </div>
          <p className="mt-2.5 inline-flex items-center gap-1.5 text-[13px] font-bold text-state-success">
            <Check aria-hidden="true" className="h-4 w-4" strokeWidth={3} />
            {f.matchedBy ?? "Found in the list"}
          </p>
        </div>
        <p className="text-sm font-medium text-text">Already listed — add to the existing item, no need for a new one.</p>
        <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2.5">
          <span className="text-[15px] font-semibold text-text-muted">Recorded on the shelf</span>
          <RecordedQuantity item={f.item} size="lg" />
        </div>
        <h3 className="mt-1 font-display text-[20px] font-bold text-brand-navy">What&rsquo;s going in?</h3>
      </FlowSheet>
    );
  }

  if (step.s === "existing") {
    const f = step.found;
    return (
      <FlowSheet title={step.kind === "add" ? "Add stock" : "Return stock"} direction={step.kind === "add" ? "in" : "return"} directionNote={setupNote} onClose={onClose} onBack={() => setStep({ s: "going", found: f })} testId="stock-add-flow">
        {batchBanner}
        <MoveConfirm
          key={`${f.item.id}-${step.kind}`}
          item={f.item}
          kind={step.kind}
          matchedBy={f.matchedBy}
          packIdentifierId={f.packIdentifierId}
          locationPhotoEnabled={capabilities.locationPhoto === true}
          onSaved={savedMove}
          onWrongItem={backFromStep}
          wrongItemLabel={inBatch ? "Wrong item? Back to the photo's list" : "Wrong item? Back to the search"}
          onAnother={inBatch ? () => continueBatch("added") : () => { fresh(); home(); }}
          anotherLabel={inBatch ? (lastOfBatch ? "See what was added" : "Next item from the photo") : step.kind === "add" ? "Add another item" : "Return another item"}
          anotherSub={inBatch ? (lastOfBatch ? "everything from this photo" : `${remaining - 1} more to go`) : "back to the camera and search"}
          onClose={onClose}
        />
      </FlowSheet>
    );
  }

  // ── set-up rhythm: receipt, the shelf filling up, the next photo ─────────────
  if (step.s === "label") {
    const { last, then } = step;
    const carryOn = () => {
      if (then === "close") onClose();
      else if (then === "batch") continueBatch("added");
      else { fresh(); setStep({ s: "setup", last }); }
    };
    return (
      <FlowSheet
        title="Barcode label"
        direction="in"
        onClose={onClose}
        testId="stock-add-label"
        footer={<BigButton variant="sec" label={then === "close" ? "Done" : "Next item"} sub="the item is saved · print the label any time from it" onClick={carryOn} data-testid="stock-add-label-next" />}
      >
        <StockReceipt result={last} undone={undone} onUndone={(r) => { setUndone(r); onSaved(r); }} undoTestId="stock-add-label-undo" />
        <BarcodeLabel item={last.item} />
      </FlowSheet>
    );
  }

  if (step.s === "setup") {
    const last = step.last;
    const { shelf } = splitLocation(last.item.location);
    const onShelf = shelf ? items.filter((i) => !i.archivedAt && splitLocation(i.location).shelf?.toLowerCase() === shelf.toLowerCase() && i.id !== last.item.id).slice(-5) : [];
    const byShelf = new Map<string, number>();
    for (const r of session) {
      const s = splitLocation(r.item.location).shelf ?? "No shelf";
      byShelf.set(s, (byShelf.get(s) ?? 0) + 1);
    }
    const first = session[0]?.movement.createdAt;
    const mins = first ? Math.max(1, Math.round((Date.now() - Date.parse(first)) / 60_000)) : null;
    return (
      <FlowSheet
        title="Add stock"
        direction="in"
        directionNote={setupNote}
        onClose={onClose}
        testId="stock-add-flow"
        footer={
          <>
            {photoReading ? <PhotoCapture variant="single" label="Take photo of the next item" onPhoto={(u, d, t) => void onPhoto(u, d, t)} /> : <BigButton variant="pri" label="Enter the next item by hand" onClick={() => setStep({ s: "new", seed: { product: null, photoId: null, dataUrl: null }, formKey: Date.now() })} />}
            <BigButton variant="ter" label="Done for now · back to the list" sub="everything above is saved · nothing waiting" onClick={onClose} data-testid="stock-add-done" />
          </>
        }
      >
        <div data-testid="stock-add-saved">
          <StockReceipt
            result={last}
            undone={undone}
            onUndone={(r) => { setUndone(r); onSaved(r); }}
            note={last.photoAttached === false || last.locationPhotoAttached === false ? (
              <span data-testid="stock-add-photo-missing">
                {last.photoAttached === false ? "The photo couldn’t be attached — the office can add one later." : "The photo of where it lives couldn’t be attached — add it from the item."}
              </span>
            ) : null}
            undoTestId="stock-add-undo"
          />
        </div>
        {shelf ? (
          <div className="flex items-center gap-2 overflow-x-auto rounded-xl border border-border bg-surface-subtle px-3 py-2">
            <span className="shrink-0 font-mono text-[12px] font-bold uppercase tracking-[0.1em] text-text">{shelf}</span>
            {onShelf.map((i) => (
              <span key={i.id} className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-text">
                <StockThumb photoId={i.photoId} alt="" size="sm" />
                <span className="max-w-[90px] truncate">{i.name}</span>
              </span>
            ))}
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-bold text-text">
              <StockThumb photoId={undone ? undone.item.photoId : last.item.photoId} alt="" size="sm" className="ring-2 ring-accent-yellow" />
              <span className="max-w-[110px] truncate">{last.item.name}</span>
            </span>
          </div>
        ) : null}
        {n > 1 ? (
          <p className="text-[13px] font-medium text-text">
            This session: {[...byShelf.entries()].map(([s, c]) => `${s} · ${c}`).join(" · ")} — {n} items{mins ? ` in ${mins} ${mins === 1 ? "minute" : "minutes"}` : ""}
          </p>
        ) : null}
        {photoReading ? (
          <div className="flex min-h-[140px] flex-1 items-center justify-center rounded-2xl bg-accent-ink p-4">
            <p className="flex h-[96px] w-[220px] items-center justify-center rounded-xl border-2 border-dashed border-white/60 p-3 text-center text-sm font-medium text-[#dfe6ee]">Next item · label or code inside this box</p>
          </div>
        ) : null}
        <LinkButton onClick={() => { home(); }}>Or search for an item that&rsquo;s already listed</LinkButton>
      </FlowSheet>
    );
  }

  // ── several from one photo: what was added ──────────────────────────────────
  if (step.s === "batchDone") {
    return <BatchSummary batch={batch} photoReading={photoReading} note={setupNote} onPhoto={(u, d, t) => void onPhoto(u, d, t)} onUndone={onSaved} onReview={batchOverview} onClose={onClose} />;
  }

  // ── a new item ───────────────────────────────────────────────────────────────
  return (
    <FlowSheet title="Add stock" direction="in" directionNote={setupNote ?? "New item · not listed yet"} onClose={onClose} onBack={inBatch ? batchOverview : () => { fresh(); home(); }} testId="stock-add-flow" bodyClassName="gap-0 pb-0">
      {batchBanner ? <div className="mb-3">{batchBanner}</div> : null}
      <NewItemForm
        key={step.formKey}
        seed={step.seed}
        items={items}
        lookupEnabled={capabilities.lookup}
        locationPhotoEnabled={capabilities.locationPhoto === true}
        typesEnabled={capabilities.types === true}
        defaultLocation={lastLocation}
        lastLocationPhoto={lastLocationPhoto}
        emphasis="another"
        anotherLabel={inBatch ? (lastOfBatch ? "Save · last one from the photo" : "Save · next from the photo") : undefined}
        anotherSub={inBatch ? (lastOfBatch ? "then see what was added" : `${remaining - 1} more to go`) : undefined}
        onSaved={savedNew}
        onUseExisting={(item) => setStep({ s: "existing", found: { item: asMoveItem(item), matchedBy: "Matched in workshop · same code", packIdentifierId: null, product: step.seed.product }, kind: "add" })}
      />
    </FlowSheet>
  );
}

export function AddOutcome({
  outcome,
  read,
  dataUrl,
  note,
  onClose,
  onBack,
  onProduct,
  onExisting,
  onNew,
  onPhoto,
  batch = null,
  banner = null,
  onAddAll,
  onFinishBatch,
}: {
  outcome: ReadOutcome;
  read: ReadPhotoResult | null;
  dataUrl: string | null;
  note: ReactNode;
  onClose: () => void;
  onBack: () => void;
  onProduct: (i: number) => void;
  onExisting: (item: CandidateItem, matchedBy: string | null, packIdentifierId: string | null, product: ReadProduct | null) => void;
  onNew: (product: ReadProduct | null) => void;
  onPhoto: (dataUrl: string, dark: boolean, thumb: string | null) => void;
  /** several from one photo: progress, the banner for a product's own screen, and the two batch actions */
  batch?: PhotoBatch | null;
  banner?: ReactNode;
  onAddAll?: () => void;
  onFinishBatch?: () => void;
}) {
  const product = outcome.kind !== "status" && outcome.kind !== "pick-product" ? read?.reading?.products[outcome.productIndex] ?? null : null;
  const [chosen, setChosen] = useState<string | null>(outcome.kind === "candidates" ? outcome.candidates[0]?.item.id ?? null : null);
  const frame = (footer: ReactNode, children: ReactNode) => (
    <FlowSheet title="Add or return" direction="in" directionNote={note} onClose={onClose} onBack={onBack} testId="stock-add-flow" footer={footer}>
      {children}
    </FlowSheet>
  );

  if (outcome.kind === "status") {
    const copy = READ_STATUS_COPY[outcome.status];
    const warn = outcome.status === "unreadable" || outcome.status === "unavailable";
    return frame(
      <>
        <BigButton variant="pri" icon={<PencilLine aria-hidden="true" className="h-5 w-5" />} label="Enter it by hand" sub="the photo is kept for the item" onClick={() => onNew(null)} data-testid="stock-outcome-manual" />
        <PhotoCapture variant="single" tone="ter" label={outcome.status === "unreadable" ? "Closer photo of the label" : "Try the photo again"} onPhoto={onPhoto} />
      </>,
      <>
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local preview
          <img src={dataUrl} alt="Your photo" className="h-[180px] w-full rounded-[14px] border border-border object-cover" />
        ) : null}
        <Slot tone={warn ? "warn" : "neu"} icon={outcome.status === "unreadable" ? Camera : undefined} title={copy.title} testId="stock-outcome-status" data-status={outcome.status}>
          {read?.reading?.note || "Enter it by hand — the photo is kept for the item."}
        </Slot>
      </>,
    );
  }

  if (outcome.kind === "pick-product") {
    const n = outcome.products.length;
    const settled = (i: number) => (batch?.added.includes(i) ? "added" : batch?.skipped.includes(i) ? "skipped" : null);
    const left = batch ? n - batch.added.length - batch.skipped.length : n;
    return frame(
      batch ? (
        <>
          {left > 0 && batch.current >= 0 ? (
            <BigButton variant="pri" label={`Carry on · item ${batch.current + 1} of ${n}`} sub={`${left} still to add or skip`} onClick={() => onProduct(batch.current)} data-testid="stock-batch-carry-on" />
          ) : null}
          <BigButton variant={left > 0 ? "ter" : "pri"} label={left > 0 ? "Stop here · see what was added" : "See what was added"} onClick={onFinishBatch} data-testid="stock-batch-finish" />
        </>
      ) : (
        <>
          <BigButton variant="pri" icon={<Images aria-hidden="true" className="h-5 w-5" />} label={`Add all ${n} from this photo`} sub="one at a time · nothing is saved until you confirm each" onClick={onAddAll} data-testid="stock-batch-start" />
          <PhotoCapture variant="single" tone="ter" label="Closer photo of one label" onPhoto={onPhoto} />
        </>
      ),
      <div className="space-y-3" data-testid="stock-outcome-products">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local preview
          <img src={dataUrl} alt="Your photo" className="h-[200px] w-full rounded-[14px] border border-border object-cover" />
        ) : null}
        <div>
          <h3 className="font-display text-[20px] font-bold leading-tight text-brand-navy">
            {batch ? "From your photo" : `There are ${n} products in the photo`}
          </h3>
          <p className="mt-1 text-sm text-text-muted">{batch ? "Tap one to add it now, or carry on in order." : "Add them all one after another, or tap the one you're adding. Nothing is saved yet."}</p>
        </div>
        <ul className="space-y-2">
          {outcome.products.map((p, i) => {
            const st = settled(i);
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onProduct(i)}
                  className={cn("flex min-h-[56px] w-full items-center gap-3 rounded-[14px] border bg-surface px-3 py-2 text-left hover:border-brand-navy", batch && batch.current === i ? "border-2 border-brand-navy" : "border-border")}
                  data-testid="stock-outcome-product"
                  data-state={st ?? "open"}
                >
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-yellow font-display text-sm font-bold text-brand-navy">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-base font-semibold", st ? "text-text-muted" : "text-text")}>{productLabel(p, i)}</span>
                    {p.manufacturerCode || p.colourFinish ? <span className="block truncate text-[13px] text-text-muted">{[p.brand, p.manufacturerCode, p.colourFinish].filter(Boolean).join(" · ")}</span> : null}
                  </span>
                  {st === "added" ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-bold text-state-success"><Check aria-hidden="true" className="h-4 w-4" strokeWidth={3} />Added</span>
                  ) : st === "skipped" ? (
                    <span className="shrink-0 text-[13px] font-semibold text-text-muted">Skipped</span>
                  ) : (
                    <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>,
    );
  }

  if (outcome.kind === "candidates") {
    const picked = outcome.candidates.find((c) => c.item.id === chosen) ?? null;
    return frame(
      <>
        <BigButton variant="nav" label="Add or return to this one" sub={picked ? `${picked.item.name} · next: what's going in` : "pick one above first"} disabled={!picked} onClick={() => picked && onExisting(picked.item, `Picked by you · ${EVIDENCE_LABEL[picked.candidate.evidence] ?? ""}`.replace(/ · $/, ""), null, product)} data-testid="stock-candidate-continue" />
        <BigButton variant="ter" label="None of these — it's new" onClick={() => onNew(product)} data-testid="stock-none-of-these" />
      </>,
      <div className="space-y-3" data-testid="stock-outcome-candidates">
        {banner}
        <div className="flex items-center gap-3">
          {dataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local preview
            <img src={dataUrl} alt="Your photo" className="h-14 w-14 shrink-0 rounded-[10px] border border-border object-cover" />
          ) : null}
          <div>
            <h3 className="font-display text-[20px] font-bold leading-tight text-brand-navy">Is it one of these already in the workshop?</h3>
            <p className="mt-0.5 text-sm text-text-muted">Pick the one in your hand. Nothing is saved yet.</p>
          </div>
        </div>
        <ul className="space-y-2" role="radiogroup" aria-label="Which item">
          {outcome.candidates.map(({ candidate, item }) => {
            const on = item.id === chosen;
            const why = [EVIDENCE_LABEL[candidate.evidence], ...candidate.conflicts.map((c) => `${c.field} differs`)].filter(Boolean).join(" · ");
            return (
              <li key={item.id}>
                <button type="button" role="radio" aria-checked={on} onClick={() => setChosen(item.id)} className={cn("flex w-full items-start gap-3 rounded-[14px] border-2 bg-surface p-3 text-left", on ? "border-brand-navy bg-surface-subtle" : "border-border")} data-testid="stock-candidate" data-item-id={item.id}>
                  <span aria-hidden="true" className={cn("mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2", on ? "border-brand-navy" : "border-border-strong")}>
                    {on ? <span className="h-2.5 w-2.5 rounded-full bg-brand-navy" /> : null}
                  </span>
                  <StockThumb photoId={item.photoId} alt="" size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-semibold leading-tight text-text">{item.name}</span>
                    {identityLine(item) ? <span className="block text-[13px] text-text-muted">{identityLine(item)}</span> : null}
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] text-text">
                      {item.location ? <span>{item.location} ·</span> : null}
                      {item.balanceMilli === 0 ? <NoneRecorded /> : <span className="font-semibold">{balanceLabel(item)}</span>}
                    </span>
                    {why ? <span className="mt-0.5 block text-xs font-semibold text-state-warning">{why}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>,
    );
  }

  return null;
}

/**
 * Several from one photo: what was added, each with its own Undo while the
 * server allows it, and the way on — the next photo, or done.
 */
function BatchSummary({
  batch,
  photoReading,
  note,
  onPhoto,
  onUndone,
  onReview,
  onClose,
}: {
  batch: Batch | null;
  photoReading: boolean;
  note: ReactNode;
  onPhoto: (dataUrl: string, dark: boolean, thumb: string | null) => void;
  onUndone: (r: WriteResult) => void;
  onReview: () => void;
  onClose: () => void;
}) {
  const [undoneIds, setUndoneIds] = useState<Set<string>>(() => new Set());
  const results = batch?.results ?? [];
  const live = results.filter((r) => !undoneIds.has(r.movement.id));
  const skipped = batch?.skipped.length ?? 0;
  return (
    <FlowSheet
      title="Add stock"
      direction="in"
      directionNote={note}
      onClose={onClose}
      onBack={onReview}
      testId="stock-add-flow"
      footer={
        <>
          {photoReading ? <PhotoCapture variant="single" label="Take photo of the next lot" sub="one item or several" onPhoto={onPhoto} /> : null}
          <BigButton variant="sec" label="Done" sub="back to the list" onClick={onClose} data-testid="stock-batch-done" />
        </>
      }
    >
      <Slot tone={live.length ? "ok" : "neu"} title={live.length ? `Added from one photo · ${live.length} ${live.length === 1 ? "item" : "items"}` : "Nothing was added from this photo"} testId="stock-batch-summary">
        {skipped ? <p>{skipped} skipped — tap Back to add {skipped === 1 ? "it" : "them"} after all.</p> : null}
      </Slot>
      <ul className="divide-y divide-border rounded-[14px] border border-border" data-testid="stock-batch-results">
        {results.map((r) => {
          const gone = undoneIds.has(r.movement.id);
          return (
            <li key={r.movement.id} className="flex items-start gap-3 p-3">
              <StockThumb photoId={r.item.photoId} alt="" size="md" />
              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-[15px] font-semibold", gone ? "text-text-muted line-through" : "text-text")}>{r.item.name}</p>
                <p className="text-[13px] text-text-muted">{gone ? "Undone" : `${movementSummary(r.movement, r.item.baseUnit)} · ${recordedNow(r.item)}`}</p>
                {r.photoAttached === false || r.locationPhotoAttached === false ? <p className="text-[13px] text-text-muted">A photo couldn&rsquo;t be attached — the office can add one.</p> : null}
              </div>
              {!gone ? (
                <UndoControl
                  movement={r.movement}
                  size="mini"
                  label={undoLabelFor(r.movement.kind)}
                  onUndone={(u) => { setUndoneIds((s) => new Set(s).add(r.movement.id)); onUndone(u); }}
                  testId="stock-batch-undo"
                />
              ) : null}
            </li>
          );
        })}
        {!results.length ? <li className="p-3 text-sm text-text-muted">Every product was skipped.</li> : null}
      </ul>
    </FlowSheet>
  );
}
