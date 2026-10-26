import type { LookupStatus, MovementKind, ReadStatus, StockItem, StockMovement, StockUnit, VerificationStatus } from "./schema";
import { canonicalWords } from "./trade-terms";

/**
 * Workshop Stock — display helpers and site-language copy (P11). Pure.
 * Quantities arrive as integer thousandths (`*Milli`); this file only formats.
 */

const MILLI = 1000;

export const UNIT_LABEL: Record<StockUnit, { singular: string; plural: string; decimals: number; chip: string }> = {
  each: { singular: "each", plural: "each", decimals: 0, chip: "Each" },
  metre: { singular: "m", plural: "m", decimals: 1, chip: "Metres" },
  length: { singular: "length", plural: "lengths", decimals: 0, chip: "Lengths" },
  bag: { singular: "bag", plural: "bags", decimals: 0, chip: "Bags" },
  box: { singular: "box", plural: "boxes", decimals: 0, chip: "Boxes" },
  roll: { singular: "roll", plural: "rolls", decimals: 0, chip: "Rolls" },
  pack: { singular: "pack", plural: "packs", decimals: 0, chip: "Packs" },
};

const PACK_PLURAL: Record<string, string> = { box: "boxes", pack: "packs", bag: "bags", roll: "rolls", length: "lengths", carton: "cartons", coil: "coils", reel: "reels" };

export function packLabel(unit: string | null | undefined, count: number): string {
  const u = unit || "pack";
  return count === 1 ? u : PACK_PLURAL[u] || `${u}s`;
}

/** "12.5" / "42" — the bare number. */
export function formatNumber(milli: number): string {
  if (!Number.isFinite(milli)) return "?";
  const sign = milli < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(milli));
  const whole = Math.floor(abs / MILLI);
  const frac = String(abs % MILLI).padStart(3, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}

/** "42 each", "12.5 m", "1 box", "3 boxes". */
export function formatQuantity(milli: number, unit: StockUnit | string): string {
  const u = UNIT_LABEL[unit as StockUnit];
  const n = formatNumber(milli);
  if (!u) return n;
  return `${n} ${Math.abs(milli) === MILLI ? u.singular : u.plural}`;
}

/**
 * A plain warning when the unit chosen for a NEW item is a container: stock
 * then only moves a whole box (bag, roll…) at a time, which is right for boxes
 * that go out unopened and wrong for singles taken out of one.
 */
export function unitHint(unit: StockUnit): string | null {
  if (unit === "box" || unit === "pack" || unit === "bag") {
    const u = UNIT_LABEL[unit];
    return `Counted in whole ${u.plural}: stock can only go out a full ${u.singular} at a time. Taking singles out of the ${u.singular}? Choose Each, and tick "Adding full, unopened boxes, packs or rolls" below.`;
  }
  if (unit === "roll") return "Counted in whole rolls: a part-used roll can't be recorded. Cable or tape taken by the metre? Choose Metres.";
  return null;
}

/** The step (in milli) the −/+ buttons move by for a unit. */
export function stepMilli(unit: StockUnit): number {
  return UNIT_LABEL[unit].decimals > 0 ? 100 : 1000;
}

/** Parse what a worker typed into milli for the unit, or null. Mirrors the server (which re-checks). */
export function parseTypedQuantity(text: string, unit: StockUnit, { allowZero = false } = {}): number | null {
  const s = text.trim();
  const m = /^(\d{1,6})(?:[.,](\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] || "").replace(/0+$/, "");
  if (frac.length > UNIT_LABEL[unit].decimals) return null;
  const milli = Number(m[1]) * MILLI + (frac ? Number(frac.padEnd(3, "0")) : 0);
  if (!Number.isSafeInteger(milli)) return null;
  if (milli === 0 && !allowZero) return null;
  return milli;
}

/** The milli value as a string the server parses exactly ("12.5", "3"). */
export function toQuantityString(milli: number): string {
  return formatNumber(milli);
}

/** Recorded-balance wording: "42 each", "≈ 40 m (estimate)", "None recorded". */
export function balanceLabel(item: Pick<StockItem, "balanceMilli" | "baseUnit" | "estimated">): string {
  if (item.balanceMilli === 0) return "None recorded";
  return item.estimated ? `≈ ${formatQuantity(item.balanceMilli, item.baseUnit)} (estimate)` : formatQuantity(item.balanceMilli, item.baseUnit);
}

/** "17 each recorded now", "none recorded now", "20 each recorded at Shelf A2" — never "None recorded recorded". */
export function recordedNow(item: Pick<StockItem, "balanceMilli" | "baseUnit" | "estimated">, at?: string | null): string {
  return `${item.balanceMilli === 0 ? "none" : balanceLabel(item)} recorded ${at ? `at ${at}` : "now"}`;
}

/** Short identity line under a name: "Clipsal · 2025WE · White · 10A". */
export function identityLine(item: Pick<StockItem, "brand" | "manufacturerCode" | "colourFinish" | "variant">): string {
  return [item.brand, item.manufacturerCode, item.colourFinish, item.variant].filter(Boolean).join(" · ");
}

export const MOVEMENT_LABEL: Record<MovementKind, string> = {
  opening: "Opening count",
  add: "Added",
  take: "Taken",
  return: "Returned",
  count: "Counted",
  reversal: "Undone",
};

/** "Taken 2 each" / "Added 2 boxes (20 each)" / "Counted 40 m". */
export function movementSummary(m: Pick<StockMovement, "kind" | "quantityMilli" | "countedMilli" | "pack">, unit: StockUnit | string): string {
  if (m.kind === "count") return `Counted ${formatQuantity(m.countedMilli ?? 0, unit)}`;
  const qty = formatQuantity(Math.abs(m.quantityMilli), unit);
  if (m.kind === "reversal") return `Undone (${m.quantityMilli >= 0 ? "+" : "−"}${qty})`;
  const pack = m.pack ? ` (${m.pack.count} ${packLabel(m.pack.unit, m.pack.count)})` : "";
  return `${MOVEMENT_LABEL[m.kind]} ${qty}${pack}`;
}

export function signedQuantity(milli: number, unit: StockUnit | string): string {
  if (milli === 0) return `±0 ${UNIT_LABEL[unit as StockUnit]?.plural ?? ""}`.trim();
  return `${milli > 0 ? "+" : "−"}${formatQuantity(Math.abs(milli), unit)}`;
}

export const VERIFICATION_LABEL: Record<VerificationStatus, string> = {
  manufacturer_code_matched: "Manufacturer code matched",
  possible_match: "Possible match",
  unverified: "Saved without external verification",
};

export const LOOKUP_LABEL: Record<LookupStatus, string> = {
  manufacturer_code_matched: "Manufacturer code matched",
  possible_match: "Possible match",
  no_match: "No listing found",
  unavailable: "Couldn't check online",
  not_configured: "Online check not set up",
  not_checked: "Not checked",
};

export const READ_STATUS_COPY: Record<Exclude<ReadStatus, "ok">, { title: string; body: string }> = {
  not_configured: { title: "Photo reading isn't set up", body: "Search the list instead — nothing is lost." },
  daily_limit: { title: "Today's photo reads are used up", body: "Search the list instead. Photo reading is back tomorrow." },
  unreadable: { title: "Couldn't read a label in that photo", body: "Try closer, with the label or code in shot and some light — or search." },
  unavailable: { title: "Photo reading isn't working right now", body: "Search the list instead, or try the photo again in a minute." },
};

/**
 * The catalogue-match status for a photo whose barcode or code identified ONE of
 * our items (only an exact, uncontested match gets it — anything weaker is a
 * short list the worker picks from).
 */
export function matchedInWorkshop(c: { evidence: string; matchedValue: string | null }): string {
  const what = c.evidence === "barcode" ? "barcode" : c.evidence === "supplier_sku" ? "supplier SKU" : "code";
  return c.matchedValue ? `Matched in workshop · ${what} ${c.matchedValue}` : "Matched in workshop";
}

export const EVIDENCE_LABEL: Record<string, string> = {
  barcode: "Barcode matches",
  manufacturer_code: "Code matches",
  supplier_sku: "Supplier SKU matches",
  code_punctuation: "Code nearly matches — check it",
  cross_kind: "A code matches — check which one",
  description: "Looks like it — check the code",
};

/**
 * Site-language copy for API error codes. `body` is the parsed error body so a
 * message can quote the recorded balance the server sent.
 */
export function errorCopy(status: number, body: unknown, fallback = "That didn't save. Try again."): string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const code = typeof b.error === "string" ? b.error : "";
  if (status === 0) return "Not saved — no signal. Your details are kept; try again when you've got reception.";
  if (status === 401) return "You've been signed out. Sign in again — nothing was saved.";
  switch (code) {
    case "insufficient_stock":
      return `Only ${String(b.recorded ?? "less")} recorded. If there's more on the shelf, ask the office to correct the count.`;
    case "undo_would_go_negative":
      return `Can't undo — some of it has been taken since (${String(b.recorded ?? "less")} recorded now). Ask the office to correct the count.`;
    case "already_undone":
      return "That was already undone.";
    case "cannot_undo_undo":
      return "An undo can't be undone. Record the stock again instead.";
    case "undo_counted_since":
      return "It's been counted since — that count already includes this. If the shelf is still wrong, correct the count.";
    case "undo_window_passed":
      return "Too late to undo on the phone. Ask the office to fix it.";
    case "undo_not_yours":
      return "You can only undo your own changes. Ask the office.";
    case "undo_office_only":
      return "Only the office can undo that.";
    case "reason_required":
      return "Add a short reason (3 characters or more).";
    case "idempotency_conflict":
      return "That clashed with an earlier save. Start again.";
    case "item_archived":
      return "That item has been archived by the office.";
    case "item_not_found":
      return "That item isn't in the workshop list any more.";
    case "duplicate_item":
      return "This code is already in the workshop list.";
    case "stock_changed":
      return "Stock changed while you were counting.";
    case "item_changed":
      return "Someone else changed this item. Reload it and try again.";
    case "unit_locked":
      return "The unit can't change once stock has moved. Archive this item and add it again with the right unit.";
    case "identifier_in_use":
      return "That code is already on another item.";
    case "job_not_available":
      return "That job isn't open any more — pick another or leave it blank.";
    case "pack_changed": {
      const pack = b.pack && typeof b.pack === "object" ? (b.pack as { unit?: unknown; sizeMilli?: unknown }) : null;
      const size = pack && typeof pack.sizeMilli === "number" ? formatNumber(pack.sizeMilli) : null;
      return size
        ? `The office changed the ${String(pack?.unit ?? "pack")} size to ${size} — nothing was saved. Check how many and confirm again.`
        : "The pack size changed — nothing was saved. Check how many and confirm again.";
    }
    case "pack_not_found":
      return "That pack size isn't set up any more — nothing was saved. Enter the quantity instead.";
    case "movement_not_found":
      return "That change isn't in the history any more. Reload and check.";
    case "identifier_not_found":
      return "That code was already removed.";
    case "no_code":
      return "Add a manufacturer code to check it online.";
    case "quantity_too_precise":
      return "That unit only takes whole numbers (metres: one decimal place).";
    case "quantity_zero":
      return "Enter a quantity above zero.";
    case "quantity_too_large":
      return "That quantity is too large — check it.";
    case "quantity_invalid":
    case "quantity_required":
      return "Enter a number for the quantity.";
    case "pack_incomplete":
    case "pack_size_invalid":
    case "pack_count_invalid":
      return "Check the pack: how many packs, and how many in each.";
    case "photo_too_large":
      return "That photo is too big. Take it again a bit further back.";
    case "photo_not_supported":
      return "That photo format isn't supported. Take a new photo, or pick a JPEG or PNG.";
    case "photo_unreadable":
      return "That file doesn't look like a photo. Take it again.";
    case "photo_store_failed":
      return "Couldn't save the photo just now. Try again — or carry on without it.";
    case "photo_unavailable":
      return "Couldn't load that photo right now.";
    case "photo_not_available":
      return "That photo has expired. Take it again.";
    case "photo_limit":
    case "lookup_limit":
      return "That's a lot of reads in a short time — wait a few minutes or search the list.";
    case "code_invalid":
      return "That doesn't look like a product code. Check it against the label.";
    case "barcode_invalid":
      return "That barcode doesn't check out — leave it blank or re-read it.";
    case "office_only":
      return "Only the office can do that.";
    case "store_unavailable":
    case "store_unprovisioned":
      return "Workshop stock can't save right now — nothing was saved. Try again in a few minutes, or tell the office.";
    default:
      return fallback;
  }
}

/**
 * Case-insensitive all-words search over the things a worker would type — and
 * in trade names too: "power point" finds the GPO, "twin and earth" the TPS,
 * whichever words the item was saved under. A confirmed listing's product name
 * is searchable as well (never shown in place of the name the crew gave it).
 */
export function matchesSearch(item: Pick<StockItem, "name" | "brand" | "manufacturerCode" | "supplierSku" | "location" | "variant" | "colourFinish" | "identifiers"> & Partial<Pick<StockItem, "verificationStatus" | "verification">>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const listingName = item.verificationStatus === "manufacturer_code_matched" && item.verification?.productName ? item.verification.productName : null;
  const fields = [item.name, item.brand, item.manufacturerCode, item.supplierSku, item.location, item.variant, item.colourFinish, listingName, ...item.identifiers.map((i) => i.value)]
    .filter(Boolean)
    .join(" ");
  const hay = fields.toLowerCase();
  const hayTight = hay.replace(/[\s\-./]/g, "");
  if (q.split(/\s+/).every((w) => hay.includes(w) || hayTight.includes(w.replace(/[\s\-./]/g, "")))) return true;
  const words = canonicalWords(q);
  if (!words.length) return false;
  const canon = canonicalWords(fields).join(" ");
  return words.every((w) => canon.includes(w));
}

/** "5 min ago", "2 h ago", "3 Oct". */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const mins = Math.round((now - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(t).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "Australia/Sydney" });
}

/** Proxy URL for a product photo (or its list-size copy) — the Blob URL never reaches the browser. */
export function photoUrl(photoId: string, size: "full" | "thumb" = "full"): string {
  return `/api/workshop-stock?action=photo&id=${encodeURIComponent(photoId)}${size === "thumb" ? "&size=thumb" : ""}`;
}

// ── time and receipt copy (the redesigned screens) ─────────────────────────────

/** "7:42am" — a clock time in site language (lower-case am/pm, Sydney). */
export function clockTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: "Australia/Sydney" }).replace(/\s?([ap])\.?m\.?/i, "$1m").toLowerCase();
}

/**
 * When something happened, the way a worker says it: a clock time today
 * ("7:42am"), the day and date inside a week ("Fri 23 Oct"), the date after
 * ("12 Oct"). Never "never" — that is the caller's word for a missing date.
 */
export function whenLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const tz = "Australia/Sydney";
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-AU", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz });
  if (day(t) === day(now)) return clockTime(iso) ?? "—";
  if (now - t < 7 * 24 * 3600_000 && t <= now) return new Date(t).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).replace(",", "");
  return new Date(t).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: tz });
}

/** "You can undo this until 8:12am." — only while the server says this viewer may undo it. */
export function undoUntilLabel(undo: { allowed: boolean; until?: string | null } | null | undefined): string | null {
  if (!undo?.allowed) return null;
  const at = clockTime(undo.until);
  return at ? `You can undo this until ${at}.` : null;
}

/** "Undo take" / "Undo add" / "Undo return" / "Undo count" — the mini button on a receipt or a movement row. */
export function undoLabelFor(kind: MovementKind): string {
  switch (kind) {
    case "take": return "Undo take";
    case "add": return "Undo add";
    case "return": return "Undo return";
    case "count": return "Undo count";
    case "opening": return "Undo opening count";
    default: return "Undo";
  }
}

export const VERIFICATION_SHORT: Record<VerificationStatus, string> = {
  manufacturer_code_matched: "Code matched",
  possible_match: "Possible match",
  unverified: "Not verified",
};

/**
 * The product-code status WITH its reason when there is one: "Possible match —
 * colour not confirmed". A clean match or an unverified item is just its label.
 */
export function verificationLine(item: Pick<StockItem, "verificationStatus" | "verification">): string {
  const label = VERIFICATION_LABEL[item.verificationStatus];
  const reason = item.verificationStatus === "possible_match" ? item.verification?.reasons?.[0] : null;
  if (!reason) return label;
  const r = reason.replace(/\.$/, "");
  return `${label} — ${r.charAt(0).toLowerCase()}${r.slice(1)}`;
}

/** "Dan · 7:42am · note: IV1240 Mascot fit-off" — who, when, and the optional job note. */
export function movementWho(m: Pick<StockMovement, "actorId" | "actorName" | "createdAt" | "jobLabel">, viewerId?: string | null, now = Date.now()): string {
  const who = viewerId && m.actorId === viewerId ? "You" : m.actorName ?? "Someone";
  return [who, whenLabel(m.createdAt, now), m.jobLabel ? `note: ${m.jobLabel}` : null].filter(Boolean).join(" · ");
}
