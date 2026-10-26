"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { brandKey, codeKey, checkApplies } from "@/domains/workshop-stock/check";
import { createItem, fetchOperation, lookupCode, newOperationKey, storePhoto, type CreateInput } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, formatQuantity, packLabel, toQuantityString, UNIT_LABEL, unitHint, VERIFICATION_LABEL } from "@/domains/workshop-stock/format";
import { packSuggestion, suggestName } from "@/domains/workshop-stock/flow";
import { clearPending, isUncertain, rememberPending } from "@/domains/workshop-stock/pending";
import { PACK_UNITS, UNIT_KEYS, type LookupResult, type PackUnit, type ReadProduct, type StockItem, type StockUnit, type VerificationStatus, type WriteResult } from "@/domains/workshop-stock/schema";
import { LookupCard } from "./LookupCard";
import { PhotoCapture } from "./PhotoCapture";
import { QuantityStepper } from "./QuantityStepper";
import { BigButton, FIELD, FieldLabel, FoldButton, LinkButton, MiniButton, SavesLine, Slot, Tag } from "./ui";

type Source = "photo" | "lookup" | "typed";

export interface NewItemSeed {
  product: ReadProduct | null;
  photoId: string | null;
  dataUrl: string | null;
  /** the list-size copy made on the phone (kept with the photo) */
  thumbDataUrl?: string | null;
}

const SOURCE_TAG: Record<Exclude<Source, "typed">, { text: string; tone: "neu" | "inf" }> = { photo: { text: "Read from photo", tone: "neu" }, lookup: { text: "Listing", tone: "inf" } };

function Field({ label, value, onChange, placeholder, source, tag, testId, inputMode, disabled, invalid }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; source?: Source; tag?: ReactNode; testId: string; inputMode?: "text" | "numeric"; disabled?: boolean; invalid?: boolean;
}) {
  const t = source && source !== "typed" && value ? SOURCE_TAG[source] : null;
  return (
    <label className="block">
      <FieldLabel tag={t ? <Tag tone={t.tone}>{t.text}</Tag> : tag}>{label}</FieldLabel>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} inputMode={inputMode} autoComplete="off" className={cn(FIELD, invalid && "border-2 border-state-danger")} data-testid={testId} />
    </label>
  );
}

const STATUS_DOT: Record<VerificationStatus, string> = { manufacturer_code_matched: "bg-state-success-dot", possible_match: "bg-state-warning-dot", unverified: "bg-state-neutral-dot" };

/**
 * The one short form for a NEW workshop item (Workshop Stock).
 *
 * The fast path asks only what a new item needs — the name (read from the
 * label), the unit, where it lives (the last shelf used is filled in), and how
 * many are going on the shelf — then "Save and add another". Brand, codes,
 * colour, size and the online check fold under "Details read from the label —
 * check them". A printed pack size is OFFERED as a conversion, never applied
 * silently. The item, its codes, its photo and its opening count save together
 * or not at all.
 *
 * "Use these details" only FILLS what's empty — the name the crew gave it is
 * kept (a wholesaler's catalogue title is not what anyone searches for) — and
 * the "Saves as" line pinned above Save is what the server will record: the
 * accepted check counts while it still describes this item, and says so when it
 * doesn't. A code another live item already carries is refused before Save,
 * with the one fix offered: add to that item instead.
 */
export function NewItemForm({
  seed,
  items,
  lookupEnabled,
  locationPhotoEnabled = false,
  defaultLocation,
  emphasis = "another",
  onSaved,
  onUseExisting,
}: {
  seed: NewItemSeed;
  items: StockItem[];
  lookupEnabled: boolean;
  /** the server can keep a photo of where it lives (after its migration) */
  locationPhotoEnabled?: boolean;
  /** the shelf the last item went on (set-up rhythm) */
  defaultLocation?: string | null;
  /** phone: "Save and add another" leads; office: "Save item" leads */
  emphasis?: "another" | "save";
  onSaved: (r: WriteResult, again: boolean) => void;
  onUseExisting: (item: StockItem) => void;
}) {
  const p = seed.product;
  const [name, setName] = useState(suggestName(p));
  const [brand, setBrand] = useState(p?.brand ?? "");
  const [code, setCode] = useState(p?.manufacturerCode ?? "");
  const [sku, setSku] = useState(p?.supplierSku ?? "");
  const [supplier, setSupplier] = useState(p?.supplierName ?? "");
  const [barcode, setBarcode] = useState<string | null>(p?.barcode ?? null);
  const [colour, setColour] = useState(p?.colourFinish ?? "");
  const [variant, setVariant] = useState((p?.variantDetails ?? []).join(" "));
  const [unit, setUnit] = useState<StockUnit>(p?.packUnit === "metre" ? "metre" : "each");
  const [keepContainer, setKeepContainer] = useState<StockUnit | null>(null);
  const [location, setLocation] = useState(defaultLocation ?? "");
  const [locationFromLast, setLocationFromLast] = useState(Boolean(defaultLocation));
  const [qtyMilli, setQtyMilli] = useState(1000);
  const [packMode, setPackMode] = useState(false);
  const [packCount, setPackCount] = useState(1);
  const [packSizeText, setPackSizeText] = useState("");
  const [packSizeFromLabel, setPackSizeFromLabel] = useState(false);
  const [packUnit, setPackUnit] = useState<PackUnit>("box");
  const [rememberPack, setRememberPack] = useState(true);
  const [estimated, setEstimated] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(!p);
  const [sources, setSources] = useState<Record<string, Source>>(() => {
    const s: Record<string, Source> = {};
    if (p) for (const k of ["brand", "manufacturerCode", "supplierSku", "barcode", "colourFinish", "variant", "name"]) s[k] = "photo";
    return s;
  });
  const [lookupState, setLookupState] = useState<"idle" | "checking" | "done">("idle");
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [checkedCode, setCheckedCode] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<"edit" | "saving" | "uncertain">("edit");
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Array<{ itemId: string; itemName: string; value: string }>>([]);
  const [photoId, setPhotoId] = useState<string | null>(seed.photoId);
  // A photo of WHERE it lives — for stock that isn't in an obvious place.
  const [locationShot, setLocationShot] = useState<{ dataUrl: string; thumbDataUrl: string | null } | null>(null);
  const [locationPhotoId, setLocationPhotoId] = useState<string | null>(null);
  const locationFailedRef = useRef(false);
  const keyRef = useRef<string | null>(null);
  const requestRef = useRef<CreateInput | null>(null);
  const againRef = useRef(false);
  // Set synchronously on the first tap: a second tap while the photo is still
  // uploading must not start a second save.
  const savingRef = useRef(false);
  const photoFailedRef = useRef(false);

  const suggestion = packSuggestion(p, unit);
  const locations = useMemo(() => {
    const count = new Map<string, number>();
    for (const i of items) if (i.location && !i.archivedAt) count.set(i.location, (count.get(i.location) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l]) => l);
  }, [items]);

  // The same maker's code on a live item of the same brand (or an unbranded
  // one): two items can't share it. Said before Save; the server refuses too.
  const sameCode = useMemo(() => {
    const k = codeKey(code);
    if (!k) return null;
    const b = brandKey(brand) ?? "";
    return items.find((i) => !i.archivedAt && i.identifiers.some((id) => id.kind === "manufacturer_code" && id.valueKey === k && (!id.scope || !b || id.scope === b))) ?? null;
  }, [items, code, brand]);
  const dupe = sameCode ?? (duplicates[0] ? items.find((i) => i.id === duplicates[0]!.itemId) ?? null : null);

  const typed = (k: string) => setSources((s) => ({ ...s, [k]: "typed" }));
  const packSizeMilli = (() => {
    const m = /^(\d{1,6})(?:[.,](\d))?$/.exec(packSizeText.trim());
    if (!m) return null;
    const v = Number(m[1]) * 1000 + (m[2] ? Number(m[2]) * 100 : 0);
    if (UNIT_LABEL[unit].decimals === 0 && v % 1000 !== 0) return null;
    return v > 0 ? v : null;
  })();
  const totalMilli = packMode ? (packSizeMilli ? packCount * packSizeMilli : 0) : qtyMilli;
  const locked = phase !== "edit";

  async function runLookup(refreshCode?: string) {
    const c = (refreshCode ?? code).trim();
    if (!lookupEnabled || !c) return;
    setLookupState("checking");
    setAccepted(null);
    const r = await lookupCode({ brand: brand || null, manufacturerCode: c, colourFinish: colour || null, variantDetails: variant ? variant.split(/\s+/).slice(0, 8) : [] });
    setCheckedCode(c);
    setLookup(r.ok ? r.data : ({ status: "unavailable", reasons: [errorCopy(r.error.status, r.error.body, "Couldn't check online right now — save it and check later.")], candidate: null, sources: [] } as LookupResult));
    setLookupState("done");
  }

  // Check the code read from the photo ONCE per form — a paid search; the ref
  // also holds through React's dev double-mount.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current) return;
    autoChecked.current = true;
    if (p?.manufacturerCode && lookupEnabled) void runLookup(p.manufacturerCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fill only what's empty: the listing never replaces the name (or anything) the crew gave it.
  function accept() {
    setAccepted(true);
    const c = lookup?.candidate;
    if (!c) return;
    if (c.name && !name.trim()) { setName(c.name.slice(0, 160)); setSources((s) => ({ ...s, name: "lookup" })); }
    if (c.brand && !brand.trim()) { setBrand(c.brand.slice(0, 60)); setSources((s) => ({ ...s, brand: "lookup" })); }
    if (c.colour && !colour.trim()) { setColour(c.colour.slice(0, 40)); setSources((s) => ({ ...s, colourFinish: "lookup" })); }
  }

  const codeChangedSinceCheck = checkedCode !== null && checkedCode !== code.trim();
  const listingFound = lookup?.status === "manufacturer_code_matched" || lookup?.status === "possible_match";
  // Does the accepted check still describe what's on the form? (The server
  // re-reads its own cached result and decides the same way.)
  const checkStillApplies = Boolean(lookup?.check) && checkApplies(lookup?.check, lookup?.candidate, { brand, manufacturerCode: code, colourFinish: colour, variant });
  const listingStatus = accepted === true && listingFound && checkStillApplies ? (lookup!.status as "manufacturer_code_matched" | "possible_match") : null;
  const checkStale = accepted === true && listingFound && !checkStillApplies;
  const savesAs: VerificationStatus = listingStatus ?? "unverified";
  const canSave = !locked && !dupe && name.trim().length > 0 && location.trim().length > 0 && (packMode ? Boolean(packSizeMilli) : true);

  function done(r: WriteResult) {
    if (keyRef.current) clearPending(keyRef.current);
    keyRef.current = null;
    savingRef.current = false;
    setPhase("edit");
    // a photo that couldn't be uploaded is "not attached", even though the save asked for none
    onSaved({
      ...r,
      ...(photoFailedRef.current ? { photoAttached: false } : {}),
      ...(locationFailedRef.current ? { locationPhotoAttached: false } : {}),
    }, againRef.current);
  }

  async function send(request: CreateInput, key: string) {
    setPhase("saving");
    setError(null);
    const r = await createItem(request, key);
    if (r.ok) {
      done(r.data);
      return;
    }
    if (isUncertain(r.error.status, r.error.body)) {
      setPhase("uncertain");
      setError("Not sure it saved — no signal. Tap Try again: it won't make a second item.");
      return;
    }
    clearPending(key);
    keyRef.current = null;
    savingRef.current = false;
    setPhase("edit");
    const body = r.error.body as { error?: string; existing?: Array<{ itemId: string; itemName: string; value: string }> } | null;
    if (body?.error === "duplicate_item" && body.existing?.length) {
      setDuplicates(body.existing);
      setDetailsOpen(true);
      return;
    }
    setError(errorCopy(r.error.status, r.error.body));
  }

  async function save(again: boolean) {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setPhase("saving");
    setError(null);
    againRef.current = again;
    setDuplicates([]);
    let pid = photoId;
    photoFailedRef.current = false;
    if (!pid && seed.dataUrl) {
      const s = await storePhoto(seed.dataUrl, seed.thumbDataUrl ?? null);
      if (s.ok) { pid = s.data.photoId; setPhotoId(pid); }
      else photoFailedRef.current = true; // the item still saves; the result says the photo isn't on it
    }
    let lid = locationPhotoId;
    locationFailedRef.current = false;
    if (!lid && locationShot) {
      const s = await storePhoto(locationShot.dataUrl, locationShot.thumbDataUrl);
      if (s.ok) { lid = s.data.photoId; setLocationPhotoId(lid); }
      else locationFailedRef.current = true; // the item still saves; the receipt says this photo isn't on it
    }
    const request: CreateInput = {
      name: name.trim(),
      brand: brand.trim() || null,
      manufacturerCode: code.trim() || null,
      supplierSku: sku.trim() || null,
      supplierName: sku.trim() ? supplier.trim() || null : null,
      barcode,
      variant: variant.trim() || null,
      colourFinish: colour.trim() || null,
      baseUnit: unit,
      location: location.trim(),
      photoId: pid,
      ...(lid ? { locationPhotoId: lid } : {}),
      estimated,
      ...(listingStatus && lookup?.check ? { lookupCheck: lookup.check } : {}),
      provenance: Object.fromEntries(Object.entries(sources).filter(([k]) => ["name", "brand", "manufacturerCode", "supplierSku", "barcode", "variant", "colourFinish"].includes(k))) as CreateInput["provenance"],
      ...(packMode && packSizeMilli ? { packCount, packUnit, packSize: toQuantityString(packSizeMilli), rememberPack } : { openingQuantity: toQuantityString(qtyMilli) }),
    };
    const key = keyRef.current ?? newOperationKey();
    keyRef.current = key;
    requestRef.current = request;
    rememberPending({ key, kind: "create", itemId: null, itemName: request.name, quantityLabel: formatQuantity(totalMilli, unit), request: request as unknown as Record<string, unknown>, startedAt: new Date().toISOString() });
    await send(request, key);
  }

  async function checkSaved() {
    if (!keyRef.current) return;
    setPhase("saving");
    const r = await fetchOperation(keyRef.current);
    if (r.ok && r.data.found && r.data.item && r.data.movement) {
      done({ item: r.data.item, movement: r.data.movement, replayed: true });
      return;
    }
    // "Not found" may only mean "not landed YET": keep the key and stay locked —
    // Try again can never make a second item.
    setPhase("uncertain");
    setError(r.ok ? "It hasn't saved (yet). Tap Try again — it won't make a second item." : "Still can't reach the office. Try again in a moment.");
  }

  // A container unit (boxes, packs, bags, rolls) means stock only moves a whole
  // one at a time: the warning offers the fix as one button.
  const container = unit === "box" || unit === "pack" || unit === "bag" || unit === "roll";
  const containerFix = () => {
    const to: StockUnit = unit === "roll" ? "metre" : "each";
    const pu = unit as PackUnit;
    setPackUnit(pu);
    setPackMode(true);
    setPackCount(Math.max(1, Math.round(qtyMilli / 1000)));
    const printed = packSuggestion(p, to);
    setPackSizeText(printed ? String(printed.sizeMilli / 1000) : "");
    setPackSizeFromLabel(Boolean(printed));
    setUnit(to);
    setQtyMilli(1000);
    setKeepContainer(null);
  };
  const printedForFix = packSuggestion(p, unit === "roll" ? "metre" : "each");
  const fixSub = printedForFix ? `${Math.max(1, Math.round(qtyMilli / 1000))} ${packLabel(unit, Math.max(1, Math.round(qtyMilli / 1000)))} × ${formatQuantity(printedForFix.sizeMilli, unit === "roll" ? "metre" : "each")} = ${formatQuantity(Math.max(1, Math.round(qtyMilli / 1000)) * printedForFix.sizeMilli, unit === "roll" ? "metre" : "each")}` : `then say how many in each ${UNIT_LABEL[unit].singular}`;

  const detailSummary = [brand || null, code || null, variant || null, barcode ? "barcode" : null, lookupEnabled && code ? "online check" : null].filter(Boolean).join(" · ") || "brand, codes, colour, size, supplier";
  const needsAttention = lookup && lookup.status !== "manufacturer_code_matched" && accepted !== true;
  const savesLine = packMode && packSizeMilli
    ? `Saves: Opening count ${formatQuantity(totalMilli, unit)} (${packCount} ${packLabel(packUnit, packCount)} × ${formatQuantity(packSizeMilli, unit)})${location.trim() ? ` · ${location.trim()}` : ""}`
    : `Saves: Opening count ${estimated ? balanceLabel({ balanceMilli: qtyMilli, baseUnit: unit, estimated: true }) : formatQuantity(qtyMilli, unit)}${location.trim() ? ` · ${location.trim()}` : ""}`;
  const savesWithPhoto = locationShot ? `${savesLine} · with a photo of where it lives` : savesLine;

  const saveAnother = (
    <BigButton variant={emphasis === "another" ? "pri" : "sec"} onClick={() => void save(true)} disabled={!canSave} aria-busy={phase === "saving" && againRef.current} label={phase === "saving" && againRef.current ? "Saving…" : "Save and add another"} sub={emphasis === "another" ? (canSave ? `saves Opening count ${formatQuantity(totalMilli, unit)} · back to the camera` : dupe ? "can't run: code already listed" : "needs a name and a shelf") : undefined} data-testid="stock-new-save-another" />
  );
  const saveOnly = (
    <BigButton variant={emphasis === "save" ? "pri" : "ter"} onClick={() => void save(false)} disabled={!canSave} aria-busy={phase === "saving" && !againRef.current} label={phase === "saving" && !againRef.current ? <span className="flex items-center gap-2"><Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />Saving…</span> : emphasis === "save" ? "Save item" : "Save and go to the list"} sub={emphasis === "save" ? (canSave ? `saves Opening count ${formatQuantity(totalMilli, unit)}` : dupe ? "can't run: code already listed" : "needs a name and a shelf") : undefined} data-testid="stock-new-save" />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5" data-testid="stock-new-item">
      <div className="flex gap-3">
        {seed.dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local preview
          <img src={seed.dataUrl} alt="Your photo of the product" className="h-16 w-16 shrink-0 rounded-xl border border-border object-cover" />
        ) : null}
        <div className="min-w-0 flex-1">
          <Field label="Name" value={name} onChange={(v) => { setName(v); typed("name"); }} placeholder="e.g. Clipsal double GPO white" source={sources.name} testId="stock-new-name" disabled={locked} />
        </div>
      </div>

      {dupe ? (
        <Slot
          tone="bad"
          role="alert"
          title={`Already listed as '${dupe.name}'${dupe.manufacturerCode ? ` (${dupe.manufacturerCode})` : ""}`}
          testId="stock-new-duplicate"
          below={<BigButton variant="nav" label="Add to that item instead" sub={`no new item · keeps your ${formatQuantity(totalMilli, unit)}`} onClick={() => onUseExisting(dupe)} data-testid="stock-new-use-existing" />}
        >
          <span data-testid="stock-new-error">{[dupe.location, `${balanceLabel(dupe)} recorded`].filter(Boolean).join(" · ")}. Two items can&rsquo;t share a code.</span>
        </Slot>
      ) : null}

      <fieldset>
        <legend className="text-sm font-semibold text-text">Counted in</legend>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {UNIT_KEYS.map((u) => (
            <button key={u} type="button" onClick={() => { setUnit(u); setQtyMilli(1000); setKeepContainer(null); }} aria-pressed={unit === u} disabled={locked} className={cn("min-h-[40px] rounded-pill border px-3 text-sm font-semibold", unit === u ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border-strong bg-surface text-text")} data-testid={`stock-new-unit-${u}`}>
              {UNIT_LABEL[u].chip}
            </button>
          ))}
        </div>
      </fieldset>
      {container && keepContainer !== unit ? (
        <Slot
          tone="warn"
          title={`Counted in whole ${UNIT_LABEL[unit].plural}`}
          below={
            <div className="space-y-2">
              <BigButton variant="nav" label={`Count in ${unit === "roll" ? "Metres" : "Each"}, add full ${UNIT_LABEL[unit].plural}`} sub={fixSub} onClick={containerFix} disabled={locked} data-testid="stock-new-unit-fix" />
              <BigButton variant="ter" label={`Keep ${UNIT_LABEL[unit].chip} · whole ${UNIT_LABEL[unit].plural} only`} onClick={() => setKeepContainer(unit)} disabled={locked} />
            </div>
          }
        >
          <span data-testid="stock-new-unit-hint">{unitHint(unit)}</span>
        </Slot>
      ) : null}

      <div className="space-y-1.5">
        <Field label="Where it lives in the workshop" value={location} onChange={(v) => { setLocation(v); setLocationFromLast(false); }} placeholder="e.g. Shelf A2, Bin 4" tag={locationFromLast && location ? <Tag>Same as last item</Tag> : undefined} testId="stock-new-location" disabled={locked} />
        {locations.length ? (
          <div className="flex flex-wrap gap-1.5">
            {locations.map((l) => (
              <button key={l} type="button" onClick={() => { setLocation(l); setLocationFromLast(false); }} disabled={locked} className="min-h-[36px] rounded-pill border border-border px-3 text-[13px] text-text hover:border-brand-navy">{l}</button>
            ))}
          </div>
        ) : null}
        {locationPhotoEnabled ? (
          locationShot ? (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-subtle p-2.5" data-testid="stock-new-location-photo-set">
              {/* eslint-disable-next-line @next/next/no-img-element -- local preview */}
              <img src={locationShot.dataUrl} alt="Your photo of where it lives" className="h-16 w-16 shrink-0 rounded-lg border border-border object-cover" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-text">Photo of where it lives</p>
                <p className="text-[13px] text-text-muted">Shown to whoever comes to take it</p>
              </div>
              <MiniButton onClick={() => { setLocationShot(null); setLocationPhotoId(null); }} disabled={locked} data-testid="stock-new-location-photo-remove">Remove</MiniButton>
            </div>
          ) : (
            <PhotoCapture
              variant="single"
              tone="ter"
              label="Hard to find? Photograph where it lives"
              sub="shown to whoever comes to take it"
              disabled={locked}
              onPhoto={(dataUrl, _dark, thumbDataUrl) => { setLocationShot({ dataUrl, thumbDataUrl }); setLocationPhotoId(null); }}
              testId="stock-new-location-photo"
            />
          )
        ) : null}
      </div>

      {packMode ? (
        <div className="space-y-2.5 rounded-[14px] border border-border p-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Pack type">
            {PACK_UNITS.slice(0, 6).map((u) => (
              <button key={u} type="button" onClick={() => setPackUnit(u)} aria-pressed={packUnit === u} disabled={locked} className={cn("min-h-[36px] rounded-pill border px-3 text-[13px]", packUnit === u ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border text-text")}>
                {packLabel(u, 2)}
              </button>
            ))}
          </div>
          <QuantityStepper label={`Adding full, unopened ${packLabel(packUnit, 2)}`} valueMilli={packCount * 1000} onChange={(m) => setPackCount(Math.max(1, Math.round(m / 1000)))} unit="each" unitLabel={packLabel(packUnit, packCount)} disabled={locked} testId="stock-new-packs" />
          <label className="block">
            <FieldLabel tag={packSizeFromLabel && packSizeText ? <Tag>Printed on {packUnit} · check it</Tag> : undefined}>Each {packUnit} holds</FieldLabel>
            <div className={cn(FIELD, "flex items-center gap-2 px-0")}>
              <input value={packSizeText} onChange={(e) => { setPackSizeText(e.target.value); setPackSizeFromLabel(false); }} inputMode={UNIT_LABEL[unit].decimals ? "decimal" : "numeric"} className="h-full min-w-0 flex-1 rounded-xl bg-transparent px-3 text-base font-semibold text-text outline-none" data-testid="stock-new-pack-size" disabled={locked} />
              <span className="pr-3 text-sm text-text-muted">{UNIT_LABEL[unit].plural}</span>
            </div>
          </label>
          <p className="text-sm font-semibold text-text" data-testid="stock-new-pack-total">{packSizeMilli ? `= ${formatQuantity(totalMilli, unit)} going on the shelf` : `Enter how many are in each ${packUnit}`}</p>
          <label className="flex min-h-[44px] items-center gap-3 text-sm text-text">
            <input type="checkbox" checked={rememberPack} onChange={(e) => setRememberPack(e.target.checked)} className="h-5 w-5 accent-brand-navy" disabled={locked} />
            Remember {packSizeMilli ? formatQuantity(packSizeMilli, unit) : "this"} per {packUnit} for this item
          </label>
          <LinkButton onClick={() => setPackMode(false)} disabled={locked}>Not full {packLabel(packUnit, 2)}? Count singles instead</LinkButton>
        </div>
      ) : (
        <>
          <QuantityStepper label="How many going on the shelf" valueMilli={qtyMilli} onChange={setQtyMilli} unit={unit} allowZero disabled={locked} testId="stock-new-qty" />
          {suggestion ? (
            <button type="button" onClick={() => { setPackMode(true); setPackSizeText(String(suggestion.sizeMilli / 1000)); setPackSizeFromLabel(true); if (unit === "metre") setPackUnit("roll"); }} disabled={locked} className="w-full rounded-xl border border-dashed border-border-strong bg-surface-subtle p-3 text-left text-sm text-text" data-testid="stock-new-pack-suggest">
              {suggestion.label}. Adding full, unopened packs? <span className="font-semibold text-state-info underline">Count in packs</span>
            </button>
          ) : (
            <LinkButton onClick={() => { setPackMode(true); if (unit === "metre") setPackUnit("roll"); }} disabled={locked} data-testid="stock-new-pack-mode">Adding full, unopened boxes, packs or rolls?</LinkButton>
          )}
        </>
      )}

      <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-1">
        <input type="checkbox" checked={estimated} onChange={(e) => setEstimated(e.target.checked)} className="h-5 w-5 accent-brand-navy" disabled={locked} data-testid="stock-new-estimated" />
        <span className="text-sm text-text">It&rsquo;s a rough count — save as an estimate</span>
      </label>

      <FoldButton label="Details read from the label — check them" sub={detailSummary} open={detailsOpen} onClick={() => setDetailsOpen((o) => !o)} testId="stock-new-details" className={cn(needsAttention && !detailsOpen && "border-state-warning-subtle-border bg-state-warning-subtle-bg")} />
      {detailsOpen ? (
        <div className="space-y-3 rounded-[14px] border border-border p-3" data-testid="stock-new-details-open">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Brand" value={brand} onChange={(v) => { setBrand(v); typed("brand"); }} source={sources.brand} testId="stock-new-brand" disabled={locked} />
            <Field label="Maker's code" value={code} onChange={(v) => { setCode(v); typed("manufacturerCode"); }} placeholder="as printed" source={sources.manufacturerCode} testId="stock-new-code" disabled={locked} invalid={Boolean(dupe)} />
            <Field label="Size / rating" value={variant} onChange={(v) => { setVariant(v); typed("variant"); }} placeholder="as printed" source={sources.variant} testId="stock-new-variant" disabled={locked} />
            <Field label="Colour / finish" value={colour} onChange={(v) => { setColour(v); typed("colourFinish"); }} source={sources.colourFinish} testId="stock-new-colour" disabled={locked} />
            <Field label="Supplier SKU" value={sku} onChange={(v) => { setSku(v); typed("supplierSku"); }} placeholder="Optional" source={sources.supplierSku} testId="stock-new-sku" disabled={locked} />
            <Field label="Supplier" value={supplier} onChange={setSupplier} placeholder="Optional" testId="stock-new-supplier" disabled={locked} />
          </div>
          {barcode ? (
            <p className="flex items-center justify-between text-sm text-text">
              <span>
                Barcode <span className="font-mono">{barcode}</span> <Tag>Read from photo</Tag>
              </span>
              <button type="button" onClick={() => setBarcode(null)} className="min-h-[44px] px-2 font-semibold text-state-info underline" disabled={locked}>Remove</button>
            </p>
          ) : null}
          {lookupEnabled && code.trim() && (lookupState === "idle" || codeChangedSinceCheck || checkStale) ? (
            <LinkButton onClick={() => void runLookup()} disabled={locked} data-testid="stock-new-check">
              {checkStale ? "Check it again with these details" : "Check this code online"}
            </LinkButton>
          ) : null}
          <LookupCard state={lookupState} result={codeChangedSinceCheck ? null : lookup} accepted={accepted} onAccept={accept} onReject={() => setAccepted(false)} onRetry={() => void runLookup()} />
        </div>
      ) : null}

      {error && !dupe ? (
        <Slot tone={phase === "uncertain" ? "warn" : "bad"} role="alert">
          <span data-testid="stock-new-error">{error}</span>
        </Slot>
      ) : null}

      <div className="sticky bottom-0 -mx-4 mt-auto space-y-2.5 border-t border-border bg-surface px-4 pb-3 pt-3">
        {phase === "uncertain" ? (
          <>
            <BigButton variant="pri" label="Try again" sub="safe · can never make a second item" onClick={() => { if (keyRef.current && requestRef.current) void send(requestRef.current, keyRef.current); }} data-testid="stock-new-retry" />
            <BigButton variant="sec" label="Check if it saved" onClick={() => void checkSaved()} />
          </>
        ) : (
          <>
            <p className="flex items-center gap-2 text-[13px] font-semibold text-text" data-testid="stock-new-code-status" data-status={listingStatus ?? (checkStale ? "stale" : "unverified")}>
              <span aria-hidden="true" className={cn("inline-block h-2 w-2 shrink-0 rounded-full", STATUS_DOT[savesAs])} />
              <span>
                Saves as: {VERIFICATION_LABEL[savesAs]}
                {checkStale ? " — the details changed since the online check, so it no longer counts. Check again to use it." : ""}
              </span>
            </p>
            {dupe ? <p className="text-sm font-medium text-state-danger-subtle-text">Can&rsquo;t save a new item with code {dupe.manufacturerCode ?? code.trim()} — another item already uses it.</p> : null}
            {canSave ? <SavesLine>{savesWithPhoto}</SavesLine> : null}
            {emphasis === "another" ? (
              <>
                {saveAnother}
                {saveOnly}
              </>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {saveOnly}
                {saveAnother}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
