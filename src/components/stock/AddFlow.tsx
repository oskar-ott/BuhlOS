"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Camera, Check, ChevronRight, Loader2, PencilLine } from "lucide-react";
import { cn } from "@/lib/cn";
import { readPhoto } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, EVIDENCE_LABEL, identityLine, matchedInWorkshop, READ_STATUS_COPY } from "@/domains/workshop-stock/format";
import { decideRead, freshestItem, productLabel, type ReadOutcome } from "@/domains/workshop-stock/flow";
import { splitLocation } from "@/domains/workshop-stock/location";
import type { CandidateItem, ReadPhotoResult, ReadProduct, StockItem, WriteResult } from "@/domains/workshop-stock/schema";
import { FlowSheet } from "./FlowSheet";
import { ItemPicker } from "./ItemPicker";
import { MoveConfirm, type MoveItem } from "./MoveConfirm";
import { NewItemForm, type NewItemSeed } from "./NewItemForm";
import { PhotoCapture } from "./PhotoCapture";
import { NoneRecorded, RecordedQuantity } from "./StockItemRow";
import { StockReceipt } from "./StockReceipt";
import { StockThumb } from "./StockThumb";
import { BigButton, LinkButton, Slot } from "./ui";

type Found = { item: MoveItem; matchedBy: string | null; packIdentifierId: string | null; product: ReadProduct | null };

type Step =
  | { s: "home" }
  | { s: "reading" }
  | { s: "outcome"; outcome: ReadOutcome }
  | { s: "going"; found: Found }
  | { s: "existing"; found: Found; kind: "add" | "return" }
  | { s: "new"; seed: NewItemSeed; formKey: number }
  | { s: "setup"; last: WriteResult };

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
  capabilities: { photoRead: boolean; lookup: boolean; locationPhoto?: boolean };
  seed?: { dataUrl: string | null; thumbDataUrl?: string | null; product: ReadProduct | null } | null;
  onSaved: (r: WriteResult) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(() => (seed ? { s: "new", seed: { product: seed.product, photoId: null, dataUrl: seed.dataUrl, thumbDataUrl: seed.thumbDataUrl ?? null }, formKey: 1 } : { s: "home" }));
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [thumbDataUrl, setThumbDataUrl] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const [read, setRead] = useState<ReadPhotoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<WriteResult[]>([]);
  const [undone, setUndone] = useState<WriteResult | null>(null);
  const lastLocation = useMemo(() => [...session].reverse().find((r) => r.item.location)?.item.location ?? null, [session]);

  // The list's copy or the one the photo read just returned, whichever is newer
  // (the confirm screen re-reads it from the server either way).
  function asMoveItem(c: CandidateItem | StockItem): MoveItem {
    const pick = freshestItem<CandidateItem | StockItem>(items.find((i) => i.id === c.id), c);
    return { ...pick, identifiers: pick.identifiers } as MoveItem;
  }

  function newSeed(product: ReadProduct | null): NewItemSeed {
    return { product, photoId: read?.photoId ?? null, dataUrl, thumbDataUrl };
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
  }

  async function onPhoto(url: string, isDark: boolean, thumb: string | null) {
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
      setStep({ s: "new", seed: { product, photoId: result.photoId, dataUrl: url, thumbDataUrl: thumb }, formKey: Date.now() });
      return;
    }
    if (outcome.kind === "exact") {
      setStep({ s: "going", found: { item: asMoveItem(outcome.item), matchedBy: matchedInWorkshop(outcome.candidate), packIdentifierId: outcome.candidate.evidence === "barcode" ? outcome.candidate.identifierId : null, product } });
      return;
    }
    setStep({ s: "outcome", outcome });
  }

  function savedNew(r: WriteResult, again: boolean) {
    setSession((s) => [...s, r]);
    setUndone(null);
    onSaved(r);
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
    onSaved(r);
  }

  const n = session.length;
  const setupNote = n ? `Setting up · ${n} ${n === 1 ? "item" : "items"} so far` : null;
  const photoReading = capabilities.photoRead;

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
        onBack={home}
        onProduct={(i) => read && route(read, i)}
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
        onBack={home}
        testId="stock-add-flow"
        footer={
          <>
            <BigButton variant="nav" label="Add to this item" sub="new stock bought · no new item" onClick={() => setStep({ s: "existing", found: f, kind: "add" })} data-testid="stock-going-add" />
            <BigButton variant="sec" label="Return to this item" sub="unused, back from a job" onClick={() => setStep({ s: "existing", found: f, kind: "return" })} data-testid="stock-going-return" />
            <BigButton variant="ter" label="It's a different product" sub="new item · this one is unchanged" onClick={() => setStep({ s: "new", seed: newSeed(f.product), formKey: Date.now() })} data-testid="stock-going-new" />
          </>
        }
      >
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
        <MoveConfirm
          key={`${f.item.id}-${step.kind}`}
          item={f.item}
          kind={step.kind}
          matchedBy={f.matchedBy}
          packIdentifierId={f.packIdentifierId}
          onSaved={savedMove}
          onWrongItem={home}
          wrongItemLabel="Wrong item? Back to the search"
          onAnother={() => { fresh(); home(); }}
          anotherLabel={step.kind === "add" ? "Add another item" : "Return another item"}
          anotherSub="back to the camera and search"
          onClose={onClose}
        />
      </FlowSheet>
    );
  }

  // ── set-up rhythm: receipt, the shelf filling up, the next photo ─────────────
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
          <StockReceipt result={last} undone={undone} onUndone={(r) => { setUndone(r); onSaved(r); }} note={last.photoAttached === false ? <span data-testid="stock-add-photo-missing">The photo couldn&rsquo;t be attached — the office can add one later.</span> : null} undoTestId="stock-add-undo" />
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

  // ── a new item ───────────────────────────────────────────────────────────────
  return (
    <FlowSheet title="Add stock" direction="in" directionNote={setupNote ?? "New item · not listed yet"} onClose={onClose} onBack={() => { fresh(); home(); }} testId="stock-add-flow" bodyClassName="gap-0 pb-0">
      <NewItemForm
        key={step.formKey}
        seed={step.seed}
        items={items}
        lookupEnabled={capabilities.lookup}
        locationPhotoEnabled={capabilities.locationPhoto === true}
        defaultLocation={lastLocation}
        emphasis="another"
        onSaved={savedNew}
        onUseExisting={(item) => setStep({ s: "existing", found: { item: asMoveItem(item), matchedBy: "Matched in workshop · same code", packIdentifierId: null, product: step.seed.product }, kind: "add" })}
      />
    </FlowSheet>
  );
}

function AddOutcome({
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
    return frame(
      <PhotoCapture variant="single" tone="ter" label="Neither · closer photo of one label" onPhoto={onPhoto} />,
      <div className="space-y-3" data-testid="stock-outcome-products">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local preview
          <img src={dataUrl} alt="Your photo" className="h-[200px] w-full rounded-[14px] border border-border object-cover" />
        ) : null}
        <div>
          <h3 className="font-display text-[20px] font-bold leading-tight text-brand-navy">There&rsquo;s more than one product in the photo. Which one are you adding?</h3>
          <p className="mt-1 text-sm text-text-muted">Nothing is saved yet.</p>
        </div>
        <ul className="space-y-2">
          {outcome.products.map((p, i) => (
            <li key={i}>
              <button type="button" onClick={() => onProduct(i)} className="flex min-h-[56px] w-full items-center gap-3 rounded-[14px] border border-border bg-surface px-3 py-2 text-left hover:border-brand-navy" data-testid="stock-outcome-product">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-yellow font-display text-sm font-bold text-brand-navy">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-base font-semibold text-text">{productLabel(p, i)}</span>
                <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
              </button>
            </li>
          ))}
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
