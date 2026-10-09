"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { LookupCard } from "@/components/stock/LookupCard";
import { addIdentifier, editItem, lookupCode, newOperationKey, recordCount, recordVerification, removeIdentifier } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, formatNumber, formatQuantity, movementSummary, parseTypedQuantity, timeAgo, toQuantityString, UNIT_LABEL, VERIFICATION_LABEL } from "@/domains/workshop-stock/format";
import { PACK_UNITS, UNIT_KEYS, type LookupResult, type PackUnit, type StockItem, type StockMovement, type StockUnit, type WriteResult } from "@/domains/workshop-stock/schema";

const INPUT = "h-9 w-full rounded-[4px] border border-border bg-surface px-2 text-sm";
const LABEL = "block text-xs font-semibold uppercase tracking-wide text-text-muted";

function Err({ text }: { text: string | null }) {
  return text ? <p role="alert" className="text-sm text-state-danger">{text}</p> : null;
}

/**
 * Physical count → the recorded balance, with a stale-count guard: the count
 * is pinned to the ledger version when counting STARTED. If anything moved in
 * the meantime the server refuses and returns those movements; the counter
 * decides whether their count already reflects them.
 */
export function CountForm({ item, onSaved }: { item: StockItem; onSaved: (r: WriteResult) => void }) {
  const [started, setStarted] = useState<{ version: number; balanceMilli: number; at: string } | null>(null);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [estimated, setEstimated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<{ currentVersion: number; balanceMilli: number; since: StockMovement[] } | null>(null);

  const counted = parseTypedQuantity(text, item.baseUnit, { allowZero: true });

  async function submit(version: number) {
    if (counted === null || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    const r = await recordCount({ itemId: item.id, countedQuantity: toQuantityString(counted), expectedVersion: version, reason: reason.trim(), estimated }, newOperationKey());
    setBusy(false);
    if (r.ok) {
      setStarted(null); setText(""); setReason(""); setStale(null);
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

  if (!started) {
    return (
      <div className="space-y-2" data-testid="stock-count-start">
        <p className="text-sm text-text-muted">Recorded now: {balanceLabel(item)}. Last counted {item.lastCountedAt ? `${timeAgo(item.lastCountedAt)}${item.lastCountedByName ? ` by ${item.lastCountedByName}` : ""}` : "never"}.</p>
        <Button type="button" variant="secondary" size="sm" onClick={() => setStarted({ version: item.version, balanceMilli: item.balanceMilli, at: new Date().toISOString() })} disabled={Boolean(item.archivedAt)} data-testid="stock-count-begin">
          Start a count
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="stock-count-form">
      <p className="text-sm text-text-muted">Counting since {new Date(started.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })} — recorded then: {formatQuantity(started.balanceMilli, item.baseUnit)}.</p>
      <label className="block">
        <span className={LABEL}>Counted on the shelf ({UNIT_LABEL[item.baseUnit].plural})</span>
        <input value={text} onChange={(e) => setText(e.target.value)} inputMode={UNIT_LABEL[item.baseUnit].decimals ? "decimal" : "numeric"} className={INPUT} data-testid="stock-count-qty" />
      </label>
      <label className="block">
        <span className={LABEL}>Reason</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. monthly shelf count" className={INPUT} data-testid="stock-count-reason" />
      </label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={estimated} onChange={(e) => setEstimated(e.target.checked)} /> Estimate (e.g. a part-used roll)</label>
      {counted !== null ? <p className="text-sm text-text">Change: {formatNumber(counted - (stale ? stale.balanceMilli : started.balanceMilli))} {UNIT_LABEL[item.baseUnit].plural}</p> : null}
      {stale ? (
        <div className="space-y-2 rounded-card border border-state-warning p-3 text-sm" data-testid="stock-count-stale" role="alert">
          <p className="font-semibold text-text">Stock changed while you were counting</p>
          <ul className="list-disc pl-5 text-text-muted">
            {stale.since.map((m) => <li key={m.id}>{movementSummary(m, item.baseUnit)} · {m.actorName ?? "someone"} · {timeAgo(m.createdAt)} (then {formatQuantity(m.balanceAfterMilli, item.baseUnit)})</li>)}
          </ul>
          <p className="text-text-muted">Recorded now: {formatQuantity(stale.balanceMilli, item.baseUnit)}. If your count was taken after those, it still stands.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => void submit(stale.currentVersion)} disabled={busy || counted === null} data-testid="stock-count-confirm-stale">My count is right — save it</Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => { setStale(null); setStarted({ version: stale.currentVersion, balanceMilli: stale.balanceMilli, at: new Date().toISOString() }); setText(""); }}>Count again</Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={() => void submit(started.version)} disabled={busy || counted === null || reason.trim().length < 3} data-testid="stock-count-save">{busy ? "Saving…" : "Save count"}</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => { setStarted(null); setError(null); }}>Cancel</Button>
        </div>
      )}
      <Err text={error} />
    </div>
  );
}

/** Office catalogue edit (compare-and-set on the item's revision). */
export function EditForm({ item, unitLocked, onSaved }: { item: StockItem; unitLocked: boolean; onSaved: (i: StockItem) => void }) {
  const [f, setF] = useState({
    name: item.name, brand: item.brand ?? "", manufacturerCode: item.manufacturerCode ?? "", supplierSku: item.supplierSku ?? "",
    supplierName: item.supplierName ?? "", variant: item.variant ?? "", colourFinish: item.colourFinish ?? "", location: item.location ?? "",
    baseUnit: item.baseUnit as StockUnit, packUnit: (item.defaultPack?.unit ?? "") as PackUnit | "", packSize: item.defaultPack ? formatNumber(item.defaultPack.sizeMilli) : "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save() {
    setBusy(true); setError(null); setSavedNote(null);
    const patch: Record<string, unknown> & { expectedRevision: number } = { expectedRevision: item.metaRevision };
    const text = (k: "name" | "brand" | "manufacturerCode" | "supplierSku" | "supplierName" | "variant" | "colourFinish" | "location") => {
      const cur = (item[k] ?? "") as string;
      if (f[k].trim() !== cur) patch[k] = f[k].trim() || (k === "name" ? cur : null);
    };
    (["name", "brand", "manufacturerCode", "supplierSku", "supplierName", "variant", "colourFinish", "location"] as const).forEach(text);
    if (f.baseUnit !== item.baseUnit) patch.baseUnit = f.baseUnit;
    const packChanged = (f.packUnit || null) !== (item.defaultPack?.unit ?? null) || (f.packSize || "") !== (item.defaultPack ? formatNumber(item.defaultPack.sizeMilli) : "");
    if (packChanged) patch.defaultPack = f.packUnit && f.packSize ? { unit: f.packUnit, size: f.packSize } : null;
    const r = await editItem(item.id, patch);
    setBusy(false);
    if (r.ok) { setSavedNote(r.data.unchanged ? "Nothing changed." : "Saved."); onSaved(r.data.item); return; }
    setError(errorCopy(r.error.status, r.error.body));
  }

  const text = (k: keyof typeof f, label: string) => (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <input value={f[k] as string} onChange={set(k)} className={INPUT} data-testid={`stock-edit-${k}`} />
    </label>
  );
  return (
    <div className="space-y-2" data-testid="stock-edit-form">
      {text("name", "Name")}
      <div className="grid grid-cols-2 gap-2">{text("brand", "Brand")}{text("manufacturerCode", "Manufacturer code")}</div>
      <div className="grid grid-cols-2 gap-2">{text("supplierSku", "Supplier SKU")}{text("supplierName", "Supplier")}</div>
      <div className="grid grid-cols-2 gap-2">{text("colourFinish", "Colour / finish")}{text("variant", "Size / rating")}</div>
      {text("location", "Location (shelf / bin)")}
      <label className="block">
        <span className={LABEL}>Unit</span>
        <select value={f.baseUnit} onChange={set("baseUnit")} disabled={unitLocked} className={INPUT} data-testid="stock-edit-unit">
          {UNIT_KEYS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u].chip}</option>)}
        </select>
        {unitLocked ? <span className="mt-1 block text-xs text-text-muted">Locked — stock has moved in {UNIT_LABEL[item.baseUnit].plural}. Changing it would reinterpret the history; archive this item and add it again instead.</span> : null}
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className={LABEL}>Default pack</span>
          <select value={f.packUnit} onChange={set("packUnit")} className={INPUT}>
            <option value="">None</option>
            {PACK_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Per pack ({UNIT_LABEL[f.baseUnit].plural})</span>
          <input value={f.packSize} onChange={set("packSize")} disabled={!f.packUnit} inputMode="decimal" className={INPUT} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy} data-testid="stock-edit-save">{busy ? "Saving…" : "Save details"}</Button>
        {savedNote ? <span className="text-sm text-text-muted">{savedNote}</span> : null}
      </div>
      <Err text={error} />
    </div>
  );
}

/** Codes, SKUs and barcodes the item is recognised by, with optional pack conversions. */
export function IdentifiersEditor({ item, onChanged }: { item: StockItem; onChanged: (i: StockItem) => void }) {
  const [kind, setKind] = useState<"manufacturer_code" | "supplier_sku" | "barcode">("barcode");
  const [value, setValue] = useState("");
  const [supplier, setSupplier] = useState("");
  const [packUnit, setPackUnit] = useState<PackUnit | "">("");
  const [packSize, setPackSize] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const LABELS = { manufacturer_code: "Manufacturer code", supplier_sku: "Supplier SKU", barcode: "Barcode" };

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
      <ul className="space-y-1">
        {item.identifiers.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2 rounded-[4px] border border-border px-2 py-1 text-sm">
            <span><span className="text-text-muted">{LABELS[i.kind]}</span> <span className="font-mono">{i.value}</span>{i.scope ? <span className="text-text-muted"> · {i.scope}</span> : null}{i.packUnit && i.packSizeMilli ? <span className="text-text-muted"> · 1 {i.packUnit} = {formatQuantity(i.packSizeMilli, item.baseUnit)}</span> : null}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => void remove(i.id)} disabled={busy}>Remove</Button>
          </li>
        ))}
        {!item.identifiers.length ? <li className="text-sm text-text-muted">No codes yet — photo matching falls back to the description.</li> : null}
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

/** Office: run (or refresh) the online check and record it on the item. */
export function CheckSection({ item, lookupEnabled, onChanged }: { item: StockItem; lookupEnabled: boolean; onChanged: (i: StockItem) => void }) {
  const [state, setState] = useState<"idle" | "checking" | "done">("idle");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = item.verification;

  async function check() {
    if (!item.manufacturerCode) return;
    setState("checking"); setError(null);
    const r = await lookupCode({ brand: item.brand, manufacturerCode: item.manufacturerCode, colourFinish: item.colourFinish, variantDetails: item.variant ? item.variant.split(/\s+/) : [], refresh: true });
    setState("done");
    if (r.ok) setResult(r.data); else setError(errorCopy(r.error.status, r.error.body, "Couldn't check online right now."));
  }
  async function record() {
    const r = await recordVerification(item.id);
    if (r.ok) { onChanged(r.data.item); setResult(null); setState("idle"); } else setError(errorCopy(r.error.status, r.error.body));
  }

  return (
    <div className="space-y-2" data-testid="stock-check">
      <p className="text-sm text-text"><span className="font-semibold">{VERIFICATION_LABEL[item.verificationStatus]}</span>{v?.checkedAt ? ` · checked ${timeAgo(v.checkedAt)}` : ""}</p>
      {v?.sourceUrl ? <a href={v.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-sm text-brand-navy underline">{v.sourceDomain || v.sourceUrl}</a> : null}
      {v?.reasons?.length ? <p className="text-xs text-text-muted">{v.reasons.join(" · ")}</p> : null}
      {lookupEnabled && item.manufacturerCode ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => void check()} disabled={state === "checking"} data-testid="stock-check-run">Check code online</Button>
      ) : <p className="text-xs text-text-muted">{item.manufacturerCode ? "The online check isn't set up." : "Add a manufacturer code to check it online."}</p>}
      <LookupCard state={state} result={result} accepted={null} onAccept={() => void record()} onReject={() => { setResult(null); setState("idle"); }} />
      <Err text={error} />
    </div>
  );
}
