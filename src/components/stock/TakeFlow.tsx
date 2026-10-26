"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Check, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { findByBarcode } from "@/domains/workshop-stock/barcode";
import { readPhoto } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, EVIDENCE_LABEL, identityLine, matchedInWorkshop, movementSummary, READ_STATUS_COPY } from "@/domains/workshop-stock/format";
import { decideRead, freshestItem, productLabel, type ReadOutcome } from "@/domains/workshop-stock/flow";
import { splitLocation } from "@/domains/workshop-stock/location";
import { oftenTaken, rememberTaken } from "@/domains/workshop-stock/often";
import type { CandidateItem, MatchCandidate, ReadPhotoResult, ReadProduct, StockItem, WriteResult } from "@/domains/workshop-stock/schema";
import { FlowSheet } from "./FlowSheet";
import { ItemPicker } from "./ItemPicker";
import { LiveCodeScanner, liveReadingSupported, SCANNER_COPY, type ScannerState } from "./LiveCodeScanner";
import { MoveConfirm, type MoveItem } from "./MoveConfirm";
import { PhotoCapture } from "./PhotoCapture";
import { NoneRecorded, RecordedQuantity } from "./StockItemRow";
import { StockThumb } from "./StockThumb";
import { BigButton, Kicker, LinkButton, Slot } from "./ui";

type Step =
  | { s: "home" }
  | { s: "reading" }
  | { s: "outcome"; outcome: ReadOutcome }
  | { s: "confirm"; item: MoveItem; matchedBy: string | null; packIdentifierId: string | null };

type Hit = { raw: string; item: StockItem; identifierId: string; packSizeMilli: number | null };

const HOLD_STEADY_MS = 900;
const SLOW_READ_MS = 10_000;

/**
 * "Take stock" — the repeat-use flow (Workshop Stock). One screen with three
 * ways in: live code reading (the phone's camera, ~1–2 s, no shutter), search,
 * and "You often take". The label photo is the backup when there is no code.
 * Every route ends at the same confirmation; only its named button writes
 * stock. After a receipt: Take another item (the round so far stays visible)
 * or Done.
 *
 * A code found live is matched against the list already on the phone, so it
 * works with no signal; saving still needs the office to answer.
 */
export function TakeFlow({
  items,
  viewerId,
  photoReading,
  onSaved,
  onAddNew,
  onClose,
}: {
  items: StockItem[];
  viewerId: string | null;
  photoReading: boolean;
  onSaved: (r: WriteResult) => void;
  onAddNew: (seed: { dataUrl: string | null; thumbDataUrl: string | null; product: ReadProduct | null }) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ s: "home" });
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [thumbDataUrl, setThumbDataUrl] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const [read, setRead] = useState<ReadPhotoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState<WriteResult[]>([]);
  const [hit, setHit] = useState<Hit | null>(null);
  const [unmatched, setUnmatched] = useState<string | null>(null);
  const [scanner, setScanner] = useState<ScannerState>("starting");
  const [slow, setSlow] = useState(false);
  const readSeq = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useMemo(() => liveReadingSupported(), []);
  const often = useMemo(() => oftenTaken(viewerId, items), [viewerId, items]);

  // The list's copy or the one the photo read just returned, whichever is newer
  // (the confirm screen re-reads it from the server either way).
  function asMoveItem(c: CandidateItem | StockItem): MoveItem {
    const pick = freshestItem<CandidateItem | StockItem>(items.find((i) => i.id === c.id), c);
    return { ...pick, identifiers: pick.identifiers } as MoveItem;
  }

  function home() {
    setError(null);
    setHit(null);
    setUnmatched(null);
    setStep({ s: "home" });
  }

  function openConfirm(item: CandidateItem | StockItem, matchedBy: string | null, packIdentifierId: string | null) {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    setHit(null);
    setUnmatched(null);
    setStep({ s: "confirm", item: asMoveItem(item), matchedBy, packIdentifierId });
  }

  // A code read live: one item → opens by itself when held steady; several →
  // pick; none → say so and keep looking. Nothing is taken by any of this.
  function onLiveCode(raw: string) {
    if (step.s !== "home") return;
    const hits = findByBarcode(items, raw);
    if (hits.length === 1) {
      const h = hits[0]!;
      setUnmatched(null);
      setHit({ raw, item: h.item, identifierId: h.identifier.id, packSizeMilli: h.identifier.packSizeMilli });
      return;
    }
    setHit(null);
    if (hits.length > 1) {
      setStep({
        s: "outcome",
        outcome: {
          kind: "candidates",
          productIndex: 0,
          candidates: hits.map((h) => ({ candidate: { itemId: h.item.id, evidence: "barcode", strength: 100, matchedValue: raw, identifierId: h.identifier.id, conflicts: [], notes: [] }, item: h.item })),
        },
      });
      return;
    }
    setUnmatched(raw);
  }

  useEffect(() => {
    if (!hit) return;
    holdTimer.current = setTimeout(() => openConfirm(hit.item, matchedInWorkshop({ evidence: "barcode", matchedValue: hit.raw }), hit.packSizeMilli ? hit.identifierId : null), HOLD_STEADY_MS);
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit]);

  async function onPhoto(url: string, isDark: boolean, thumb: string | null) {
    const seq = ++readSeq.current;
    setDataUrl(url);
    setThumbDataUrl(thumb);
    setDark(isDark);
    setError(null);
    setSlow(false);
    setStep({ s: "reading" });
    const slowTimer = setTimeout(() => setSlow(true), SLOW_READ_MS);
    const r = await readPhoto(url, "take");
    clearTimeout(slowTimer);
    if (seq !== readSeq.current) return; // the worker searched instead meanwhile
    if (!r.ok) {
      setError(errorCopy(r.error.status, r.error.body, "Couldn't read the photo. Search instead, or try again."));
      setStep({ s: "home" });
      return;
    }
    setRead(r.data);
    route(r.data, null);
  }

  function route(result: ReadPhotoResult, chosen: number | null) {
    const outcome = decideRead(result, chosen);
    if (outcome.kind === "exact") {
      openConfirm(outcome.item, matchedInWorkshop(outcome.candidate), outcome.candidate.evidence === "barcode" ? outcome.candidate.identifierId : null);
      return;
    }
    setStep({ s: "outcome", outcome });
  }

  function saved(r: WriteResult) {
    if (r.movement.kind === "take") {
      setRound((rs) => [...rs.filter((x) => x.movement.id !== r.movement.id), r]);
      rememberTaken(viewerId, r.item.id);
    } else if (r.movement.kind === "reversal") {
      setRound((rs) => rs.filter((x) => x.movement.id !== r.movement.reversesMovementId));
    }
    onSaved(r);
  }

  function another() {
    readSeq.current++;
    setDataUrl(null);
    setThumbDataUrl(null);
    setRead(null);
    home();
  }

  const scannerOff = live && scanner !== "scanning" && scanner !== "starting" && scanner !== "off";
  const oftenBlock = often.length ? (
    <div className="shrink-0">
      <Kicker className="mb-1.5 text-text-muted">You often take</Kicker>
      <div className="grid grid-cols-3 gap-1.5">
        {often.map((i) => {
          const { shelf } = splitLocation(i.location);
          return (
            <button key={i.id} type="button" onClick={() => openConfirm(i, null, null)} className="flex min-h-[56px] flex-col justify-center rounded-xl border-[1.5px] border-border-strong bg-surface px-2 py-1.5 text-left hover:border-brand-navy" data-testid="stock-often">
              <span className="line-clamp-2 text-[13px] font-semibold leading-tight text-text">{i.name}</span>
              <span className="mt-0.5 truncate text-[11.5px] text-text-muted">{[shelf, i.balanceMilli === 0 ? "none recorded" : balanceLabel(i)].filter(Boolean).join(" · ")}</span>
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  const picker = (whenEmpty: React.ReactNode, autoFocus = false) => <ItemPicker items={items} onPick={(i) => openConfirm(i, null, null)} autoFocus={autoFocus} whenEmpty={whenEmpty} />;

  // ── home: three ways in ──────────────────────────────────────────────────────
  if (step.s === "home") {
    const hitCard = hit ? (
      <div className="flex flex-col gap-2 rounded-[14px] bg-surface p-3 shadow-raised" data-testid="stock-live-hit">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-state-success">
          <Check aria-hidden="true" className="h-4 w-4" strokeWidth={3} /> Matched in workshop · barcode <span className="font-mono">{hit.raw}</span>
        </span>
        <div className="flex items-center gap-3">
          <StockThumb photoId={hit.item.photoId} alt="" size="md" />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-text">{hit.item.name}</p>
            <p className="truncate text-[13px] text-text-muted">{[hit.item.location, `${balanceLabel(hit.item)} recorded`].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
        <span className="text-[13px] font-medium text-text-muted">Opening… hold steady. Nothing is taken yet.</span>
      </div>
    ) : null;
    const whenEmpty = (
      <>
        {round.length ? (
          <div className="shrink-0 rounded-xl border border-border bg-surface-subtle px-3 py-2.5" data-testid="stock-round">
            <Kicker className="mb-1 text-text-muted">Taken this round · all saved</Kicker>
            {round.map((r) => (
              <p key={r.movement.id} className="text-sm font-medium text-text">
                {movementSummary(r.movement, r.item.baseUnit)} · {r.item.name}
              </p>
            ))}
          </div>
        ) : null}
        {error ? <Slot tone="bad" role="alert">{error}</Slot> : null}
        {dark && !error ? <Slot tone="warn">That photo looked dark — a brighter one reads better.</Slot> : null}
        {live ? (
          <LiveCodeScanner active={step.s === "home" && !hit} hit={Boolean(hit)} onCode={onLiveCode} onState={setScanner} overlay={hitCard} frameText={round.length ? "Point at the next barcode or code" : "Point at the barcode or product code"} className={cn(scannerOff && "min-h-[120px] flex-none")} />
        ) : (
          <Slot tone="neu" icon={Camera} title={SCANNER_COPY.unsupported} />
        )}
        {unmatched && !hit ? (
          <Slot tone="neu" title="Not matched in the workshop" testId="stock-live-unmatched">
            <p>
              Barcode <span className="font-mono">{unmatched}</span> isn&rsquo;t on our list. Nothing has been taken.
            </p>
            <div className="flex flex-wrap gap-x-4">
              <LinkButton onClick={() => onAddNew({ dataUrl: null, thumbDataUrl: null, product: null })}>Add it as new stock</LinkButton>
              <LinkButton onClick={() => setUnmatched(null)}>Keep looking</LinkButton>
            </div>
          </Slot>
        ) : null}
        {!photoReading ? <Slot tone="neu" title="Photo reading isn't set up — find the item in the list." /> : null}
        {oftenBlock}
      </>
    );
    return (
      <FlowSheet
        title="Take stock"
        direction="out"
        onClose={onClose}
        testId="stock-take-flow"
        footer={
          hit ? (
            <BigButton variant="ter" label="Not this one · keep looking" onClick={() => { if (holdTimer.current) clearTimeout(holdTimer.current); setHit(null); }} data-testid="stock-live-not-this" />
          ) : (
            <>
              {photoReading ? <PhotoCapture variant="single" tone="ter" label="No code? Photograph the label" sub="reads the label · usually under 8 seconds" onPhoto={(u, d, t) => void onPhoto(u, d, t)} /> : null}
              {round.length ? <BigButton variant="sec" label="Done for now" sub="back to the list · nothing waiting" onClick={onClose} data-testid="stock-take-done" /> : null}
            </>
          )
        }
      >
        {picker(whenEmpty)}
      </FlowSheet>
    );
  }

  // ── reading the label photo ──────────────────────────────────────────────────
  if (step.s === "reading") {
    return (
      <FlowSheet title="Take stock" direction="out" onClose={onClose} onBack={another} testId="stock-take-flow" footer={<BigButton variant="sec" label="Search instead" onClick={another} />}>
        <div className="flex flex-1 flex-col gap-3" role="status" data-testid="stock-reading">
          {dataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local preview
            <img src={dataUrl} alt="Your photo" className="min-h-[200px] w-full flex-1 rounded-[14px] border border-border object-cover" />
          ) : null}
          <Slot
            tone="inf"
            icon={Loader2}
            title={slow ? "Still reading — taking longer than usual" : "Reading the label… usually under 8 seconds"}
            below={
              <>
                <div className="h-2 overflow-hidden rounded-pill bg-state-info-subtle-border" aria-hidden="true">
                  <div className="h-2 w-[45%] animate-pulse rounded-pill bg-state-info" />
                </div>
                <p className="mt-1.5 text-[13px] text-text-muted">{slow ? "You can search instead — the read stops when you do." : "If it takes longer than 10 seconds you'll be offered search."}</p>
              </>
            }
          >
            Nothing changes until you confirm. No need to tap again.
          </Slot>
        </div>
      </FlowSheet>
    );
  }

  // ── what the read (or a live code) means ─────────────────────────────────────
  if (step.s === "outcome") {
    return (
      <OutcomeView
        outcome={step.outcome}
        read={read}
        dataUrl={dataUrl}
        items={items}
        often={oftenBlock}
        onClose={onClose}
        onBack={home}
        onProduct={(i) => read && route(read, i)}
        onPick={(c, item) => openConfirm(item, c.evidence === "barcode" && c.matchedValue ? matchedInWorkshop(c) : `Picked by you · ${EVIDENCE_LABEL[c.evidence] ?? ""}`.replace(/ · $/, ""), c.evidence === "barcode" ? c.identifierId : null)}
        onSearchPick={(i) => openConfirm(i, null, null)}
        onNone={() => setStep({ s: "outcome", outcome: { kind: "none", productIndex: 0 } })}
        onPhoto={(u, d, t) => void onPhoto(u, d, t)}
        onAddNew={() => {
          const p = read && read.reading && step.outcome.kind !== "status" && step.outcome.kind !== "pick-product" ? read.reading.products[step.outcome.productIndex] ?? null : null;
          onAddNew({ dataUrl, thumbDataUrl, product: p });
        }}
      />
    );
  }

  // ── the one confirmation ─────────────────────────────────────────────────────
  return (
    <FlowSheet title="Take stock" direction="out" onClose={onClose} onBack={home} testId="stock-take-flow">
      <MoveConfirm
        key={step.item.id}
        item={step.item}
        kind="take"
        matchedBy={step.matchedBy}
        packIdentifierId={step.packIdentifierId}
        onSaved={saved}
        onWrongItem={home}
        wrongItemLabel={live ? "Wrong item? Back to the camera" : "Wrong item? Back to the search"}
        onAnother={another}
        anotherLabel="Take another item"
        anotherSub={live ? "back to the camera" : "back to the search"}
        onClose={onClose}
      />
    </FlowSheet>
  );
}

function OutcomeView({
  outcome,
  read,
  dataUrl,
  items,
  often,
  onClose,
  onBack,
  onProduct,
  onPick,
  onSearchPick,
  onNone,
  onPhoto,
  onAddNew,
}: {
  outcome: ReadOutcome;
  read: ReadPhotoResult | null;
  dataUrl: string | null;
  items: StockItem[];
  often: React.ReactNode;
  onClose: () => void;
  onBack: () => void;
  onProduct: (i: number) => void;
  onPick: (c: MatchCandidate, item: CandidateItem) => void;
  onSearchPick: (i: StockItem) => void;
  onNone: () => void;
  onPhoto: (dataUrl: string, dark: boolean, thumb: string | null) => void;
  onAddNew: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(outcome.kind === "candidates" ? outcome.candidates[0]?.item.id ?? null : null);
  const frame = (footer: React.ReactNode, children: React.ReactNode) => (
    <FlowSheet title="Take stock" direction="out" onClose={onClose} onBack={onBack} testId="stock-take-flow" footer={footer}>
      {children}
    </FlowSheet>
  );
  const photo = dataUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- local preview
    <img src={dataUrl} alt="Your photo" className="h-14 w-14 shrink-0 rounded-[10px] border border-border object-cover" />
  ) : null;

  if (outcome.kind === "status") {
    const copy = READ_STATUS_COPY[outcome.status];
    const warn = outcome.status === "unreadable" || outcome.status === "unavailable";
    return frame(
      warn ? <PhotoCapture variant="single" tone="ter" label={outcome.status === "unreadable" ? "Closer photo of the label" : "Try the photo again"} onPhoto={onPhoto} /> : null,
      <>
        <Slot tone={warn ? "warn" : "neu"} icon={outcome.status === "unreadable" ? Camera : undefined} title={copy.title} testId="stock-outcome-status" data-status={outcome.status}>
          {read?.reading?.note || copy.body}
        </Slot>
        <ItemPicker items={items} onPick={onSearchPick} autoFocus whenEmpty={often ?? <p className="text-sm text-text-muted">Type a name, code or shelf.</p>} />
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
          <h3 className="font-display text-[20px] font-bold leading-tight text-brand-navy">There&rsquo;s more than one product in the photo. Which one?</h3>
          <p className="mt-1 text-sm text-text-muted">Tap the one you&rsquo;re taking. Nothing is taken yet.</p>
        </div>
        <ul className="space-y-2">
          {outcome.products.map((p, i) => (
            <li key={i}>
              <button type="button" onClick={() => onProduct(i)} className="flex min-h-[56px] w-full items-center gap-3 rounded-[14px] border border-border bg-surface px-3 py-2 text-left hover:border-brand-navy" data-testid="stock-outcome-product">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-yellow font-display text-sm font-bold text-brand-navy">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-semibold text-text">{productLabel(p, i)}</span>
                  {p.manufacturerCode || p.colourFinish ? <span className="block truncate text-[13px] text-text-muted">{[p.brand, p.manufacturerCode, p.colourFinish].filter(Boolean).join(" · ")}</span> : null}
                </span>
                <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
              </button>
            </li>
          ))}
        </ul>
      </div>,
    );
  }

  if (outcome.kind === "none") {
    return frame(
      <>
        <BigButton variant="pri" label="Search the list" sub="find it by name, code or shelf" onClick={onBack} data-testid="stock-outcome-search" />
        <PhotoCapture variant="single" tone="ter" label="Closer photo of the label" sub="back to the camera" onPhoto={onPhoto} testId="stock-outcome-retake" />
        <BigButton variant="ter" label="Add it as new stock" sub="switches to Add stock · nothing is taken" onClick={onAddNew} data-testid="stock-outcome-add-new" />
      </>,
      <div className="flex flex-1 flex-col gap-3" data-testid="stock-outcome-none">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local preview
          <img src={dataUrl} alt="Your photo" className="min-h-[160px] w-full flex-1 rounded-[14px] border border-border object-cover" />
        ) : null}
        <Slot tone="neu" title="Not matched in the workshop">We couldn&rsquo;t match this to anything recorded. Nothing has been taken.</Slot>
      </div>,
    );
  }

  // candidates: select one, then one named button continues
  if (outcome.kind !== "candidates") return null;
  const picked = outcome.candidates.find((c) => c.item.id === chosen) ?? null;
  return frame(
    <>
      <BigButton variant="pri" label="Take from this one" sub={picked ? `${picked.item.name} · next: how many` : "pick one above first"} disabled={!picked} onClick={() => picked && onPick(picked.candidate, picked.item)} data-testid="stock-candidate-continue" />
      <BigButton variant="ter" label="None of these · search or add as new" onClick={onNone} data-testid="stock-candidate-none" />
    </>,
    <div className="space-y-3" data-testid="stock-outcome-candidates">
      <div className="flex items-center gap-3">
        {photo}
        <div>
          <h3 className="font-display text-[20px] font-bold leading-tight text-brand-navy">Is it one of these?</h3>
          <p className="mt-0.5 text-sm text-text-muted">Pick the one in your hand. Nothing is taken yet.</p>
        </div>
      </div>
      <ul className="space-y-2" role="radiogroup" aria-label="Which item">
        {outcome.candidates.map(({ candidate, item }) => {
          const on = item.id === chosen;
          const why = [EVIDENCE_LABEL[candidate.evidence], ...candidate.conflicts.map((c) => `${c.field} differs`)].filter(Boolean).join(" · ");
          return (
            <li key={item.id}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setChosen(item.id)}
                className={cn("flex w-full items-start gap-3 rounded-[14px] border-2 bg-surface p-3 text-left", on ? "border-brand-navy bg-surface-subtle" : "border-border")}
                data-testid="stock-candidate"
                data-item-id={item.id}
              >
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
              <span className="sr-only">
                <RecordedQuantity item={item} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>,
  );
}
