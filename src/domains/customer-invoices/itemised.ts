import type {
  BillableDay,
  BillableResponse,
  InvoiceItem,
  ItemInput,
  ItemRef,
  ItemSource,
  ItemisedInput,
} from "./schema";
import { formatDay } from "./format";

/**
 * The itemised-invoice editor's logic, kept pure so the tests pin every
 * figure and every refusal (#1161 / #1162). Quantities are whole THOUSANDTHS,
 * money is whole cents; the maths here mirrors the server's
 * (api/_lib/customer-invoices/amounts.js `lineAmountCents`,
 * api/_lib/customer-invoices/billable.js) so a preview never disagrees with
 * what is saved. The server is still the authority: it re-prices every line,
 * works out every cost itself, and refuses anything billed twice.
 */

export const MAX_ITEMS = 100;
export const MAX_QUANTITY_MILLI = 100_000_000;
export const MAX_UNIT_CENTS = 10_000_000;

/** quantity (thousandths) × unit price (cents) → cents, rounded half away
 *  from zero. Null when either figure is unusable. */
export function lineAmountCents(quantityMilli: number, unitCents: number): number | null {
  if (!Number.isInteger(quantityMilli) || quantityMilli <= 0 || quantityMilli > MAX_QUANTITY_MILLI) return null;
  if (!Number.isInteger(unitCents) || Math.abs(unitCents) > MAX_UNIT_CENTS) return null;
  const cents = Math.floor((quantityMilli * Math.abs(unitCents) + 500) / 1000);
  return (unitCents < 0 ? -cents : cents) || 0;
}

/** "2.5" → 2500. Up to three decimals, more than zero. A typo is refused,
 *  never rounded into shape. */
export function parseQuantityToMilli(input: string): number | null {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const milli = Number(whole) * 1000 + Number(frac.padEnd(3, "0") || "0");
  if (!Number.isSafeInteger(milli) || milli < 1 || milli > MAX_QUANTITY_MILLI) return null;
  return milli;
}

/** 2500 → "2.5", 1000 → "1", 12750 → "12.75". */
export function milliToInput(milli: number | null | undefined): string {
  if (milli == null || !Number.isFinite(milli)) return "";
  const whole = Math.floor(milli / 1000);
  const frac = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * A typed unit price → cents. Unlike an amount, it may be negative (a
 * discount or credit line) and may be zero (an item listed at no charge).
 */
export function parseUnitPriceToCents(input: string): number | null {
  const raw = input.trim().replace(/,/g, "");
  const negative = /^-/.test(raw);
  const s = raw.replace(/^-/, "").replace(/^\$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents) || cents > MAX_UNIT_CENTS) return null;
  return negative ? -cents || 0 : cents;
}

/** Cents → what a unit-price input is pre-filled with ("-50.00", "95.00"). */
export function unitPriceToInput(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  const abs = Math.abs(Math.trunc(cents));
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * A typed markup → basis points. "25" → 2500, "12.5%" → 1250, "0" → 0 (at
 * cost). A markup can be well over 100%, so this is not a percentage OF
 * something: up to 1,000%, two decimals.
 */
export function parseMarkupToBp(input: string): number | null {
  const s = input.trim().replace(/%$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const bp = Number(whole) * 100 + Number(frac.padEnd(2, "0") || "0");
  return Number.isSafeInteger(bp) && bp <= 100000 ? bp : null;
}

/** Cost plus a markup: cost × (1 + bp/10000), half away from zero. */
export function withMarkup(costCents: number, markupBp: number): number {
  const abs = Math.abs(costCents);
  const sell = Math.floor((abs * (10000 + markupBp) + 5000) / 10000);
  return (costCents < 0 ? -sell : sell) || 0;
}

/**
 * Margin on a sale: what is left after cost, and that as a share of the SALE
 * (not of the cost — a 30% markup is a 23% margin). Null share when there is
 * no sale to divide by.
 */
export function marginOf(sellCents: number, costCents: number): { marginCents: number; marginBp: number | null } {
  const marginCents = sellCents - costCents;
  return {
    marginCents,
    marginBp: sellCents > 0 ? Math.round((marginCents * 10000) / sellCents) : null,
  };
}

// ── the form's rows ─────────────────────────────────────────────────────────

/** One row of the editor, as typed. */
export interface ItemDraft {
  key: string;
  /** The stored line's id when editing an existing invoice. */
  id?: string;
  type: "line" | "note";
  description: string;
  quantity: string;
  unit: string;
  price: string;
  source: ItemSource;
  /** What the line bills on the job. Empty for a typed line. */
  refs: ItemRef[];
  /** What it cost — shown to the office, worked out again by the server. */
  costCents: number | null;
}

let keySeq = 0;
export const newKey = (): string => `row-${++keySeq}`;

export function blankLine(): ItemDraft {
  return { key: newKey(), type: "line", description: "", quantity: "1", unit: "", price: "", source: "manual", refs: [], costCents: null };
}
export function blankNote(): ItemDraft {
  return { key: newKey(), type: "note", description: "", quantity: "", unit: "", price: "", source: "manual", refs: [], costCents: null };
}

/** A stored invoice's lines → editor rows. */
export function draftsFromItems(items: ReadonlyArray<InvoiceItem>): ItemDraft[] {
  return items.map((it) =>
    it.type === "note"
      ? { ...blankNote(), id: it.id, description: it.description }
      : {
          key: newKey(),
          id: it.id,
          type: "line" as const,
          description: it.description,
          quantity: milliToInput(it.quantityMilli),
          unit: it.unit ?? "",
          price: unitPriceToInput(it.unitCents),
          source: it.source,
          refs: it.refs,
          costCents: it.costCents,
        }
  );
}

/** What one row comes to, or null while it isn't a usable charge yet. */
export function draftAmountCents(d: ItemDraft): number | null {
  if (d.type !== "line") return null;
  const q = parseQuantityToMilli(d.quantity);
  const p = parseUnitPriceToCents(d.price);
  return q == null || p == null ? null : lineAmountCents(q, p);
}

/** Is this row completely untouched (so it can be dropped without a word)? */
function isBlank(d: ItemDraft): boolean {
  if (d.refs.length > 0) return false;
  if (d.type === "note") return !d.description.trim();
  return !d.description.trim() && !d.price.trim() && (d.quantity.trim() === "" || d.quantity.trim() === "1");
}

/**
 * The typed form → what is sent, or the first thing wrong with it, named so
 * the person can fix it.
 */
export function buildItemisedInput(form: {
  title: string;
  items: ReadonlyArray<ItemDraft>;
  plannedDate: string;
  retentionBp: number | null;
  note: string | null;
}): { ok: true; input: ItemisedInput; totalCents: number } | { ok: false; field: string; key?: string; message: string } {
  const title = form.title.trim();
  if (!title) return { ok: false, field: "title", message: "Say what the work was." };
  if (title.length > 200) return { ok: false, field: "title", message: "Keep it under 200 characters." };

  const items: ItemInput[] = [];
  let totalCents = 0;
  let charges = 0;
  for (const d of form.items) {
    if (isBlank(d)) continue;
    const description = d.description.trim();
    if (d.type === "note") {
      if (description.length > 2000) return { ok: false, field: "items", key: d.key, message: "Keep a note under 2,000 characters." };
      items.push({ ...(d.id ? { id: d.id } : {}), type: "note", description });
      continue;
    }
    if (!description) return { ok: false, field: "items", key: d.key, message: "Each line needs a description." };
    if (description.length > 1000) return { ok: false, field: "items", key: d.key, message: `Shorten "${description.slice(0, 40)}…" to under 1,000 characters.` };
    const quantityMilli = parseQuantityToMilli(d.quantity);
    if (quantityMilli == null) {
      return { ok: false, field: "items", key: d.key, message: `Enter a quantity for "${description}", e.g. 1 or 2.5.` };
    }
    const unitCents = parseUnitPriceToCents(d.price);
    if (unitCents == null) {
      return { ok: false, field: "items", key: d.key, message: `Enter a price for "${description}" in dollars, e.g. 95 or 95.50.` };
    }
    const amount = lineAmountCents(quantityMilli, unitCents);
    if (amount == null) return { ok: false, field: "items", key: d.key, message: `"${description}" is too large to invoice on one line.` };
    const unit = d.unit.trim();
    if (unit.length > 12) return { ok: false, field: "items", key: d.key, message: "Keep the unit short, e.g. hr, m or ea." };
    totalCents += amount;
    charges += 1;
    items.push({
      ...(d.id ? { id: d.id } : {}),
      type: "line",
      description,
      quantityMilli,
      unit: unit || null,
      unitCents,
      source: d.source,
      ...(d.refs.length > 0 ? { refs: d.refs } : {}),
    });
  }
  if (charges === 0) return { ok: false, field: "items", message: "Add at least one line with a price." };
  if (items.length > MAX_ITEMS) return { ok: false, field: "items", message: `An invoice can have up to ${MAX_ITEMS} lines.` };
  if (totalCents < 1) return { ok: false, field: "items", message: "The lines need to add up to more than $0." };
  if (form.plannedDate && !/^\d{4}-\d{2}-\d{2}$/.test(form.plannedDate)) {
    return { ok: false, field: "plannedDate", message: "Pick a valid date." };
  }
  return {
    ok: true,
    totalCents,
    input: {
      kind: "itemised",
      title,
      items,
      retentionBp: form.retentionBp,
      plannedDate: form.plannedDate || null,
      note: form.note,
    },
  };
}

/**
 * What the rows add up to, and — for the office only — what they cost.
 * `costKnown` is false when a line pulled from the job has no cost (a worker
 * with no cost rate): the margin is then left out rather than overstated.
 * Typed lines with no cost simply aren't part of the margin.
 */
export function draftSummary(items: ReadonlyArray<ItemDraft>): {
  totalCents: number;
  pricedCount: number;
  costCents: number;
  costedSellCents: number;
  costKnown: boolean;
} {
  let totalCents = 0;
  let pricedCount = 0;
  let costCents = 0;
  let costedSellCents = 0;
  let costKnown = true;
  for (const d of items) {
    const a = draftAmountCents(d);
    if (a == null) continue;
    totalCents += a;
    pricedCount += 1;
    if (d.costCents != null) {
      costCents += d.costCents;
      costedSellCents += a;
    } else if (d.source === "labour" || d.source === "material") {
      costKnown = false;
    }
  }
  return { totalCents, pricedCount, costCents, costedSellCents, costKnown };
}

// ── hours → lines ───────────────────────────────────────────────────────────

/** Round hours UP to a step in minutes (0 = leave as logged). */
export function roundUpMilli(milli: number, minutes: number): number {
  if (!minutes) return milli;
  const step = Math.round((minutes * 1000) / 60);
  return Math.ceil(milli / step) * step;
}

/** "12 Nov 2026" or "10 – 12 Nov 2026" style range for a set of days. */
export function dayRange(days: ReadonlyArray<string>): string {
  if (days.length === 0) return "";
  const sorted = [...days].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return first === last ? formatDay(first) : `${formatDay(first)} to ${formatDay(last)}`;
}

/** hours (thousandths) × hourly rate (cents) → cents. */
function hoursCost(milli: number, rateCents: number): number {
  return Math.floor((milli * rateCents + 500) / 1000);
}

/**
 * The job's unbilled hours → invoice lines.
 *
 * `rates` holds the hourly price chosen for each worker (their charge-out
 * rate, or one typed on the spot); a worker with none gets a line with a
 * blank price to fill in — never a guessed rate.
 *
 *   worker  one line per worker
 *   rate    one line per hourly price (workers on the same price together)
 */
export function buildLabourLines(
  days: ReadonlyArray<BillableDay>,
  opts: { groupBy: "worker" | "rate"; roundMinutes: number; rates: Readonly<Record<string, number | null>> }
): ItemDraft[] {
  const usable = days.filter((d) => d.unbilledMilli > 0);
  const groups = new Map<string, { label: string; rate: number | null; days: BillableDay[] }>();
  for (const d of usable) {
    const rate = opts.rates[d.userId] ?? null;
    const k = opts.groupBy === "worker" ? `w:${d.userId}` : `r:${rate ?? "none"}`;
    const g = groups.get(k) ?? { label: opts.groupBy === "worker" ? d.name : "", rate, days: [] };
    g.days.push(d);
    groups.set(k, g);
  }
  const out: ItemDraft[] = [];
  for (const g of groups.values()) {
    const milli = g.days.reduce((s, d) => s + d.unbilledMilli, 0);
    const range = dayRange(g.days.map((d) => d.date));
    // The cost is only shown when every day in the line has a cost rate — the
    // server works it out again either way, from its own records.
    const costCents = g.days.every((d) => d.costRateCents != null)
      ? g.days.reduce((s, d) => s + hoursCost(d.unbilledMilli, d.costRateCents as number), 0)
      : null;
    out.push({
      key: newKey(),
      type: "line",
      description: g.label ? `Labour: ${g.label}, ${range}` : `Labour, ${range}`,
      quantity: milliToInput(roundUpMilli(milli, opts.roundMinutes)),
      unit: "hr",
      price: g.rate == null ? "" : unitPriceToInput(g.rate),
      source: "labour",
      refs: g.days.map((d) => ({ t: "h" as const, u: d.userId, d: d.date, m: d.unbilledMilli })),
      costCents,
    });
  }
  return out;
}

// ── materials → lines ───────────────────────────────────────────────────────

/** One material that can be billed, whichever source it came from. */
export interface BillableMaterial {
  ref: ItemRef;
  refKey: string;
  date: string | null;
  supplier: string;
  number: string | null;
  description: string;
  quantity: number | null;
  unit: string | null;
  costCents: number;
  onInvoice: string | null;
}

/**
 * Every material on the job, oldest first, from all three sources. A supplier
 * invoice taken as one amount, or a docket with no wording, is described as
 * "Materials": the supplier's name is shown to the office in the picker, but
 * is never put on the client's invoice unless a person types it there.
 */
export function materialsOf(b: BillableResponse): BillableMaterial[] {
  const out: BillableMaterial[] = [];
  for (const l of b.supplier.lines) {
    out.push({
      ref: { t: "sl", id: l.id }, refKey: `sl:${l.id}`, date: l.date, supplier: l.supplier, number: l.number,
      description: l.description, quantity: l.quantity, unit: l.unit, costCents: l.costCents, onInvoice: l.onInvoice,
    });
  }
  for (const l of b.supplier.whole) {
    out.push({
      ref: { t: "si", id: l.id }, refKey: `si:${l.id}`, date: l.date, supplier: l.supplier, number: l.number,
      description: "Materials", quantity: null, unit: null,
      costCents: l.costCents, onInvoice: l.onInvoice,
    });
  }
  for (const l of b.ledger.lines) {
    out.push({
      ref: { t: "ml", id: l.id }, refKey: `ml:${l.id}`, date: l.date, supplier: l.supplier, number: l.number,
      description: l.description || "Materials", quantity: null, unit: null,
      costCents: l.costCents, onInvoice: l.onInvoice,
    });
  }
  return out.sort((a, b2) => String(a.date ?? "").localeCompare(String(b2.date ?? "")));
}

/** A supplier's quantity → thousandths, when it is a clean positive number
 *  with at most three decimals. Otherwise the line is billed as one item. */
function cleanQuantityMilli(q: number | null): number | null {
  if (q == null || !Number.isFinite(q) || q <= 0) return null;
  const milli = Math.round(q * 1000);
  if (Math.abs(milli - q * 1000) > 1e-6 || milli > MAX_QUANTITY_MILLI) return null;
  return milli;
}

/**
 * Chosen materials → invoice lines, at cost plus `markupBp`.
 *   each  one line per item, keeping the supplier's quantity where it is clean
 *   one   a single "Materials" line for the lot
 */
export function buildMaterialLines(
  chosen: ReadonlyArray<BillableMaterial>,
  opts: { markupBp: number; mode: "each" | "one" }
): ItemDraft[] {
  if (chosen.length === 0) return [];
  if (opts.mode === "one") {
    const cost = chosen.reduce((s, m) => s + m.costCents, 0);
    return [{
      key: newKey(), type: "line", description: "Materials", quantity: "1", unit: "",
      price: unitPriceToInput(withMarkup(cost, opts.markupBp)), source: "material",
      refs: chosen.map((m) => m.ref), costCents: cost,
    }];
  }
  return chosen.map((m) => {
    const sell = withMarkup(m.costCents, opts.markupBp);
    const qty = cleanQuantityMilli(m.quantity);
    // A per-unit price only when it divides to a whole cent; otherwise the
    // line is billed as one item so the total is exactly cost plus markup.
    const perUnit = qty != null && qty !== 1000 && (sell * 1000) % qty === 0 ? (sell * 1000) / qty : null;
    return {
      key: newKey(),
      type: "line" as const,
      description: perUnit == null && qty != null && qty !== 1000
        ? `${m.description} (${milliToInput(qty)}${m.unit ? ` ${m.unit}` : ""})`
        : m.description,
      quantity: perUnit == null ? "1" : milliToInput(qty),
      unit: perUnit == null ? "" : m.unit ?? "",
      price: unitPriceToInput(perUnit == null ? sell : perUnit),
      source: "material" as const,
      refs: [m.ref],
      costCents: m.costCents,
    };
  });
}

/** The key a ref is known by, for "is this already in the draft?". */
export function refKeyOf(r: ItemRef): string {
  return r.t === "h" ? `h:${r.u}|${r.d}` : `${r.t}:${r.id}`;
}

/** Everything the draft's own rows already bill. */
export function draftRefKeys(items: ReadonlyArray<ItemDraft>): Set<string> {
  const out = new Set<string>();
  for (const d of items) for (const r of d.refs) out.add(refKeyOf(r));
  return out;
}

/** Hours (thousandths) as a person reads them: "7.5 h". */
export function formatHours(milli: number): string {
  return `${milliToInput(milli) || "0"} h`;
}

