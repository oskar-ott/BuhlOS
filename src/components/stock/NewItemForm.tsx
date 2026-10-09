"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PhilActionButton } from "@/components/phil/ui/PhilActionButton";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { cn } from "@/lib/cn";
import { createItem, fetchOperation, lookupCode, newOperationKey, storePhoto, type CreateInput } from "@/domains/workshop-stock/client";
import { errorCopy, formatQuantity, packLabel, toQuantityString, UNIT_LABEL, VERIFICATION_LABEL } from "@/domains/workshop-stock/format";
import { packSuggestion, suggestName } from "@/domains/workshop-stock/flow";
import { clearPending, isUncertain, rememberPending } from "@/domains/workshop-stock/pending";
import { PACK_UNITS, UNIT_KEYS, type LookupResult, type PackUnit, type ReadProduct, type StockItem, type StockUnit, type WriteResult } from "@/domains/workshop-stock/schema";
import { LookupCard } from "./LookupCard";
import { QuantityStepper } from "./QuantityStepper";

type Source = "photo" | "lookup" | "typed";

export interface NewItemSeed {
  product: ReadProduct | null;
  photoId: string | null;
  dataUrl: string | null;
}

function Field({ label, value, onChange, placeholder, source, testId, inputMode, disabled }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; source?: Source; testId: string; inputMode?: "text" | "numeric"; disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between font-display text-sm font-semibold text-text">
        {label}
        {source && source !== "typed" && value ? <span className="text-xs font-normal text-text-muted">{source === "photo" ? "read from photo" : "from the listing"}</span> : null}
      </span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} inputMode={inputMode} autoComplete="off" className="mt-1 h-12 w-full rounded-card border border-border-strong bg-surface px-3 text-base text-text disabled:opacity-60" data-testid={testId} />
    </label>
  );
}

/**
 * The one short form for a NEW workshop item (Workshop Stock).
 *
 * Pre-filled from what the photo shows (labelled "read from photo"), checked
 * against a public listing when a code was read (labelled "from the listing"
 * once accepted), confirmed by the worker. Asks only for what a new item needs:
 * the name, the unit, where it lives, and how many are going on the shelf. A
 * printed pack size is OFFERED as a conversion, never applied silently. The
 * item, its codes, its photo and its opening count save together or not at all.
 */
export function NewItemForm({
  seed,
  items,
  lookupEnabled,
  onSaved,
  onUseExisting,
}: {
  seed: NewItemSeed;
  items: StockItem[];
  lookupEnabled: boolean;
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
  const [location, setLocation] = useState("");
  const [qtyMilli, setQtyMilli] = useState(1000);
  const [packMode, setPackMode] = useState(false);
  const [packCount, setPackCount] = useState(1);
  const [packSizeText, setPackSizeText] = useState("");
  const [packUnit, setPackUnit] = useState<PackUnit>("box");
  const [rememberPack, setRememberPack] = useState(true);
  const [estimated, setEstimated] = useState(false);
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
  const keyRef = useRef<string | null>(null);
  const requestRef = useRef<CreateInput | null>(null);
  const againRef = useRef(false);

  const suggestion = packSuggestion(p, unit);
  const locations = useMemo(() => {
    const count = new Map<string, number>();
    for (const i of items) if (i.location && !i.archivedAt) count.set(i.location, (count.get(i.location) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l]) => l);
  }, [items]);

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
    setLookup(r.ok ? r.data : { status: "unavailable", reasons: [errorCopy(r.error.status, r.error.body, "Couldn't check online right now — save it and check later.")], candidate: null, sources: [] } as LookupResult);
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

  function accept() {
    setAccepted(true);
    const c = lookup?.candidate;
    if (!c) return;
    if (c.name && (sources.name !== "typed" || !name.trim())) { setName(c.name.slice(0, 160)); setSources((s) => ({ ...s, name: "lookup" })); }
    if (c.brand && !brand.trim()) { setBrand(c.brand); setSources((s) => ({ ...s, brand: "lookup" })); }
    if (c.colour && !colour.trim()) { setColour(c.colour); setSources((s) => ({ ...s, colourFinish: "lookup" })); }
  }

  const codeChangedSinceCheck = checkedCode !== null && checkedCode !== code.trim();
  // What the item will be saved as (the server re-derives it from its own cached check).
  const listingStatus = accepted === true && !codeChangedSinceCheck && (lookup?.status === "manufacturer_code_matched" || lookup?.status === "possible_match") ? lookup.status : null;
  const canSave = !locked && name.trim().length > 0 && location.trim().length > 0 && (packMode ? Boolean(packSizeMilli) : true);

  async function send(request: CreateInput, key: string) {
    setPhase("saving");
    setError(null);
    const r = await createItem(request, key);
    if (r.ok) {
      clearPending();
      keyRef.current = null;
      setPhase("edit");
      onSaved(r.data, againRef.current);
      return;
    }
    if (isUncertain(r.error.status)) {
      setPhase("uncertain");
      setError("Not sure it saved — no signal. Tap Try again: it won't make a second item.");
      return;
    }
    clearPending();
    keyRef.current = null;
    setPhase("edit");
    const body = r.error.body as { error?: string; existing?: Array<{ itemId: string; itemName: string; value: string }> } | null;
    if (body?.error === "duplicate_item" && body.existing?.length) {
      setDuplicates(body.existing);
      setError("This code is already in the workshop list.");
      return;
    }
    setError(errorCopy(r.error.status, r.error.body));
  }

  async function save(again: boolean) {
    if (!canSave) return;
    againRef.current = again;
    setDuplicates([]);
    let pid = photoId;
    if (!pid && seed.dataUrl) {
      const s = await storePhoto(seed.dataUrl);
      if (s.ok) { pid = s.data.photoId; setPhotoId(pid); }
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
      estimated,
      useLookup: accepted === true && !codeChangedSinceCheck,
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
      clearPending();
      keyRef.current = null;
      setPhase("edit");
      onSaved({ item: r.data.item, movement: r.data.movement, replayed: true }, againRef.current);
      return;
    }
    if (r.ok && !r.data.found) {
      clearPending();
      keyRef.current = null;
      setPhase("edit");
      setError("It didn't save. Check the details and save again.");
      return;
    }
    setPhase("uncertain");
    setError("Still can't reach the office. Try again in a moment.");
  }

  return (
    <div className="space-y-4" data-testid="stock-new-item">
      {seed.dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- local preview
        <img src={seed.dataUrl} alt="Your photo of the product" className="h-28 w-28 rounded-card border border-border object-cover" />
      ) : null}

      <Field label="Name" value={name} onChange={(v) => { setName(v); typed("name"); }} placeholder="e.g. Clipsal double GPO" source={sources.name} testId="stock-new-name" disabled={locked} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Brand" value={brand} onChange={(v) => { setBrand(v); typed("brand"); }} source={sources.brand} testId="stock-new-brand" disabled={locked} />
        <Field label="Manufacturer code" value={code} onChange={(v) => { setCode(v); typed("manufacturerCode"); }} placeholder="as printed" source={sources.manufacturerCode} testId="stock-new-code" disabled={locked} />
      </div>
      {lookupEnabled && code.trim() && (lookupState === "idle" || codeChangedSinceCheck) ? (
        <button type="button" onClick={() => void runLookup()} disabled={locked} className="min-h-[44px] text-sm font-semibold text-brand-navy" data-testid="stock-new-check">
          Check this code online
        </button>
      ) : null}
      <LookupCard state={lookupState} result={codeChangedSinceCheck ? null : lookup} accepted={accepted} onAccept={accept} onReject={() => setAccepted(false)} onRetry={() => void runLookup()} />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Colour / finish" value={colour} onChange={(v) => { setColour(v); typed("colourFinish"); }} source={sources.colourFinish} testId="stock-new-colour" disabled={locked} />
        <Field label="Size / rating" value={variant} onChange={(v) => { setVariant(v); typed("variant"); }} placeholder="as printed" source={sources.variant} testId="stock-new-variant" disabled={locked} />
      </div>
      {sku || p?.supplierSku ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Supplier SKU" value={sku} onChange={(v) => { setSku(v); typed("supplierSku"); }} source={sources.supplierSku} testId="stock-new-sku" disabled={locked} />
          <Field label="Supplier" value={supplier} onChange={setSupplier} testId="stock-new-supplier" disabled={locked} />
        </div>
      ) : null}
      {barcode ? (
        <p className="flex items-center justify-between text-sm text-text-muted">
          <span>Barcode {barcode} (read from photo)</span>
          <button type="button" onClick={() => setBarcode(null)} className="min-h-[44px] px-2 font-semibold text-brand-navy" disabled={locked}>Remove</button>
        </p>
      ) : null}

      <fieldset className="space-y-1.5">
        <legend className="font-display text-sm font-semibold text-text">Counted in</legend>
        <div className="flex flex-wrap gap-2">
          {UNIT_KEYS.map((u) => (
            <button key={u} type="button" onClick={() => { setUnit(u); setQtyMilli(1000); }} aria-pressed={unit === u} disabled={locked} className={cn("min-h-[44px] rounded-pill border px-3 text-sm font-semibold", unit === u ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border-strong text-text")} data-testid={`stock-new-unit-${u}`}>
              {UNIT_LABEL[u].chip}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <Field label="Where it lives in the workshop" value={location} onChange={setLocation} placeholder="e.g. Shelf A2, Bin 4" testId="stock-new-location" disabled={locked} />
        {locations.length ? (
          <div className="flex flex-wrap gap-2">
            {locations.map((l) => (
              <button key={l} type="button" onClick={() => setLocation(l)} disabled={locked} className="min-h-[40px] rounded-pill border border-border px-3 text-sm text-text hover:border-brand-navy">{l}</button>
            ))}
          </div>
        ) : null}
      </div>

      {suggestion && !packMode ? (
        <button type="button" onClick={() => { setPackMode(true); setPackSizeText(String(suggestion.sizeMilli / 1000)); }} disabled={locked} className="w-full rounded-card border border-dashed border-border-strong p-3 text-left text-sm text-text" data-testid="stock-new-pack-suggest">
          {suggestion.label}. Count it in full packs? <span className="font-semibold text-brand-navy">Use packs</span>
        </button>
      ) : null}
      <label className="flex min-h-[48px] cursor-pointer items-center gap-3 rounded-card border border-border px-3">
        <input type="checkbox" checked={packMode} onChange={(e) => { setPackMode(e.target.checked); if (e.target.checked && unit === "metre") setPackUnit("roll"); }} disabled={locked} className="h-5 w-5" data-testid="stock-new-pack-mode" />
        <span className="text-sm text-text">Adding full, unopened boxes, packs or rolls</span>
      </label>
      {packMode ? (
        <div className="space-y-2 rounded-card border border-border p-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Pack type">
            {PACK_UNITS.slice(0, 6).map((u) => (
              <button key={u} type="button" onClick={() => setPackUnit(u)} aria-pressed={packUnit === u} disabled={locked} className={cn("min-h-[40px] rounded-pill border px-3 text-sm", packUnit === u ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border text-text")}>
                {u}
              </button>
            ))}
          </div>
          <QuantityStepper label={`How many ${packLabel(packUnit, 2)}`} valueMilli={packCount * 1000} onChange={(m) => setPackCount(Math.max(1, Math.round(m / 1000)))} unit="each" unitLabel={packLabel(packUnit, packCount)} disabled={locked} testId="stock-new-packs" />
          <label className="block">
            <span className="font-display text-sm font-semibold text-text">{unit === "each" ? `How many in each ${packUnit}` : `${UNIT_LABEL[unit].chip} in each ${packUnit}`}</span>
            <input value={packSizeText} onChange={(e) => setPackSizeText(e.target.value)} inputMode={UNIT_LABEL[unit].decimals ? "decimal" : "numeric"} className="mt-1 h-12 w-full rounded-card border border-border-strong bg-surface px-3 text-base" data-testid="stock-new-pack-size" disabled={locked} />
          </label>
          <p className="text-sm font-semibold text-text" data-testid="stock-new-pack-total">{packSizeMilli ? `= ${formatQuantity(totalMilli, unit)} going on the shelf` : `Enter how many are in each ${packUnit}`}</p>
          <label className="flex min-h-[44px] items-center gap-3 text-sm text-text">
            <input type="checkbox" checked={rememberPack} onChange={(e) => setRememberPack(e.target.checked)} className="h-5 w-5" disabled={locked} />
            Remember this pack size for next time
          </label>
          <p className="text-xs text-text-muted">Only for full, unopened packs — the packaging doesn&rsquo;t prove what&rsquo;s left in an opened one, and a part-used roll needs its metres counted.</p>
        </div>
      ) : (
        <QuantityStepper label="How many going on the shelf" valueMilli={qtyMilli} onChange={setQtyMilli} unit={unit} allowZero disabled={locked} testId="stock-new-qty" />
      )}

      <label className="flex min-h-[48px] cursor-pointer items-center gap-3 rounded-card border border-border px-3">
        <input type="checkbox" checked={estimated} onChange={(e) => setEstimated(e.target.checked)} className="h-5 w-5" disabled={locked} data-testid="stock-new-estimated" />
        <span className="text-sm text-text">This count is an estimate (e.g. a part-used roll)</span>
      </label>

      {error ? (
        <PhilNotice tone={phase === "uncertain" ? "warning" : "danger"} role="alert">
          <span data-testid="stock-new-error">{error}</span>
          {duplicates.length ? (
            <span className="mt-2 block space-y-1">
              {duplicates.map((d) => {
                const it = items.find((i) => i.id === d.itemId);
                return it ? (
                  <button key={d.itemId} type="button" onClick={() => onUseExisting(it)} className="block min-h-[44px] font-semibold text-brand-navy underline" data-testid="stock-new-use-existing">
                    Add to “{d.itemName}” instead
                  </button>
                ) : (
                  <span key={d.itemId} className="block">Already listed as “{d.itemName}” ({d.value}).</span>
                );
              })}
            </span>
          ) : null}
        </PhilNotice>
      ) : null}

      {phase === "uncertain" ? (
        <div className="grid grid-cols-2 gap-2">
          <PhilActionButton size="lg" onClick={() => { if (keyRef.current && requestRef.current) void send(requestRef.current, keyRef.current); }} data-testid="stock-new-retry">Try again</PhilActionButton>
          <button type="button" onClick={() => void checkSaved()} className="min-h-[48px] rounded-card border border-border-strong px-3 font-semibold text-text">Check if it saved</button>
        </div>
      ) : (
        <div className="space-y-2">
          {!location.trim() ? <p className="text-xs text-text-muted">Add where it lives so the next person can find it.</p> : null}
          <p className="text-xs text-text-muted" data-testid="stock-new-code-status">
            Code status: <span className="font-semibold text-text">{VERIFICATION_LABEL[listingStatus ?? "unverified"]}</span>
            {listingStatus ? " (the listing you accepted)" : ""}
          </p>
          <PhilActionButton size="lg" onClick={() => void save(false)} disabled={!canSave} aria-busy={phase === "saving"} className="min-h-[56px]" data-testid="stock-new-save">
            {phase === "saving" ? "Saving…" : "Save"}
          </PhilActionButton>
          <button type="button" onClick={() => void save(true)} disabled={!canSave} className="min-h-[56px] w-full rounded-card border border-border-strong font-semibold text-text disabled:opacity-60" data-testid="stock-new-save-another">
            Save and add another
          </button>
        </div>
      )}
    </div>
  );
}
