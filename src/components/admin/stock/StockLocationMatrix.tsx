"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Loader2, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { editItem, fetchLocationMatrix, fetchStockList, newOperationKey, saveLocationMatrix } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy } from "@/domains/workshop-stock/format";
import { placementIssues, shelfMap, suggestBin, type BinSuggestion } from "@/domains/workshop-stock/location-map";
import type { StockItem } from "@/domains/workshop-stock/schema";
import { guessType } from "@/domains/workshop-stock/types";
import { binKey, binsOn, locationText, MAX_BINS, MAX_SHELVES, rackBinCount, rackLabel, rackShape, ruleFor, rulesInBin, rulesOutsideRack, shelfLabel, shelvesDiffer, type LocationMatrix, type MatrixRack } from "@/domains/workshop-stock/location-matrix";
import { Block } from "./StockAdminForms";
import { StockLayoutPlan } from "./StockLayoutPlan";
import { BinLabelBar, BinLabelPreview, drawBinLabels, RackLabelPrint, useBinLabelPick } from "./BinLabels";
import type { BinLabelSpec } from "@/domains/workshop-stock/bin-label";
import { useLabelPrinter } from "@/components/stock/useLabelPrinter";
import { useLabelSize } from "@/components/stock/useLabelSize";

const INPUT = "h-9 rounded-[4px] border border-border-strong bg-surface-subtle px-2.5 text-sm text-text focus:border-accent-yellow focus:outline-none";

function NumberField({ label, value, onChange, max, testId }: { label: string; value: string; onChange: (v: string) => void; max: number; testId?: string }) {
  return (
    <label className="console-label block">
      {label}
      <input type="number" min={1} max={max} value={value} onChange={(e) => onChange(e.target.value)} className={cn(INPUT, "mt-1 block w-20 font-sans")} data-testid={testId} />
    </label>
  );
}

/** What the rack form holds: shelfBins is set once "Shelves differ" is ticked, one count per shelf. */
interface RackFields {
  name: string;
  shelves: string;
  bins: string;
  shelfBins: string[] | null;
}

const NEW_RACK: RackFields = { name: "", shelves: "4", bins: "6", shelfBins: null };

function rackFromFields(f: RackFields): Pick<MatrixRack, "name" | "shelves" | "bins" | "shelfBins"> | null {
  if (!f.name.trim()) return null;
  const shelves = Number(f.shelves);
  const shape = rackShape(shelves, Number(f.bins), f.shelfBins ? Array.from({ length: Math.max(0, shelves) }, (_, i) => Number(f.shelfBins![i] ?? f.bins)) : null);
  return shape ? { name: f.name.trim(), ...shape } : null;
}

function rackSize(rack: MatrixRack): string {
  const shelves = `${rack.shelves} ${rack.shelves === 1 ? "shelf" : "shelves"}`;
  if (!shelvesDiffer(rack)) return `${shelves} × ${rack.bins} ${rack.bins === 1 ? "bin" : "bins"}`;
  return `${shelves}, ${rackBinCount(rack)} bins (${Array.from({ length: rack.shelves }, (_, i) => `${shelfLabel(i + 1)} ${binsOn(rack, i + 1)}`).join(", ")})`;
}

/** Shelves, bins, and — when the shelves aren't all the same — how many bins on each one. */
function RackSizeFields({ fields, onChange, testId }: { fields: RackFields; onChange: (f: RackFields) => void; testId?: string }) {
  const shelves = Math.min(MAX_SHELVES, Math.max(0, Math.floor(Number(fields.shelves)) || 0));
  return (
    <>
      <NumberField label="Shelves" value={fields.shelves} onChange={(v) => onChange({ ...fields, shelves: v })} max={MAX_SHELVES} testId={testId ? `${testId}-shelves` : undefined} />
      {fields.shelfBins ? null : <NumberField label="Bins per shelf" value={fields.bins} onChange={(v) => onChange({ ...fields, bins: v })} max={MAX_BINS} testId={testId ? `${testId}-bins` : undefined} />}
      <label className="console-label flex h-9 items-center gap-1.5">
        <input
          type="checkbox"
          checked={!!fields.shelfBins}
          onChange={(e) => onChange({ ...fields, shelfBins: e.target.checked ? Array.from({ length: shelves }, () => fields.bins) : null })}
          data-testid={testId ? `${testId}-differ` : undefined}
        />
        Shelves differ
      </label>
      {fields.shelfBins ? (
        <div className="flex basis-full flex-wrap items-end gap-2" role="group" aria-label="Bins on each shelf">
          {Array.from({ length: shelves }, (_, i) => (
            <label key={i} className="console-label block">
              Shelf {shelfLabel(i + 1)}
              <input
                type="number"
                min={1}
                max={MAX_BINS}
                value={fields.shelfBins![i] ?? fields.bins}
                onChange={(e) => {
                  const next = Array.from({ length: shelves }, (_, j) => fields.shelfBins![j] ?? fields.bins);
                  next[i] = e.target.value;
                  onChange({ ...fields, shelfBins: next });
                }}
                aria-label={`Bins on shelf ${shelfLabel(i + 1)}`}
                className={cn(INPUT, "mt-1 block w-16 font-sans")}
                data-testid={testId ? `${testId}-shelf-bins` : undefined}
              />
            </label>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * /stock/locations — where stock goes, and where it is. The office lays out each
 * rack as a grid of shelves and bins and writes in each bin the words for what
 * lives there ("iconic switch"); the grid also shows what the recorded stock says
 * is in each bin. Stock with no bin is listed with a suggested place, and moves
 * only when someone taps. A recommended layout writes rules the same way. Each matrix
 * change saves the whole matrix (compare-and-set). Bin labels (the code, and the
 * contents) print from here straight to the NIIMBOT — one bin from its editor, a
 * whole rack from its header.
 */
export function StockLocationMatrix() {
  const [matrix, setMatrix] = useState<LocationMatrix | null>(null);
  const [revision, setRevision] = useState(0);
  const [available, setAvailable] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<{ rackId: string; shelf: number; bin: number } | null>(null);
  const [words, setWords] = useState("");
  const [newRack, setNewRack] = useState<RackFields>(NEW_RACK);
  const [editing, setEditing] = useState<(RackFields & { id: string }) | null>(null);
  const [tryText, setTryText] = useState("");
  const [removing, setRemoving] = useState<MatrixRack | null>(null);
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [itemsError, setItemsError] = useState(false);
  const [moving, setMoving] = useState<{ item: StockItem; suggestion: BinSuggestion | null } | null>(null);
  const [movingBusy, setMovingBusy] = useState(false);
  const lp = useLabelPrinter(true);
  const [labelSize, setLabelSize] = useLabelSize();
  const [labelPick, toggleLabelPick] = useBinLabelPick();
  /** which button started the last print — its result is said next to it */
  const [printedFrom, setPrintedFrom] = useState<string | null>(null);

  /** Print these bin labels; `from` names the button, so the result is said next to it. */
  const printFrom = (from: string) => (specs: BinLabelSpec[], done: string, link?: "bluetooth" | "usb") => {
    setPrintedFrom(from);
    void lp.print({ size: labelSize, link, done, draw: (fitted) => drawBinLabels(fitted, specs) });
  };

  const load = useCallback(async () => {
    const [r, stock] = await Promise.all([fetchLocationMatrix(), fetchStockList()]);
    if (!r.ok) {
      setLoadError(errorCopy(r.error.status, r.error.body, "The server didn't answer, so the matrix isn't shown."));
      return;
    }
    setLoadError(null);
    setAvailable(r.data.available);
    setMatrix(r.data.matrix);
    setRevision(r.data.revision);
    setItemsError(!stock.ok);
    setItems(stock.ok ? stock.data.items : null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(next: LocationMatrix): Promise<boolean> {
    setSaving(true);
    setSaveError(null);
    const r = await saveLocationMatrix({ ...next, expectedRevision: revision });
    setSaving(false);
    if (!r.ok) {
      setSaveError(errorCopy(r.error.status, r.error.body, "That didn't save. Try again."));
      return false;
    }
    setMatrix(r.data.matrix);
    setRevision(r.data.revision);
    return true;
  }

  async function addRack() {
    if (!matrix) return;
    const fields = rackFromFields(newRack);
    if (!fields) {
      setSaveError(`Give the rack a name, up to ${MAX_SHELVES} shelves and 1 to ${MAX_BINS} bins on each shelf.`);
      return;
    }
    if (await save({ ...matrix, racks: [...matrix.racks, { id: newOperationKey(), ...fields }] })) setNewRack(NEW_RACK);
  }

  async function saveRackEdit() {
    if (!matrix || !editing) return;
    const fields = rackFromFields(editing);
    if (!fields) {
      setSaveError(`Give the rack a name, up to ${MAX_SHELVES} shelves and 1 to ${MAX_BINS} bins on each shelf.`);
      return;
    }
    const stranded = rulesOutsideRack(matrix, editing.id, fields.shelves, fields.bins, fields.shelfBins);
    if (stranded.length) {
      setSaveError(`Smaller than that leaves "${stranded[0]!.words}" with no bin. Clear it first.`);
      return;
    }
    // Spelled out so going back to one count for every shelf drops the old per-shelf counts.
    if (await save({ ...matrix, racks: matrix.racks.map((r) => (r.id === editing.id ? { id: r.id, ...fields } : r)) })) setEditing(null);
  }

  async function removeRack(rack: MatrixRack) {
    if (!matrix) return;
    if (await save({ racks: matrix.racks.filter((r) => r.id !== rack.id), rules: matrix.rules.filter((r) => r.rackId !== rack.id) })) {
      setRemoving(null);
      setOpen(null);
      setEditing(null);
    }
  }

  function askRemoveRack(rack: MatrixRack) {
    if (matrix?.rules.some((r) => r.rackId === rack.id)) setRemoving(rack);
    else void removeRack(rack);
  }

  async function addRule() {
    if (!matrix || !open || !words.trim()) return;
    if (await save({ ...matrix, rules: [...matrix.rules, { id: newOperationKey(), words: words.trim(), ...open }] })) setWords("");
  }

  async function removeRule(id: string) {
    if (!matrix) return;
    await save({ ...matrix, rules: matrix.rules.filter((r) => r.id !== id) });
  }

  /** Moves recorded stock, which only ever happens from a tap here. */
  async function moveTo(item: StockItem, location: string) {
    setMovingBusy(true);
    setSaveError(null);
    const r = await editItem(item.id, { expectedRevision: item.metaRevision, location });
    setMovingBusy(false);
    if (!r.ok) {
      setSaveError(errorCopy(r.error.status, r.error.body, `${item.name} didn't move. Try again.`));
      void load();
      return;
    }
    setItems((prev) => prev?.map((i) => (i.id === item.id ? r.data.item : i)) ?? prev);
    setMoving(null);
  }

  const tried = useMemo(() => (tryText.trim() && matrix ? ruleFor(tryText, matrix) : null), [tryText, matrix]);
  const triedSuggestion = useMemo(() => (tryText.trim() && matrix && !tried ? suggestBin({ text: tryText, category: guessType([tryText]) }, matrix, items ?? []) : null), [tryText, matrix, tried, items]);
  const map = useMemo(() => shelfMap(items ?? [], matrix), [items, matrix]);
  const issues = useMemo(() => placementIssues(items ?? [], matrix), [items, matrix]);

  if (loadError) {
    return (
      <Block tone="warn" title="Couldn't load the matrix" role="alert" className="bg-state-warning-subtle-bg">
        <p>{loadError}</p>
        <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => void load()}>Try again</Button>
      </Block>
    );
  }
  if (!matrix) return <p className="flex items-center gap-2 text-sm text-text-muted" role="status"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> Loading the matrix…</p>;
  if (!available) {
    return (
      <Block tone="warn" title="Needs a database update" role="status" testId="stock-matrix-unavailable">
        <p>The location matrix needs migration 20261102100000_workshop_stock_location_matrix.sql applied before it can be used. Nothing else on Workshop stock is affected.</p>
      </Block>
    );
  }

  return (
    <div data-theme="console" className="space-y-2 rounded-[6px] bg-surface-subtle p-2 text-text" data-testid="stock-matrix">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[4px] border border-border bg-surface px-3 py-2">
        <span className="font-mono text-[13px] font-bold uppercase tracking-[0.1em] text-text">Location matrix</span>
        <span className="console-label">{matrix.racks.length} {matrix.racks.length === 1 ? "rack" : "racks"}</span>
        <span className="console-label">{matrix.racks.reduce((n, r) => n + rackBinCount(r), 0)} bins</span>
        <span className="console-label" data-testid="stock-matrix-used">{map.bins.size} in use</span>
        <span className="console-label">{matrix.rules.length} {matrix.rules.length === 1 ? "rule" : "rules"}</span>
        {items ? <span className="console-label" data-testid="stock-matrix-issue-count">{issues.length} {issues.length === 1 ? "needs" : "need"} a place</span> : null}
        <span className="flex-1" />
        {saving ? <span className="console-label flex items-center gap-1.5" role="status"><Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Saving</span> : null}
      </header>

      <div className="grid gap-2 lg:grid-cols-2">
        <section className="rounded-[4px] border border-border bg-surface p-3">
          <h2 className="console-label">Add a rack</h2>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="console-label block">
              Name
              <input value={newRack.name} onChange={(e) => setNewRack({ ...newRack, name: e.target.value })} maxLength={30} placeholder="1" className={cn(INPUT, "mt-1 block w-32 font-sans normal-case tracking-normal")} data-testid="stock-matrix-rack-name" />
            </label>
            <RackSizeFields fields={newRack} onChange={setNewRack} testId="stock-matrix-rack" />
            <Button type="button" size="sm" disabled={saving} onClick={() => void addRack()} data-testid="stock-matrix-rack-add"><Plus aria-hidden="true" className="h-4 w-4" /> Add rack</Button>
          </div>
        </section>
        <section className="rounded-[4px] border border-border bg-surface p-3">
          <h2 className="console-label">Test a label</h2>
          <input value={tryText} onChange={(e) => setTryText(e.target.value)} placeholder="Clipsal Iconic 1 gang switch" aria-label="Test a label against the matrix" className={cn(INPUT, "mt-2 w-full")} data-testid="stock-matrix-try" />
          <p className={cn("mt-1.5 min-h-[1.5rem] text-sm", tried ? "text-text" : "text-text-muted")} role="status" data-testid="stock-matrix-try-result">
            {!tryText.trim() ? "Type what's printed on a label to see where it would go." : tried ? <>Goes to <strong className="font-mono font-bold uppercase text-accent-yellow">{tried.location}</strong>, from &ldquo;{tried.rule.words}&rdquo;.</> : triedSuggestion ? <>No rule fits. Suggested: <strong className="font-mono font-bold uppercase text-accent-yellow">{triedSuggestion.location}</strong>. {triedSuggestion.why}.</> : "No rule fits and no bin is free."}
          </p>
        </section>
      </div>

      {matrix.racks.length ? <BinLabelBar lp={lp} size={labelSize} setSize={setLabelSize} pick={labelPick} togglePick={toggleLabelPick} /> : null}

      {saveError ? <Block tone="warn" title="Not saved" role="alert"><p>{saveError}</p></Block> : null}
      {itemsError ? <Block tone="warn" title="Stock didn't load" role="alert"><p>The grid is showing rules only, not what&rsquo;s in each bin.</p><Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => void load()}>Try again</Button></Block> : null}

      {moving ? (
        <div className="console-rise sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-[4px] border border-accent-yellow bg-surface-raised px-3 py-2" role="status" data-testid="stock-matrix-moving">
          <span className="min-w-0 flex-1 text-sm text-text">Moving <strong className="font-semibold">{moving.item.name}</strong>. Click the bin it&rsquo;s going to.{moving.suggestion ? ` The outlined one is suggested.` : ""}</span>
          {movingBusy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-text-muted" /> : null}
          <Button type="button" variant="ghost" size="sm" onClick={() => setMoving(null)} data-testid="stock-matrix-moving-cancel">Cancel</Button>
        </div>
      ) : null}

      {matrix.racks.length ? <StockLayoutPlan matrix={matrix} items={items} saving={saving} onSaveRules={(rules) => save({ ...matrix, rules })} /> : null}

      {matrix.racks.length && issues.length ? (
        <section className="rounded-[4px] border border-border bg-surface p-3" data-testid="stock-matrix-issues">
          <h2 className="console-label">Needs a place</h2>
          <ul className="mt-2 max-h-72 divide-y divide-border overflow-y-auto">
            {issues.map(({ item, problem, suggestion }) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-testid="stock-matrix-issue">
                <div className="min-w-[14rem] flex-1">
                  <p className="text-sm font-medium text-text">{item.name} <span className="font-normal text-text-muted">· {balanceLabel(item)}</span></p>
                  <p className="text-xs text-text-muted">{problem}</p>
                </div>
                {suggestion ? (
                  <div className="min-w-[14rem] flex-1">
                    <p className="font-mono text-xs font-bold uppercase text-accent-yellow">{suggestion.location}</p>
                    <p className="text-xs text-text-muted">{suggestion.why}</p>
                  </div>
                ) : null}
                <div className="flex gap-1.5">
                  {suggestion ? <Button type="button" size="sm" disabled={movingBusy} onClick={() => void moveTo(item, suggestion.location)} data-testid="stock-matrix-issue-put">Put it here</Button> : null}
                  <Button type="button" variant="ghost" size="sm" disabled={movingBusy} onClick={() => setMoving({ item, suggestion })} data-testid="stock-matrix-issue-choose">Choose a bin</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!matrix.racks.length ? (
        <p className="rounded-[4px] border border-dashed border-border-strong p-8 text-center text-sm text-text-muted">No racks yet. Add one above, then click a bin to say what goes in it.</p>
      ) : null}

      {matrix.racks.map((rack) => (
        <section key={rack.id} className="rounded-[4px] border border-border bg-surface p-3" aria-label={rackLabel(rack.name)} data-testid="stock-matrix-rack">
          {editing?.id === rack.id ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="console-label block">
                Name
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={30} className={cn(INPUT, "mt-1 block w-32 font-sans normal-case tracking-normal")} />
              </label>
              <RackSizeFields fields={editing} onChange={(f) => setEditing({ ...f, id: editing.id })} />
              <Button type="button" size="sm" disabled={saving} onClick={() => void saveRackEdit()}>Save</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-semibold text-text">{rackLabel(rack.name)}</h2>
              <span className="console-label" data-testid="stock-matrix-rack-size">{rackSize(rack)}</span>
              <span className="flex-1" />
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing({ id: rack.id, name: rack.name, shelves: String(rack.shelves), bins: String(rack.bins), shelfBins: shelvesDiffer(rack) ? Array.from({ length: rack.shelves }, (_, i) => String(binsOn(rack, i + 1))) : null })}>Change</Button>
              <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => askRemoveRack(rack)} aria-label={`Remove ${rackLabel(rack.name)}`}><Trash2 aria-hidden="true" className="h-4 w-4" /></Button>
            </div>
          )}
          {removing?.id === rack.id ? (
            <Block tone="warn" title={`Remove ${rackLabel(rack.name)} and its rules?`} role="alert" className="mt-3">
              <p>{matrix.rules.filter((r) => r.rackId === rack.id).length} bin rules go with it. Items already on this rack keep their location.</p>
              <div className="flex gap-2 pt-1">
                <Button type="button" variant="danger" size="sm" disabled={saving} onClick={() => void removeRack(rack)}>Remove rack</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setRemoving(null)}>Keep it</Button>
              </div>
            </Block>
          ) : null}
          <RackLabelPrint lp={lp} pick={labelPick} matrix={matrix} rack={rack} mine={printedFrom === `rack:${rack.id}`} onPrint={printFrom(`rack:${rack.id}`)} />
          <div className="mt-3 overflow-x-auto">
            <table className="border-separate border-spacing-1 text-left">
              <thead>
                <tr>
                  <th scope="col" className="sr-only">Shelf</th>
                  {Array.from({ length: rack.bins }, (_, b) => (
                    <th key={b} scope="col" className="console-label px-1 pb-0.5 text-center">Bin {b + 1}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rack.shelves }, (_, s) => (
                  <tr key={s}>
                    <th scope="row" className="console-label whitespace-nowrap pr-2">Shelf {shelfLabel(s + 1)}</th>
                    {Array.from({ length: rack.bins }, (_, b) => {
                      const shelf = s + 1;
                      const bin = b + 1;
                      if (bin > binsOn(rack, shelf)) return <td key={b} className="p-0" aria-hidden="true" />;
                      const here = rulesInBin(matrix, rack.id, shelf, bin);
                      const stock = map.bins.get(binKey(rack.id, shelf, bin)) ?? [];
                      const isOpen = open?.rackId === rack.id && open.shelf === shelf && open.bin === bin;
                      const suggested = moving?.suggestion?.rackId === rack.id && moving.suggestion.shelf === shelf && moving.suggestion.bin === bin;
                      return (
                        <td key={b} className="p-0 align-top">
                          <button
                            type="button"
                            disabled={movingBusy}
                            onClick={() => {
                              if (moving) { void moveTo(moving.item, locationText(rack, shelf, bin)); return; }
                              setOpen(isOpen ? null : { rackId: rack.id, shelf, bin });
                              setWords("");
                            }}
                            aria-pressed={isOpen}
                            aria-label={`${locationText(rack, shelf, bin)}: ${here.length ? here.map((r) => r.words).join(", ") : "nothing set"}; ${stock.length ? `holds ${stock.map((i) => i.name).join(", ")}` : "no stock"}${suggested ? "; suggested" : ""}`}
                            className={cn(
                              "block h-16 w-32 overflow-hidden rounded-[4px] border p-1.5 text-left text-xs leading-tight transition-colors duration-100",
                              suggested ? "border-accent-yellow bg-surface-raised text-text ring-2 ring-accent-yellow" : isOpen ? "border-accent-yellow bg-surface-raised text-text ring-1 ring-accent-yellow" : stock.length ? "border-border-strong bg-surface-raised font-medium text-text hover:border-accent-yellow" : here.length ? "border-dashed border-border-strong bg-surface text-text-muted hover:border-accent-yellow" : "border-border bg-surface-subtle text-text-muted hover:border-border-strong",
                            )}
                            data-testid="stock-matrix-bin"
                            data-stock={stock.length}
                          >
                            {stock.length ? <span className="block truncate">{stock[0]!.name}</span> : null}
                            {stock.length > 1 ? <span className="block font-mono text-text-muted">+{stock.length - 1} more</span> : null}
                            {here.length ? <span className="block truncate font-mono font-normal text-text-muted">{here.map((r) => r.words).join(", ")}</span> : null}
                            {!stock.length && !here.length ? <span aria-hidden="true" className="font-mono">·</span> : null}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open?.rackId === rack.id ? (
            <div className="console-rise mt-3 rounded-[4px] border border-accent-yellow bg-surface-subtle p-3" data-testid="stock-matrix-bin-editor">
              <p className="font-display text-sm font-semibold text-text"><span className="font-mono uppercase text-accent-yellow">{locationText(rack, open.shelf, open.bin)}</span></p>
              {(map.bins.get(binKey(rack.id, open.shelf, open.bin)) ?? []).length ? (
                <ul className="mt-2 divide-y divide-border" data-testid="stock-matrix-bin-stock">
                  {(map.bins.get(binKey(rack.id, open.shelf, open.bin)) ?? []).map((item) => (
                    <li key={item.id} className="flex items-center gap-2 py-1.5 text-sm text-text">
                      <span className="min-w-0 flex-1 truncate">{item.name} <span className="text-text-muted">· {balanceLabel(item)}</span></span>
                      <Button type="button" variant="ghost" size="sm" disabled={movingBusy} onClick={() => { setMoving({ item, suggestion: null }); setOpen(null); }} data-testid="stock-matrix-bin-move"><ArrowRightLeft aria-hidden="true" className="h-3.5 w-3.5" /> Move</Button>
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-1 text-sm text-text-muted">No stock recorded here.</p>}
              <p className="mt-3 console-label">What goes here</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {rulesInBin(matrix, rack.id, open.shelf, open.bin).map((r) => (
                  <li key={r.id} className="inline-flex items-center gap-1 rounded-[4px] border border-border-strong bg-surface-raised py-0.5 pl-2 pr-0.5 text-sm text-text">
                    {r.words}
                    <button type="button" disabled={saving} onClick={() => void removeRule(r.id)} aria-label={`Remove ${r.words}`} className="inline-flex h-6 w-6 items-center justify-center text-text-muted hover:text-text"><X aria-hidden="true" className="h-3.5 w-3.5" /></button>
                  </li>
                ))}
              </ul>
              <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void addRule(); }}>
                <input value={words} onChange={(e) => setWords(e.target.value)} maxLength={80} autoFocus placeholder="iconic switch" aria-label="Words for what goes in this bin" className={cn(INPUT, "w-64")} data-testid="stock-matrix-words" />
                <Button type="submit" size="sm" disabled={saving || !words.trim()} data-testid="stock-matrix-words-add">Add</Button>
              </form>
              <p className="mt-2 text-xs text-text-muted">Anything with all these words on its label or name goes here. If two bins fit, the one with more words wins, so &ldquo;iconic switch&rdquo; beats &ldquo;iconic&rdquo;.</p>
              <BinLabelPreview lp={lp} size={labelSize} pick={labelPick} togglePick={toggleLabelPick} matrix={matrix} rack={rack} shelf={open.shelf} bin={open.bin} mine={printedFrom === `bin:${rack.id}:${open.shelf}:${open.bin}`} onPrint={printFrom(`bin:${rack.id}:${open.shelf}:${open.bin}`)} />
            </div>
          ) : null}
        </section>
      ))}

    </div>
  );
}
