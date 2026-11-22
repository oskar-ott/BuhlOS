"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Seg } from "@/components/ui/Seg";
import { errorCodeOf, saveInvoicePrefs } from "@/domains/customer-invoices/client";
import {
  bpToInput,
  errorMessage,
  formatBp,
  formatCents,
  formatDay,
  parseDollarsToCents,
} from "@/domains/customer-invoices/format";
import {
  buildLabourLines,
  buildMaterialLines,
  dayRange,
  formatHours,
  materialsOf,
  newKey,
  parseMarkupToBp,
  parseQuantityToMilli,
  parseUnitPriceToCents,
  unitPriceToInput,
  withMarkup,
  type ItemDraft,
} from "@/domains/customer-invoices/itemised";
import type { BillableDay, BillableResponse, InvoicePrefs, UsualCharge } from "@/domains/customer-invoices/schema";

export type AddFromJobTab = "hours" | "materials" | "usual";

const INPUT =
  "h-9 rounded-card border border-border bg-surface px-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy";
const CHECK = "h-4 w-4 shrink-0 rounded border-border text-brand-navy focus:ring-brand-navy";
const LINK =
  "font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2";

/**
 * "Add from this job" (#1162): the job's own approved hours, its materials,
 * and the business's usual charges, turned into invoice lines at prices the
 * office sets. Only what is NOT already on an invoice is offered — anything
 * that is says which invoice holds it. Nothing here saves an invoice: it adds
 * rows to the editor, which the person can still change.
 */
export function AddFromJob({
  tab,
  onTab,
  state,
  billable,
  usedKeys,
  room,
  onAdd,
  onPrefs,
  onClose,
  onRetry,
}: {
  tab: AddFromJobTab;
  onTab: (t: AddFromJobTab) => void;
  state: "idle" | "loading" | "error";
  billable: BillableResponse | null;
  /** What the draft's own rows already bill. */
  usedKeys: ReadonlySet<string>;
  /** How many more lines the invoice can take. */
  room: number;
  onAdd: (lines: ItemDraft[]) => void;
  onPrefs: (prefs: InvoicePrefs) => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <section
      className="rounded-card border border-border-strong bg-surface p-3"
      aria-label="Add from this job"
      data-testid="add-from-job"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Seg
          aria-label="What to add"
          value={tab}
          onChange={onTab}
          options={[
            { value: "hours", label: "Hours" },
            { value: "materials", label: "Materials" },
            { value: "usual", label: "Usual charges" },
          ]}
        />
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="mt-3">
        {state === "loading" || (!billable && state !== "error") ? (
          <p className="text-sm text-text-muted" data-testid="add-loading">
            Reading this job&rsquo;s hours and materials…
          </p>
        ) : state === "error" || !billable ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-text-muted" role="alert">
              Couldn&rsquo;t read this job&rsquo;s hours and materials just now. You can still type the lines.
            </p>
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : tab === "hours" ? (
          <HoursPanel billable={billable} usedKeys={usedKeys} room={room} onAdd={onAdd} />
        ) : tab === "materials" ? (
          <MaterialsPanel billable={billable} usedKeys={usedKeys} room={room} onAdd={onAdd} />
        ) : (
          <UsualPanel prefs={billable.prefs} room={room} onAdd={onAdd} onPrefs={onPrefs} />
        )}
      </div>
    </section>
  );
}

// ── hours ───────────────────────────────────────────────────────────────────

function HoursPanel({
  billable,
  usedKeys,
  room,
  onAdd,
}: {
  billable: BillableResponse;
  usedKeys: ReadonlySet<string>;
  room: number;
  onAdd: (lines: ItemDraft[]) => void;
}) {
  const labour = billable.labour;
  const labourRates = billable.prefs.usualCharges.filter((c) => c.kind === "labour");
  const [upTo, setUpTo] = useState("");
  const [groupBy, setGroupBy] = useState<"worker" | "rate">("worker");
  const [roundMinutes, setRoundMinutes] = useState(billable.prefs.labourRoundMinutes);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [rates, setRates] = useState<Record<string, string>>({});

  // Unbilled days, not already in this draft, up to the chosen date — by worker.
  const workers = useMemo(() => {
    const map = new Map<string, { userId: string; name: string; days: BillableDay[]; rate: number | null }>();
    for (const d of labour.days) {
      if (d.unbilledMilli <= 0 || usedKeys.has(`h:${d.userId}|${d.date}`)) continue;
      if (upTo && d.date > upTo) continue;
      const w = map.get(d.userId) ?? { userId: d.userId, name: d.name, days: [], rate: d.chargeOutRateCents };
      w.days.push(d);
      // the most recent day's rate is the one offered
      if (d.chargeOutRateCents != null) w.rate = d.chargeOutRateCents;
      map.set(d.userId, w);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [labour.days, usedKeys, upTo]);

  const billedElsewhere = labour.days.filter((d) => d.billedMilli > 0).length;
  const rateText = (w: { userId: string; rate: number | null }) =>
    rates[w.userId] ?? (w.rate == null ? "" : unitPriceToInput(w.rate));

  if (!labour.available) {
    return (
      <p className="text-sm text-text-muted" role="alert">
        The time sheets couldn&rsquo;t be read just now, so hours can&rsquo;t be pulled in. Type the labour line
        instead, or try again shortly.
      </p>
    );
  }

  const chosen = workers.filter((w) => !off.has(w.userId));
  const chosenDays = chosen.flatMap((w) => w.days);
  const totalMilli = chosenDays.reduce((s, d) => s + d.unbilledMilli, 0);
  const lines = buildLabourLines(chosenDays, {
    groupBy,
    roundMinutes,
    rates: Object.fromEntries(
      chosen.map((w) => {
        const typed = rateText(w).trim();
        const cents = typed ? parseUnitPriceToCents(typed) : null;
        return [w.userId, cents != null && cents > 0 ? cents : null];
      })
    ),
  });
  const roundedMilli = lines.reduce((s, l) => s + (parseQuantityToMilli(l.quantity) ?? 0), 0);
  const badRate = chosen.find((w) => {
    const typed = rateText(w).trim();
    const cents = typed ? parseUnitPriceToCents(typed) : 0;
    return cents == null || cents < 0;
  });

  return (
    <div className="grid gap-3" data-testid="add-hours">
      {workers.length === 0 ? (
        <p className="text-sm text-text-muted" data-testid="add-hours-empty">
          No approved hours on this job are waiting to be invoiced
          {upTo ? ` up to ${formatDay(upTo)}` : ""}.
          {billedElsewhere > 0 ? " The hours logged are already on an invoice." : ""}
        </p>
      ) : (
        <>
          <ul className="grid gap-2">
            {workers.map((w) => {
              const milli = w.days.reduce((s, d) => s + d.unbilledMilli, 0);
              const on = !off.has(w.userId);
              return (
                <li key={w.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid={`add-hours-${w.userId}`}>
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-text">
                    <input
                      type="checkbox"
                      className={CHECK}
                      checked={on}
                      onChange={() =>
                        setOff((prev) => {
                          const next = new Set(prev);
                          if (next.has(w.userId)) next.delete(w.userId);
                          else next.add(w.userId);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0">
                      <span className="font-medium">{w.name}</span>{" "}
                      <span className="text-text-muted">
                        · {formatHours(milli)} · {w.days.length} {w.days.length === 1 ? "day" : "days"},{" "}
                        {dayRange(w.days.map((d) => d.date))}
                      </span>
                    </span>
                  </label>
                  <span className="flex items-center gap-1.5 text-xs text-text-muted">
                    <span aria-hidden="true">$</span>
                    <input
                      aria-label={`Hourly price for ${w.name}`}
                      className={`${INPUT} w-24`}
                      inputMode="decimal"
                      value={rateText(w)}
                      onChange={(e) => setRates((prev) => ({ ...prev, [w.userId]: e.target.value }))}
                      placeholder="per hour"
                      disabled={!on}
                    />
                    <span>/hr</span>
                  </span>
                </li>
              );
            })}
          </ul>

          {workers.some((w) => !rateText(w).trim()) ? (
            <p className="text-xs text-text-muted" data-testid="add-hours-no-rate">
              A worker with no charge-out rate has no price here. Type one, or leave it blank and fill the
              price in on the line.
            </p>
          ) : null}

          {labourRates.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
              <span>Price everyone at:</span>
              {labourRates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={LINK}
                  onClick={() =>
                    setRates(Object.fromEntries(workers.map((w) => [w.userId, unitPriceToInput(c.unitCents)])))
                  }
                >
                  {c.name} ({formatCents(c.unitCents)})
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}

      <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
        <label className="grid gap-1 text-xs text-text-muted">
          Only hours up to
          <input type="date" className={`${INPUT} w-40`} value={upTo} onChange={(e) => setUpTo(e.target.value)} />
        </label>
        <label className="grid gap-1 text-xs text-text-muted">
          Round each line up to
          <select
            className={`${INPUT} w-40`}
            value={String(roundMinutes)}
            onChange={(e) => setRoundMinutes(Number(e.target.value))}
          >
            <option value="0">as logged</option>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">the hour</option>
          </select>
        </label>
        <div className="grid gap-1 text-xs text-text-muted">
          <span>Show as</span>
          <Seg
            aria-label="How the hours are shown"
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { value: "worker", label: "A line per worker" },
              { value: "rate", label: "A line per rate" },
            ]}
          />
        </div>
      </div>

      {labour.pendingMilli > 0 ? (
        <p className="text-xs text-text-muted" data-testid="add-hours-pending">
          Another {formatHours(labour.pendingMilli)} on this job is logged but not approved yet, so it
          can&rsquo;t be invoiced until it is.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted" data-testid="add-hours-total">
          {chosen.length === 0
            ? "Nothing chosen."
            : `${formatHours(totalMilli)} logged${
                roundedMilli !== totalMilli ? `, ${formatHours(roundedMilli)} after rounding up` : ""
              }, as ${lines.length} ${lines.length === 1 ? "line" : "lines"}.`}
          {lines.length > room ? ` The invoice only has room for ${room} more.` : ""}
        </p>
        <Button
          size="sm"
          onClick={() => onAdd(lines)}
          disabled={lines.length === 0 || lines.length > room || !!badRate}
          data-testid="add-hours-go"
        >
          Add {lines.length === 1 ? "this line" : `these ${lines.length} lines`}
        </Button>
      </div>
      {badRate ? (
        <p className="text-xs text-state-danger-subtle-text" role="alert">
          Enter {badRate.name}&rsquo;s hourly price in dollars, e.g. 95.
        </p>
      ) : null}
    </div>
  );
}

// ── materials ───────────────────────────────────────────────────────────────

function MaterialsPanel({
  billable,
  usedKeys,
  room,
  onAdd,
}: {
  billable: BillableResponse;
  usedKeys: ReadonlySet<string>;
  room: number;
  onAdd: (lines: ItemDraft[]) => void;
}) {
  const all = useMemo(() => materialsOf(billable), [billable]);
  const [upTo, setUpTo] = useState("");
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<"each" | "one">("each");
  const [markup, setMarkup] = useState(
    billable.prefs.materialsMarkupBp == null ? "" : bpToInput(billable.prefs.materialsMarkupBp)
  );

  const sources = [billable.supplier, billable.ledger];
  const anyOn = sources.some((s) => s.available);
  const unreadable = sources.some((s) => s.reason === "unreadable");
  const free = all.filter((m) => !m.onInvoice && !usedKeys.has(m.refKey) && (!upTo || !m.date || m.date <= upTo));
  const billedCount = all.filter((m) => m.onInvoice).length;

  if (!anyOn) {
    return (
      <p className="text-sm text-text-muted" role={unreadable ? "alert" : undefined} data-testid="add-materials-off">
        {unreadable
          ? "This job's materials couldn't be read just now. Type the lines instead, or try again shortly."
          : "Materials aren't being recorded against jobs yet, so there is nothing to pull in. Type the lines instead."}
      </p>
    );
  }

  const chosen = free.filter((m) => !off.has(m.refKey));
  const bp = markup.trim() === "" ? null : parseMarkupToBp(markup);
  const costCents = chosen.reduce((s, m) => s + m.costCents, 0);
  const lines = bp == null ? [] : buildMaterialLines(chosen, { markupBp: bp, mode });

  return (
    <div className="grid gap-3" data-testid="add-materials">
      {unreadable ? (
        <p className="text-xs text-state-warning-subtle-text" role="alert">
          Some of this job&rsquo;s materials couldn&rsquo;t be read just now, so this list may be short.
        </p>
      ) : null}

      {free.length === 0 ? (
        <p className="text-sm text-text-muted" data-testid="add-materials-empty">
          No materials on this job are waiting to be invoiced{upTo ? ` up to ${formatDay(upTo)}` : ""}.
          {billedCount > 0 ? ` ${billedCount} ${billedCount === 1 ? "is" : "are"} already on an invoice.` : ""}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
            <span>
              {free.length} {free.length === 1 ? "item" : "items"} not on an invoice yet
              {billedCount > 0 ? ` · ${billedCount} already on one` : ""}
            </span>
            <button
              type="button"
              className={LINK}
              onClick={() => setOff(chosen.length === 0 ? new Set() : new Set(free.map((m) => m.refKey)))}
            >
              {chosen.length === 0 ? "Choose all" : "Choose none"}
            </button>
          </div>
          <ul className="grid max-h-64 gap-1.5 overflow-y-auto pr-1">
            {free.map((m) => (
              <li key={m.refKey}>
                <label className="flex items-start gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    className={`${CHECK} mt-0.5`}
                    checked={!off.has(m.refKey)}
                    onChange={() =>
                      setOff((prev) => {
                        const next = new Set(prev);
                        if (next.has(m.refKey)) next.delete(m.refKey);
                        else next.add(m.refKey);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span>{m.description}</span>
                    <span className="block text-xs text-text-muted">
                      {m.supplier}
                      {m.number ? ` ${m.number}` : ""}
                      {m.date ? ` · ${formatDay(m.date)}` : ""}
                      {m.quantity != null ? ` · ${m.quantity}${m.unit ? ` ${m.unit}` : ""}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    <span className="block text-xs text-text-muted">cost</span>
                    {formatCents(m.costCents)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
        <label className="grid gap-1 text-xs text-text-muted">
          Markup on cost (%)
          <input
            className={`${INPUT} w-24`}
            inputMode="decimal"
            value={markup}
            onChange={(e) => setMarkup(e.target.value)}
            placeholder="e.g. 25"
            data-testid="add-materials-markup"
          />
        </label>
        <label className="grid gap-1 text-xs text-text-muted">
          Only items up to
          <input type="date" className={`${INPUT} w-40`} value={upTo} onChange={(e) => setUpTo(e.target.value)} />
        </label>
        <div className="grid gap-1 text-xs text-text-muted">
          <span>Show as</span>
          <Seg
            aria-label="How the materials are shown"
            value={mode}
            onChange={setMode}
            options={[
              { value: "each", label: "Each item" },
              { value: "one", label: "One Materials line" },
            ]}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted" data-testid="add-materials-total">
          {chosen.length === 0
            ? "Nothing chosen."
            : bp == null
              ? `Cost ${formatCents(costCents)}. Enter a markup to price it — 0 for at cost.`
              : `Cost ${formatCents(costCents)} plus ${formatBp(bp)} is ${formatCents(withMarkup(costCents, bp))} ex GST. The client sees the price, never the cost or the markup.`}
          {lines.length > room ? ` The invoice only has room for ${room} more ${room === 1 ? "line" : "lines"}.` : ""}
        </p>
        <Button
          size="sm"
          onClick={() => onAdd(lines)}
          disabled={lines.length === 0 || lines.length > room}
          data-testid="add-materials-go"
        >
          Add {lines.length <= 1 ? "this line" : `these ${lines.length} lines`}
        </Button>
      </div>
    </div>
  );
}

// ── usual charges ───────────────────────────────────────────────────────────

interface ChargeDraft {
  key: string;
  id?: string;
  name: string;
  unit: string;
  price: string;
  labour: boolean;
}

function UsualPanel({
  prefs,
  room,
  onAdd,
  onPrefs,
}: {
  prefs: InvoicePrefs;
  room: number;
  onAdd: (lines: ItemDraft[]) => void;
  onPrefs: (prefs: InvoicePrefs) => void;
}) {
  const [editing, setEditing] = useState(false);
  const charges = prefs.usualCharges;

  function lineFor(c: UsualCharge): ItemDraft {
    return {
      key: newKey(), type: "line", description: c.name, quantity: "1", unit: c.unit ?? "",
      price: unitPriceToInput(c.unitCents), source: c.kind === "labour" ? "labour" : "manual", refs: [], costCents: null,
    };
  }

  if (editing) return <UsualEditor prefs={prefs} onSaved={(p) => { onPrefs(p); setEditing(false); }} onCancel={() => setEditing(false)} />;

  return (
    <div className="grid gap-3" data-testid="add-usual">
      {charges.length === 0 ? (
        <p className="text-sm text-text-muted" data-testid="add-usual-empty">
          No usual charges yet. Add the ones you use again and again — a call-out fee, your hourly
          rates, travel — and they are one tap away on every invoice.
        </p>
      ) : (
        <ul className="grid gap-1.5">
          {charges.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-text">
              <span>
                {c.name}{" "}
                <span className="text-text-muted">
                  · {formatCents(c.unitCents)}
                  {c.unit ? ` per ${c.unit}` : ""}
                </span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => onAdd([lineFor(c)])} disabled={room < 1}>
                Add
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="flex flex-wrap items-baseline gap-x-2 border-t border-border pt-3 text-xs text-text-muted">
        <span>
          Usual markup on materials:{" "}
          {prefs.materialsMarkupBp == null ? "not set" : formatBp(prefs.materialsMarkupBp)}.
        </span>
        <button type="button" className={LINK} onClick={() => setEditing(true)} data-testid="add-usual-edit">
          Change the usual charges and markup
        </button>
      </p>
    </div>
  );
}

/** The business's own short list, edited in place. Saved for every invoice. */
function UsualEditor({
  prefs,
  onSaved,
  onCancel,
}: {
  prefs: InvoicePrefs;
  onSaved: (prefs: InvoicePrefs) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<ChargeDraft[]>(() =>
    prefs.usualCharges.map((c) => ({
      key: newKey(), id: c.id, name: c.name, unit: c.unit ?? "", price: unitPriceToInput(c.unitCents), labour: c.kind === "labour",
    }))
  );
  const [markup, setMarkup] = useState(prefs.materialsMarkupBp == null ? "" : bpToInput(prefs.materialsMarkupBp));
  const [round, setRound] = useState(prefs.labourRoundMinutes);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function patch(key: string, p: Partial<ChargeDraft>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)));
    setProblem(null);
  }

  async function save() {
    const usualCharges = [];
    for (const r of rows) {
      const name = r.name.trim();
      if (!name && !r.price.trim()) continue;
      if (!name) return setProblem("Each usual charge needs a name.");
      const cents = parseDollarsToCents(r.price);
      if (cents == null) return setProblem(`Enter a price for "${name}" in dollars.`);
      usualCharges.push({
        ...(r.id ? { id: r.id } : {}), name, unit: r.unit.trim() || null, unitCents: cents,
        kind: r.labour ? ("labour" as const) : ("other" as const),
      });
    }
    let materialsMarkupBp: number | null = null;
    if (markup.trim() !== "") {
      materialsMarkupBp = parseMarkupToBp(markup);
      if (materialsMarkupBp == null) {
        return setProblem("Enter the usual markup as a percentage, e.g. 25. Leave it blank for none.");
      }
    }
    setBusy(true);
    setProblem(null);
    const res = await saveInvoicePrefs({
      materialsMarkupBp, labourRoundMinutes: round, usualCharges, expectedVersion: prefs.version,
    });
    setBusy(false);
    if (res.ok) onSaved(res.data);
    else setProblem(errorMessage(errorCodeOf(res.error.body), res.error.status));
  }

  return (
    <div className="grid gap-3" data-testid="usual-editor">
      <p className="text-xs text-text-muted">
        These are yours, for every job. Nothing here is a default from BuhlOS.
      </p>
      <ul className="grid gap-2">
        {rows.map((r, i) => (
          <li key={r.key} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_4.5rem_6rem_auto_auto] sm:items-center">
            <input
              aria-label={`Usual charge ${i + 1} name`}
              className={`${INPUT} w-full`}
              value={r.name}
              onChange={(e) => patch(r.key, { name: e.target.value })}
              placeholder="e.g. Call-out fee"
              maxLength={120}
              disabled={busy}
            />
            <div className="grid grid-cols-[4.5rem_6rem_1fr] items-center gap-2 sm:contents">
              <input
                aria-label={`Usual charge ${i + 1} unit`}
                className={`${INPUT} w-full`}
                value={r.unit}
                onChange={(e) => patch(r.key, { unit: e.target.value })}
                placeholder="Unit"
                maxLength={12}
                disabled={busy}
              />
              <input
                aria-label={`Usual charge ${i + 1} price in dollars`}
                className={`${INPUT} w-full`}
                inputMode="decimal"
                value={r.price}
                onChange={(e) => patch(r.key, { price: e.target.value })}
                placeholder="Price"
                disabled={busy}
              />
              <label className="flex items-center gap-1.5 text-xs text-text-muted">
                <input
                  type="checkbox"
                  className={CHECK}
                  checked={r.labour}
                  onChange={(e) => patch(r.key, { labour: e.target.checked, unit: e.target.checked && !r.unit ? "hr" : r.unit })}
                  disabled={busy}
                />
                hourly rate
              </label>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
              disabled={busy}
              aria-label={`Remove usual charge ${i + 1}`}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {rows.length < 40 ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setRows((prev) => [...prev, { key: newKey(), name: "", unit: "", price: "", labour: false }])}
            disabled={busy}
            data-testid="usual-add"
          >
            Add a usual charge
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
        <label className="grid gap-1 text-xs text-text-muted">
          Usual markup on materials (%)
          <input
            className={`${INPUT} w-24`}
            inputMode="decimal"
            value={markup}
            onChange={(e) => {
              setMarkup(e.target.value);
              setProblem(null);
            }}
            placeholder="not set"
            disabled={busy}
            data-testid="usual-markup"
          />
        </label>
        <label className="grid gap-1 text-xs text-text-muted">
          Round pulled hours up to
          <select className={`${INPUT} w-40`} value={String(round)} onChange={(e) => setRound(Number(e.target.value))} disabled={busy}>
            <option value="0">as logged</option>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">the hour</option>
          </select>
        </label>
      </div>
      {problem ? (
        <p className="text-sm text-state-danger-subtle-text" role="alert" data-testid="usual-problem">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={busy} data-testid="usual-save">
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
