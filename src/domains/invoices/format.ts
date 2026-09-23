import type { DocumentType, Invoice, InvoiceStatus, MaterialCategory } from "./schema";
import type { StatusTone } from "@/components/ui/StatusChip";

/** Office wording for statuses (the inbox filter chips use the same words). */
export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  received: "Received",
  processing: "Reading…",
  matched: "Matched — awaiting confirmation",
  needs_review: "Needs review",
  confirmed: "Confirmed",
  duplicate: "Duplicate",
  excluded: "Excluded",
  failed: "Failed",
  archived: "Archived",
};

export function statusLabel(status: InvoiceStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusTone(status: InvoiceStatus): StatusTone {
  switch (status) {
    case "confirmed":
      return "success";
    case "matched":
      return "info";
    case "needs_review":
    case "received":
    case "processing":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  invoice: "Invoice",
  tax_invoice: "Tax invoice",
  credit_note: "Credit note",
  statement: "Statement",
  quote: "Quote",
  delivery_docket: "Delivery docket",
  order_confirmation: "Order confirmation",
  remittance: "Remittance advice",
  purchase_order: "Purchase order",
  other: "Other paperwork",
  unknown: "Unknown document",
};

export function documentTypeLabel(t: DocumentType): string {
  return DOCUMENT_TYPE_LABELS[t] ?? t;
}

/** Mirrors REVIEW_REASON_LABELS in api/_lib/invoices/state.js. */
export const REVIEW_REASON_LABELS: Record<string, string> = {
  no_iv_reference: "No IV job reference found on the document",
  iv_not_found: "The IV job reference does not match any job",
  iv_ambiguous: "More than one job carries this IV reference",
  multi_reference: "Several different IV references appear on the document",
  totals_inconsistent: "Ex-GST + GST does not equal the total",
  missing_subtotal: "No ex-GST amount could be read",
  unknown_document_type: "Could not tell what kind of document this is",
  not_allocatable: "Statements and quotes are never job costs",
  statement_missing_invoices: "Invoices on this statement were never captured — see the statement check below",
  no_text_layer: "The PDF has no readable text (scanned image) — enter the details by hand",
  job_inactive: "The matched job is not active",
  extraction_failed: "The document could not be read",
  negative_amounts: "The amounts are negative — is this a credit note?",
  image_only: "This is a photo or scan — enter the details by hand",
  no_attachment: "The email had no attachment — the invoice may be behind a link",
  forwarded_as_attachment: "The email was forwarded as an attachment (.eml) — open it and forward the PDF itself",
  zip_attachment: "The attachment is a zip — unpack it and upload the PDF",
  unsupported_attachment: "The attachment is not a PDF or a photo — upload the invoice itself",
  attachment_unreadable: "The attachment could not be downloaded or read (too large, corrupt, or not really a PDF) — attach the invoice by hand",
};

/** Human label for an auto set-aside reason (excluded_reason = not_an_invoice:<type>). */
export function excludedReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const m = /^not_an_invoice:(\w+)$/.exec(reason);
  if (m) return `Set aside automatically — ${DOCUMENT_TYPE_LABELS[m[1] as DocumentType]?.toLowerCase() ?? m[1]}, not an invoice`;
  return reason;
}

export function reviewReasonLabel(code: string): string {
  return REVIEW_REASON_LABELS[code] ?? code.replace(/_/g, " ");
}

/** Why the Confirm button is disabled — mirrors confirmBlockers in api/invoices.js. */
export const CONFIRM_BLOCKER_LABELS: Record<string, string> = {
  status: "This document is not awaiting confirmation",
  no_job: "Choose the matched BuhlOS job first",
  not_allocatable: "Only invoices and credit notes can be confirmed as costs",
  missing_subtotal: "Enter the cost excluding GST first",
  totals_inconsistent: "Fix the totals — ex-GST + GST must equal the total",
  iv_ambiguous: "More than one job carries this IV reference — choose the job",
};

export function confirmBlockerLabel(code: string): string {
  return CONFIRM_BLOCKER_LABELS[code] ?? code.replace(/_/g, " ");
}

/** Cents → "$1,234.56" (always two decimals — money surfaces). Null → "—". */
export function formatCentsExact(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-AU");
  const rem = String(abs % 100).padStart(2, "0");
  return `${neg ? "-$" : "$"}${dollars}.${rem}`;
}

/** "$1,234.56" / "1234.5" / "" → integer cents or null. Pure. */
export function dollarsInputToCents(input: string): number | null {
  const s = input.replace(/[$,\s]/g, "").trim();
  if (!s) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

/** Per-document sign of the cost contribution: invoices +, credit notes −. */
export function signedCostCents(inv: Pick<Invoice, "documentType" | "subtotalCents">): number | null {
  if (inv.subtotalCents == null) return null;
  if (inv.documentType === "credit_note") return -inv.subtotalCents;
  if (inv.documentType === "invoice" || inv.documentType === "tax_invoice") return inv.subtotalCents;
  return null;
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

/** "Booking in 3h 20m" / "Booking now" for a scheduled automatic booking. */
export function autoBookCountdown(autoConfirmAt: string | null | undefined, now: Date = new Date()): string | null {
  if (!autoConfirmAt) return null;
  const ms = new Date(autoConfirmAt).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "Booking on the next sweep";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `Books itself in ${h > 0 ? `${h}h ` : ""}${m}m unless held`;
}

/** Mirrors CATEGORY_LABELS in api/_lib/invoices/categories.js. */
export const CATEGORY_LABELS: Record<MaterialCategory, string> = {
  cable: "Cable",
  conduit: "Conduit & ducting",
  fixings: "Fixings & fasteners",
  switchgear: "Switchgear & protection",
  boards: "Boards & enclosures",
  lighting: "Lighting",
  accessories: "Power points & switches",
  data: "Data & comms",
  consumables: "Consumables",
  tools: "Tools",
  testing: "Testing & safety",
  freight: "Freight & delivery",
  other: "Other",
};
export function categoryLabel(c: string): string {
  return (CATEGORY_LABELS as Record<string, string>)[c] ?? c;
}
export const CATEGORY_SOURCE_LABELS: Record<string, string> = {
  rule: "filed by keyword",
  learned: "filed as you did last time",
  ai: "filed by AI",
  manual: "filed by the office",
};

/** "12 × ea" / "3 roll" — a quantity with its unit, or "—". */
export function formatQuantity(q: number | null | undefined, unit: string | null | undefined): string {
  if (q == null) return "—";
  const n = Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/\.?0+$/, "");
  return unit ? `${n} ${unit}` : n;
}

export const EVENT_LABELS: Record<string, string> = {
  received: "Received by email",
  uploaded: "Uploaded",
  extracted: "Details read from the PDF",
  lines_read: "Line items read",
  line_corrected: "A line was re-filed",
  matched: "IV reference matched a job",
  review_required: "Sent to review",
  duplicate_detected: "Flagged as a duplicate",
  corrected: "Details corrected",
  job_selected: "Job chosen",
  confirmed: "Cost confirmed",
  reassigned: "Moved to another job",
  marked_duplicate: "Marked as a duplicate",
  excluded: "Excluded",
  auto_excluded: "Set aside automatically (not an invoice)",
  attached: "Document attached by the office",
  archived: "Archived",
  restored: "Restored",
  retried: "Re-read requested",
  attempt_failed: "Read attempt failed",
  failed: "Reading failed",
  auto_confirm_scheduled: "Clean — scheduled to book itself",
  auto_confirm_eligible: "Clean — would book itself (automatic booking is off)",
  auto_confirm_ineligible: "Needs a person (automatic checks failed)",
  auto_confirmed: "Booked automatically",
  auto_confirm_skipped: "Automatic booking skipped",
  held: "Held for a person",
  supplier_pref_changed: "Supplier review preference changed",
};

export function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event.replace(/_/g, " ");
}
