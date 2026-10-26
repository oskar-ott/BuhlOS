"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { LookupCard } from "@/components/stock/LookupCard";
import { cn } from "@/lib/cn";
import { addIdentifier, editItem, lookupCode, newOperationKey, recordCount, recordVerification, removeIdentifier } from "@/domains/workshop-stock/client";
import { clockTime, errorCopy, formatNumber, formatQuantity, movementSummary, movementWho, parseTypedQuantity, toQuantityString, UNIT_LABEL, VERIFICATION_LABEL, whenLabel } from "@/domains/workshop-stock/format";
import { PACK_UNITS, UNIT_KEYS, type LookupResult, type PackUnit, type StockItem, type StockMovement, type StockUnit, type WriteResult } from "@/domains/workshop-stock/schema";
import { CODE_TONE } from "./StockAdminClient";

export const INPUT = "h-9 w-full rounded-[4px] border border-border-strong bg-surface px-2.5 text-sm text-text disabled:bg-surface-subtle disabled:text-text-muted";
export const LABEL = "block text-xs font-semibold text-text-muted";

function Err({ text }: { text: string | null }) {
  return text ? <p role="alert" className="text-sm text-state-danger">{text}</p> : null;
}

/** A designed state inside the drawer (a guard, a conflict, a confirmation) — never an alert box. */
export function Block({ tone, title, children, className, testId, role }: { tone: "warn" | "bad" | "inf" | "neu"; title: string; children: React.ReactNode; className?: string; testId?: string; role?: "alert" | "status" }) {
  const box = { warn: "border-state-warning-subtle-border bg-state-warning-subtle-bg", bad: "border-state-danger-subtle-border bg-state-danger-subtle-bg", inf: "border-state-info-subtle-border bg-state-info-subtle-bg", neu: "border-border bg-surface-subtle" }[tone];
  return (
    <div role={role} className={cn("space-y-1.5 rounded-card border p-3", box, className)} data-testid={testId}>
      <p className="font-display text-[15px] font-semibold text-text">{title}</p>
      <div className="space-y-1.5 text-sm text-text">{children}</div>
    </div>
  );
}

/**
 * Physical count → the recorded balance, with a stale-count guard: the count
 * is pinned to the ledger version when the drawer opened (counting since …).
 * If anything moved in the meantime the server refuses and returns those
 * movements; the counter decides whether their count already reflects them.
 */
export function CountForm({ item, onSaved }: { item: StockItem; onSaved: (r: WriteResult) => void }) {
  const [started, setStarted] = useState(() => ({ version: item.version, balanceMilli: item.balanceMilli, at: new Date().toISOString() }));
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [estimated, setEstimated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<{ currentVersion: number; balanceMilli: number; since: StockMovement[] } | null>(null);

  const unit = item.baseUnit;
  const counted = parseTypedQuantity(text, unit, { allowZero: true });
  const ready = counted !== null && reason.trim().length >= 3;

  async function submit(version: number) {
    if (counted === null || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    const r = await recordCount({ itemId: item.id, countedQuantity: toQuantityString(counted), expectedVersion: version, reason: reason.trim(), estimated }, newOperationKey());
    setBusy(false);
    if (r.ok) {
      setText(""); setReason(""); setStale(null); setEstimated(false);
      setStarted({ version: r.data.item.version, balanceMilli: r.data.item.balanceMilli, at: new Date().toISOString() });
      onSaved(r.data);
      return;
    }
    const body = r.error.body as { error?: string; currentVersion?: number; balanceMilli?: number; since?: StockMovement[] } | null;
    if (body?.error === "stock_changed" && typeof body.currentVersion === "number") {
      setStale({ currentVersion: body.currentVersion, balanceMilli: body.balanceMilli ?? 0, since: body.since ?? [] });
      return;
    }
    setError(errorCopy(r.error.status, r.error.body));
  }

  const diff = (against: number) => {
    if (counted === null) return "";
    const d = counted - against;
    if (d === 0) return "the same as recorded";
    return `${formatQuantity(Math.abs(d), unit)} ${d > 0 ? "more" : "less"} than recorded`;
  };
  const clears = item.estimated && !estimated ? " Clears the estimate." : estimated ? " Saved as an estimate." : "";

  return (
    <div className="space-y-2.5" data-testid="stock-count-form">
      <p className="flex items-start gap-1.5 rounded-[4px] bg-surface-subtle px-2.5 py-1.5 text-xs text-text-muted">
        <Lock aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Counting since {clockTime(started.at)} — movements after this will be shown before you save.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className={LABEL}>Counted on the shelf</span>
          <div className={cn(INPUT, "mt-1 flex items-center gap-1 px-0")}>
            <input value={text} onChange={(e) => setText(e.target.value)} inputMode={UNIT_LABEL[unit].decimals ? "decimal" : "numeric"} className="h-full min-w-0 flex-1 rounded-[4px] bg-transparent px-2.5 font-semibold text-text outline-none" data-testid="stock-count-qty" disabled={busy} />
            <span className="pr-2.5 text-[13px] text-text-muted">{UNIT_LABEL[unit].plural}</span>
          </div>
        </label>
        <label className="block">
          <span className={LABEL}>Reason</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. monthly shelf count" className={cn(INPUT, "mt-1")} data-testid="stock-count-reason" disabled={busy} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-text"><input type="checkbox" checked={estimated} onChange={(e) => setEstimated(e.target.checked)} className="h-4 w-4 accent-brand-navy" /> Estimate (e.g. a part-used roll)</label>
      {stale ? (
        <Block tone="warn" title="Stock changed while you were counting" testId="stock-count-stale" role="alert">
          <p>You started counting at {clockTime(started.at)}, when {formatQuantity(started.balanceMilli, unit)} were recorded. Since then:</p>
          <ul className="divide-y divide-state-warning-subtle-border">
            {stale.since.map((m) => (
              <li key={m.id} className="py-1.5">
                <span className="block font-semibold text-text">{movementSummary(m, unit)}</span>
                <span className="block text-xs text-text-muted">{movementWho(m)} · then {formatQuantity(m.balanceAfterMilli, unit)}</span>
              </li>
            ))}
          </ul>
          <p>Recorded now: {formatQuantity(stale.balanceMilli, unit)}. Your count: {counted === null ? "—" : formatQuantity(counted, unit)}. Not saved yet.</p>
          <div className="flex flex-col gap-2 pt-1">
            <Button type="button" size="sm" className="h-auto flex-col items-start gap-0 px-3 py-2 text-left sm:h-auto" onClick={() => void submit(stale.currentVersion)} disabled={busy || counted === null} data-testid="stock-count-confirm-stale">
              <span>My count is right — save it</span>
              <span className="text-xs font-normal text-text-inverse/80">saves Counted {counted === null ? "—" : formatQuantity(counted, unit)} · {diff(stale.balanceMilli)} now</span>
            </Button>
            <Button type="button" variant="secondary" size="sm" className="h-auto flex-col items-start gap-0 px-3 py-2 text-left sm:h-auto" onClick={() => { setStale(null); setStarted({ version: stale.currentVersion, balanceMilli: stale.balanceMilli, at: new Date().toISOString() }); setText(""); }}>
              <span>Count again</span>
              <span className="text-xs font-normal text-text-muted">clears your number · starts a new count from now</span>
            </Button>
          </div>
        </Block>
      ) : (
        <>
          {counted !== null ? <p className="rounded-[4px] bg-surface-subtle px-2.5 py-1.5 text-sm font-medium text-text">Saves: Counted {formatQuantity(counted, unit)} — {diff(started.balanceMilli)}.{clears}</p> : null}
          <Button type="button" size="sm" onClick={() => void submit(started.version)} disabled={busy || !ready || Boolean(item.archivedAt)} data-testid="stock-count-save">
            {busy ? "Saving…" : `Save count${counted !== null ? ` · ${formatQuantity(counted, unit)}` : ""}`}
          </Button>
        </>
      )}
      <Err text={error} />
    </div>
  );
}

type EditFields = {
  name: string; brand: string; manufacturerCode: string; supplierSku: string; supplierName: string; variant: string; colourFinish: string;
  location: string; baseUnit: StockUnit; packUnit: PackUnit | ""; packSize: string;
};

const FIELD_NAME: Record<keyof EditFields, string> = {
  name: "Name", brand: "Brand", manufacturerCode: "Maker's code", supplierSku: "Supplier SKU", supplierName: "Supplier", variant: "Size / rating", colourFinish: "Colour / finish", location: "Shelf", baseUnit: "Counted in", packUnit: "Default pack", packSize: "Per pack",
};

function fieldsOf(item: StockItem): EditFields {
  return {
    name: item.name, brand: item.brand ?? "", manufacturerCode: item.manufacturerCode ?? "", supplierSku: item.supplierSku ?? "",
    supplierName: item.supplierName ?? "", variant: item.variant ?? "", colourFinish: item.colourFinish ?? "", location: item.location ?? "",
    baseUnit: item.baseUnit, packUnit: (item.defaultPack?.unit ?? "") as PackUnit | "", packSize: item.defaultPack ? formatNumber(item.defaultPack.sizeMilli) : "",
  };
}

/**
 * Office catalogue edit (compare-and-set on the item's revision). The form
 * remembers the revision it started from: a reload with nothing typed simply
 * shows the new details; with edits in progress they are kept, and the form
 * says someone else changed the item (the server would refuse a blind save).
 */
export function EditForm({ item, unitLocked, onSaved }: { item: StockItem; unitLocked: boolean; onSaved: (i: StockItem) => void }) {
  const [base, setBase] = useState<StockItem>(item);
  const [f, setF] = useState<EditFields>(() => fieldsOf(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const set = (k: keyof EditFields) => (e: { target: { value: string } }) => { setSavedNote(null); setF((x) => ({ ...x, [k]: e.target.value })); };
  const baseFields = fieldsOf(base);
  const changed = (Object.keys(f) as Array<keyof EditFields>).filter((k) => f[k] !== baseFields[k]);
  const dirty = changed.length > 0;
  const stale = item.metaRevision !== base.metaRevision;

  useEffect(() => {
    if (item.metaRevision !== base.metaRevision && !dirty) {
      setBase(item);
      setF(fieldsOf(item));
    }
  }, [item, base.metaRevision, dirty]);

  function takeTheirs() {
    setBase(item);
    setF(fieldsOf(item));
    setError(null);
  }

  async function save() {
    setBusy(true); setError(null); setSavedNote(null);
    const patch: Record<string, unknown> & { expectedRevision: number } = { expectedRevision: base.metaRevision };
    const text = (k: "name" | "brand" | "manufacturerCode" | "supplierSku" | "supplierName" | "variant" | "colourFinish" | "location") => {
      const cur = (base[k] ?? "") as string;
      if (f[k].trim() !== cur) patch[k] = f[k].trim() || (k === "name" ? cur : null);
    };
    (["name", "brand", "manufacturerCode", "supplierSku", "supplierName", "variant", "colourFinish", "location"] as const).forEach(text);
    if (f.baseUnit !== base.baseUnit) patch.baseUnit = f.baseUnit;
    const packChanged = (f.packUnit || null) !== (base.defaultPack?.unit ?? null) || (f.packSize || "") !== (base.defaultPack ? formatNumber(base.defaultPack.sizeMilli) : "");
    if (packChanged) patch.defaultPack = f.packUnit && f.packSize ? { unit: f.packUnit, size: f.packSize } : null;
    const r = await editItem(base.id, patch);
    setBusy(false);
    if (r.ok) {
      setBase(r.data.item);
      setF(fieldsOf(r.data.item));
      setSavedNote(r.data.unchanged ? "Nothing changed." : "Saved.");
      onSaved(r.data.item);
      return;
    }
    setError(errorCopy(r.error.status, r.error.body));
  }

  const text = (k: keyof EditFields, full = false) => (
    <label className={cn("block", full && "col-span-2")}>
      <span className={LABEL}>{FIELD_NAME[k]}</span>
      <input value={f[k] as string} onChange={set(k)} className={cn(INPUT, "mt-1", stale && f[k] !== baseFields[k] && "border-2 border-brand-navy")} data-testid={`stock-edit-${k}`} />
    </label>
  );
  return (
    <div className="space-y-3" data-testid="stock-edit-form">
      {stale ? (
        <Block tone="warn" title="Someone changed this item since you started editing" testId="stock-edit-stale" role="status">
          <p>
            Their version is newer than the one this form started from.{dirty ? ` Your edits weren't saved: ${changed.map((k) => `${FIELD_NAME[k]} → ${String(f[k]) || "—"}`).join(", ")}.` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="button" size="sm" onClick={takeTheirs} data-testid="stock-edit-reload">Load their version</Button>
            <span className="text-xs text-text-muted">your edits here are dropped</span>
          </div>
        </Block>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {text("name", true)}
        {text("brand")}
        {text("manufacturerCode")}
        {text("colourFinish")}
        {text("variant")}
        {text("location")}
        <label className="block">
          <span className={LABEL}>Default pack</span>
          <div className="mt-1 grid grid-cols-2 gap-1">
            <select value={f.packUnit} onChange={set("packUnit")} className={INPUT} aria-label="Default pack type">
              <option value="">None</option>
              {PACK_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <input value={f.packSize} onChange={set("packSize")} disabled={!f.packUnit} inputMode="decimal" placeholder={UNIT_LABEL[f.baseUnit].plural} aria-label={`${UNIT_LABEL[f.baseUnit].plural} per pack`} className={INPUT} />
          </div>
        </label>
        {text("supplierSku")}
        {text("supplierName")}
      </div>
      <div>
        <span className={LABEL}>Counted in</span>
        {unitLocked ? (
          <>
            <p className={cn(INPUT, "mt-1 flex items-center justify-between bg-surface-subtle text-text-muted")} data-testid="stock-edit-unit">
              {UNIT_LABEL[item.baseUnit].chip} <Lock aria-hidden="true" className="h-3.5 w-3.5" />
            </p>
            <p className="mt-1 text-xs text-text-muted">Locked because stock has moved. To count it another way, archive this item and add it again.</p>
          </>
        ) : (
          <select value={f.baseUnit} onChange={set("baseUnit")} className={cn(INPUT, "mt-1")} data-testid="stock-edit-unit">
            {UNIT_KEYS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u].chip}</option>)}
          </select>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy || !dirty || stale} data-testid="stock-edit-save">{busy ? "Saving…" : "Save details"}</Button>
        {stale && dirty ? <span className="text-xs text-text-muted">Can&rsquo;t save over their change — load their version first.</span> : savedNote ? <span className="text-sm text-text-muted">{savedNote}</span> : null}
      </div>
      <Err text={error} />
    </div>
  );
}

const KIND_WORD = { manufacturer_code: "maker's code", supplier_sku: "supplier SKU", barcode: "barcode" } as const;

/** Codes, SKUs and barcodes the item is recognised by, with optional pack conversions. */
export function IdentifiersEditor({ item, onChanged }: { item: StockItem; onChanged: (i: StockItem) => void }) {
  const [kind, setKind] = useState<"manufacturer_code" | "supplier_sku" | "barcode">("barcode");
  const [value, setValue] = useState("");
  const [supplier, setSupplier] = useState("");
  const [packUnit, setPackUnit] = useState<PackUnit | "">("");
  const [packSize, setPackSize] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const LABELS = { manufacturer_code: "Maker's code", supplier_sku: "Supplier SKU", barcode: "Barcode" };

  async function add() {
    setBusy(true); setError(null);
    const r = await addIdentifier({ itemId: item.id, kind, value: value.trim(), supplierName: kind === "supplier_sku" ? supplier.trim() || null : null, ...(packUnit && packSize ? { packUnit, packSize } : {}) });
    setBusy(false);
    if (r.ok) { setValue(""); setPackUnit(""); setPackSize(""); onChanged(r.data.item); return; }
    setError(errorCopy(r.error.status, r.error.body));
  }
  async function remove(id: string) {
    setBusy(true); setError(null);
    const r = await removeIdentifier(id);
    setBusy(false);
    if (r.ok) onChanged(r.data.item); else setError(errorCopy(r.error.status, r.error.body));
  }

  return (
    <div className="space-y-2" data-testid="stock-identifiers">
      <ul className="divide-y divide-border">
        {item.identifiers.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
            <span className="min-w-0 text-text">
              <span className="font-mono">{i.value}</span> · {KIND_WORD[i.kind]}
              {i.kind === "manufacturer_code" && i.value === item.manufacturerCode ? " · shown on the item" : ""}
              {i.packUnit && i.packSizeMilli ? ` on a ${i.packUnit} of ${formatQuantity(i.packSizeMilli, item.baseUnit)}` : ""}
              {i.kind === "supplier_sku" && i.scope ? <span className="text-text-muted"> · {i.scope}</span> : null}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => void remove(i.id)} disabled={busy} className="text-state-danger">Remove</Button>
          </li>
        ))}
        {!item.identifiers.length ? <li className="py-1.5 text-sm text-text-muted">No codes yet — photo matching falls back to the description.</li> : null}
      </ul>
      <div className="grid grid-cols-2 gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={INPUT} aria-label="Code type">
          {(Object.keys(LABELS) as Array<keyof typeof LABELS>).map((k) => <option key={k} value={k}>{LABELS[k]}</option>)}
        </select>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="as printed" aria-label="Code" className={INPUT} data-testid="stock-identifier-value" />
        {kind === "supplier_sku" ? <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Supplier" aria-label="Supplier" className={INPUT} /> : null}
        <select value={packUnit} onChange={(e) => setPackUnit(e.target.value as PackUnit | "")} className={INPUT} aria-label="This code is on a pack of">
          <option value="">Single item</option>
          {PACK_UNITS.map((u) => <option key={u} value={u}>On a {u} of…</option>)}
        </select>
        {packUnit ? <input value={packSize} onChange={(e) => setPackSize(e.target.value)} inputMode="decimal" placeholder={`${UNIT_LABEL[item.baseUnit].plural} per ${packUnit}`} aria-label="Pack size" className={INPUT} /> : null}
      </div>
      <Button type="button" size="sm" variant="secondary" onClick={() => void add()} disabled={busy || value.trim().length < 2 || (Boolean(packUnit) && !packSize)} data-testid="stock-identifier-add">Add code</Button>
      <Err text={error} />
    </div>
  );
}

/** Office: run (or re-run) the online check and record it on the item. */
export function CheckSection({ item, lookupEnabled, onChanged }: { item: StockItem; lookupEnabled: boolean; onChanged: (i: StockItem) => void }) {
  const [state, setState] = useState<"idle" | "checking" | "done">("idle");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = item.verification;

  async function check() {
    if (!item.manufacturerCode) return;
    setState("checking"); setError(null);
    // exactly the item's own brand / code / colour / size — the check "Record" then reads back
    const r = await lookupCode({ brand: item.brand, manufacturerCode: item.manufacturerCode, colourFinish: item.colourFinish, variantDetails: item.variant ?? "", refresh: true });
    setState("done");
    if (r.ok) setResult(r.data); else setError(errorCopy(r.error.status, r.error.body, "Couldn't check online right now."));
  }
  async function record() {
    const r = await recordVerification(item.id);
    if (r.ok) { onChanged(r.data.item); setResult(null); setState("idle"); } else setError(errorCopy(r.error.status, r.error.body));
  }

  return (
    <div className="space-y-2" data-testid="stock-check">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Pill tone={CODE_TONE[item.verificationStatus]} dot className="font-medium normal-case tracking-normal">{VERIFICATION_LABEL[item.verificationStatus]}</Pill>
        {v?.checkedAt ? <span className="text-xs text-text-muted">recorded {whenLabel(v.checkedAt)}</span> : null}
      </div>
      {v?.sourceUrl ? <a href={v.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-sm text-state-info underline">{v.sourceDomain || v.sourceUrl}{v.codeAsWritten ? ` · ${v.codeAsWritten}` : ""}</a> : null}
      {v?.reasons?.length ? <p className="text-xs text-text-muted">{v.reasons.join(" · ")}</p> : null}
      {lookupEnabled && item.manufacturerCode ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => void check()} disabled={state === "checking"} data-testid="stock-check-run">{v?.checkedAt ? "Re-run the check" : "Check code online"}</Button>
      ) : <p className="text-xs text-text-muted">{item.manufacturerCode ? "The online check isn't set up." : "Add a maker's code to check it online."}</p>}
      <LookupCard state={state} result={result} accepted={null} onAccept={() => void record()} onReject={() => { setResult(null); setState("idle"); }} acceptLabel="Record this check on the item" />
      <Err text={error} />
    </div>
  );
}

