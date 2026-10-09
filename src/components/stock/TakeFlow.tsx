"use client";

import { useState } from "react";
import { Loader2, PackagePlus, Search } from "lucide-react";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { readPhoto } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, EVIDENCE_LABEL, matchedInWorkshop, READ_STATUS_COPY } from "@/domains/workshop-stock/format";
import { decideRead, productLabel, type ReadOutcome } from "@/domains/workshop-stock/flow";
import type { CandidateItem, MatchCandidate, ReadPhotoResult, ReadProduct, StockItem, WriteResult } from "@/domains/workshop-stock/schema";
import { FlowSheet } from "./FlowSheet";
import { ItemPicker } from "./ItemPicker";
import { MoveConfirm, type MoveItem } from "./MoveConfirm";
import { PhotoCapture } from "./PhotoCapture";
import { StockItemRow } from "./StockItemRow";

type Step =
  | { s: "photo" }
  | { s: "reading" }
  | { s: "outcome"; outcome: ReadOutcome }
  | { s: "search" }
  | { s: "confirm"; item: MoveItem; matchedBy: string | null; packIdentifierId: string | null };

const GUIDANCE = "Photograph the item. Include the label or product code if you can.";

/**
 * "Take stock" — the repeat-use flow (Workshop Stock).
 *
 *   photo → read the label → identify OUR item → confirm item + quantity → save
 *
 * The photo and the reading never change stock; only "Confirm take" does. A
 * code or barcode can suggest ONE item; anything weaker is a short list to pick
 * from. Several products in the photo → "which one?". Nothing recognised →
 * search, a closer photo, or an explicit "add it as new stock" — never an
 * automatic new item with imaginary stock.
 */
export function TakeFlow({
  items,
  kind = "take",
  photoReading,
  onSaved,
  onAddNew,
  onClose,
}: {
  items: StockItem[];
  kind?: "take" | "return";
  photoReading: boolean;
  onSaved: (r: WriteResult) => void;
  onAddNew: (seed: { dataUrl: string | null; product: ReadProduct | null }) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(photoReading && kind === "take" ? { s: "photo" } : { s: "search" });
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const [read, setRead] = useState<ReadPhotoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const title = kind === "take" ? "Take stock" : "Return unused stock";

  function asMoveItem(c: CandidateItem | StockItem): MoveItem {
    const full = items.find((i) => i.id === c.id);
    return { ...(full ?? c), identifiers: (full ?? c).identifiers } as MoveItem;
  }

  async function onPhoto(url: string, isDark: boolean) {
    setDataUrl(url);
    setDark(isDark);
    setError(null);
    setStep({ s: "reading" });
    const r = await readPhoto(url, "take");
    if (!r.ok) {
      setError(errorCopy(r.error.status, r.error.body, "Couldn't read the photo. Search instead, or try again."));
      setStep({ s: "photo" });
      return;
    }
    setRead(r.data);
    route(r.data, null);
  }

  function route(result: ReadPhotoResult, chosen: number | null) {
    const outcome = decideRead(result, chosen);
    if (outcome.kind === "exact") {
      setStep({
        s: "confirm",
        item: asMoveItem(outcome.item),
        matchedBy: matchedInWorkshop(outcome.candidate),
        packIdentifierId: outcome.candidate.evidence === "barcode" ? outcome.candidate.identifierId : null,
      });
      return;
    }
    setStep({ s: "outcome", outcome });
  }

  function pickCandidate(c: MatchCandidate, item: CandidateItem) {
    setStep({ s: "confirm", item: asMoveItem(item), matchedBy: `Picked by you · ${EVIDENCE_LABEL[c.evidence] ?? ""}`.replace(/ · $/, ""), packIdentifierId: null });
  }

  const back = step.s === "confirm" || step.s === "search" || step.s === "outcome" ? () => { setError(null); setStep(photoReading && kind === "take" ? { s: "photo" } : { s: "search" }); } : null;

  return (
    <FlowSheet title={title} onClose={onClose} onBack={back} testId={`stock-${kind}-flow`}>
      {step.s === "photo" ? (
        <>
          <PhotoCapture guidance={GUIDANCE} onPhoto={(u, d) => void onPhoto(u, d)} previewUrl={dataUrl} />
          {dark ? <PhilNotice tone="warning">That photo looks dark — a brighter one reads better.</PhilNotice> : null}
          {error ? <PhilNotice tone="danger" role="alert">{error}</PhilNotice> : null}
          <button type="button" onClick={() => setStep({ s: "search" })} className="flex min-h-[56px] w-full items-center justify-center gap-2 rounded-card border border-border-strong font-semibold text-text" data-testid="stock-take-search">
            <Search aria-hidden="true" className="h-5 w-5" /> Search the list instead
          </button>
        </>
      ) : null}

      {step.s === "reading" ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center" role="status" data-testid="stock-reading">
          {/* eslint-disable-next-line @next/next/no-img-element -- local preview */}
          {dataUrl ? <img src={dataUrl} alt="Your photo" className="h-32 w-32 rounded-card border border-border object-cover" /> : null}
          <Loader2 aria-hidden="true" className="h-6 w-6 animate-spin text-text-muted" />
          <p className="text-sm text-text">Reading the label… this can take up to 20 seconds.</p>
          <p className="text-xs text-text-muted">Nothing changes until you confirm.</p>
        </div>
      ) : null}

      {step.s === "outcome" ? (
        <OutcomeView
          outcome={step.outcome}
          read={read}
          onProduct={(i) => read && route(read, i)}
          onPick={pickCandidate}
          onSearch={() => setStep({ s: "search" })}
          onRetake={() => setStep({ s: "photo" })}
          onAddNew={() => {
            const p = read && read.reading && step.outcome.kind !== "status" && step.outcome.kind !== "pick-product" ? read.reading.products[step.outcome.productIndex] ?? null : null;
            onAddNew({ dataUrl, product: p });
          }}
        />
      ) : null}

      {step.s === "search" ? (
        <>
          {!photoReading && kind === "take" ? <PhilNotice tone="info">Photo reading isn&rsquo;t set up — find the item in the list.</PhilNotice> : null}
          <ItemPicker items={items} onPick={(i) => setStep({ s: "confirm", item: asMoveItem(i), matchedBy: null, packIdentifierId: null })} />
        </>
      ) : null}

      {step.s === "confirm" ? (
        <MoveConfirm
          key={step.item.id}
          item={step.item}
          kind={kind}
          matchedBy={step.matchedBy}
          packIdentifierId={step.packIdentifierId}
          onSaved={onSaved}
          onAnother={() => { setDataUrl(null); setRead(null); setStep(photoReading && kind === "take" ? { s: "photo" } : { s: "search" }); }}
          onClose={onClose}
        />
      ) : null}
    </FlowSheet>
  );
}

function OutcomeView({
  outcome,
  read,
  onProduct,
  onPick,
  onSearch,
  onRetake,
  onAddNew,
}: {
  outcome: ReadOutcome;
  read: ReadPhotoResult | null;
  onProduct: (i: number) => void;
  onPick: (c: MatchCandidate, item: CandidateItem) => void;
  onSearch: () => void;
  onRetake: () => void;
  onAddNew: () => void;
}) {
  const actions = (
    <div className="grid grid-cols-2 gap-2">
      <button type="button" onClick={onSearch} className="min-h-[56px] rounded-card border border-border-strong px-3 font-semibold text-text" data-testid="stock-outcome-search">Search the list</button>
      <button type="button" onClick={onRetake} className="min-h-[56px] rounded-card border border-border-strong px-3 font-semibold text-text" data-testid="stock-outcome-retake">Closer photo of the label</button>
    </div>
  );
  if (outcome.kind === "status") {
    const copy = READ_STATUS_COPY[outcome.status];
    return (
      <div className="space-y-3" data-testid="stock-outcome-status" data-status={outcome.status}>
        <PhilNotice tone="warning" title={copy.title}>{read?.reading?.note || copy.body}</PhilNotice>
        {actions}
      </div>
    );
  }
  if (outcome.kind === "pick-product") {
    return (
      <div className="space-y-3" data-testid="stock-outcome-products">
        <p className="font-display text-base font-semibold text-text">There&rsquo;s more than one product in the photo. Which one?</p>
        <ul className="space-y-2">
          {outcome.products.map((p, i) => (
            <li key={i}>
              <button type="button" onClick={() => onProduct(i)} className="flex min-h-[56px] w-full items-center rounded-card border border-border bg-surface-raised px-3 text-left text-sm font-semibold text-text hover:border-brand-navy" data-testid="stock-outcome-product">
                {productLabel(p, i)}
                {p.manufacturerCode ? <span className="ml-2 font-mono text-xs text-text-muted">{p.manufacturerCode}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {actions}
      </div>
    );
  }
  if (outcome.kind === "none") {
    return (
      <div className="space-y-3" data-testid="stock-outcome-none">
        <PhilNotice tone="info" title={"This item isn't in the workshop list"}>
          Search for it, take a closer photo of the label — or add it as new stock if it really isn&rsquo;t recorded.
        </PhilNotice>
        {actions}
        <button type="button" onClick={onAddNew} className="flex min-h-[56px] w-full items-center justify-center gap-2 rounded-card border border-border-strong font-semibold text-text" data-testid="stock-outcome-add-new">
          <PackagePlus aria-hidden="true" className="h-5 w-5" /> Add it as new stock
        </button>
      </div>
    );
  }
  if (outcome.kind === "candidates") {
    return (
      <div className="space-y-3" data-testid="stock-outcome-candidates">
        <p className="font-display text-base font-semibold text-text">Is it one of these?</p>
        <p className="text-sm text-text-muted">Check the code on the item — similar products look alike.</p>
        <ul className="space-y-2">
          {outcome.candidates.map(({ candidate, item }) => (
            <li key={item.id}>
              <StockItemRow
                item={{ ...item, archivedAt: null }}
                onClick={() => onPick(candidate, item)}
                hint={[EVIDENCE_LABEL[candidate.evidence], ...candidate.conflicts.map((c) => (c.field === "colour" ? "colour differs" : c.field === "brand" ? "brand differs" : c.field === "rating" ? "rating differs" : `${c.field} differs`))].filter(Boolean).join(" · ")}
                testId="stock-candidate"
              />
              <p className="sr-only">Recorded {balanceLabel(item)}</p>
            </li>
          ))}
        </ul>
        {actions}
      </div>
    );
  }
  return null;
}
