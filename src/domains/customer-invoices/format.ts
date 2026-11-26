import type { StageDisplayStatus, XeroReadinessState } from "./schema";

/**
 * Pure formatting + input parsing for customer stage invoices. Integer cents
 * and basis points in and out; nothing here does float money maths beyond the
 * one rounding at the typing boundary.
 */

const MAX_CENTS = 100_000_000_00;

/** "$12,345.60" — always two decimals: an invoice amount is exact. */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-AU");
  const rem = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${rem}`;
}

/** 500 → "5%", 1250 → "12.5%", 333 → "3.33%". */
export function formatBp(bp: number | null | undefined): string {
  if (bp == null || !Number.isFinite(bp)) return "—";
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(2))}%`;
}

/**
 * A typed dollar amount → integer cents, or null when it is not a usable
 * positive amount. Accepts "12000", "12,000.50", "$1,200". No negatives, no
 * more than two decimals — a typo is refused, never rounded into shape.
 */
export function parseDollarsToCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_CENTS) return null;
  return cents;
}

/**
 * A typed percentage → basis points, or null. "20" → 2000, "12.5" → 1250,
 * "5%" → 500. Up to two decimals; `allowZero` is for retention (0 = none).
 */
export function parsePercentToBp(input: string, { allowZero = false } = {}): number | null {
  const s = input.trim().replace(/%$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const bp = Number(whole) * 100 + Number(frac.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(bp) || bp > 10000) return null;
  if (bp === 0 && !allowZero) return null;
  return bp;
}

/** Cents → the plain string an amount input is pre-filled with ("12000.5" → "12000.50"). */
export function centsToInput(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  const abs = Math.abs(Math.trunc(cents));
  const rem = abs % 100;
  return rem === 0 ? String(abs / 100) : `${Math.floor(abs / 100)}.${String(rem).padStart(2, "0")}`;
}

/** Basis points → the plain string a % input is pre-filled with. */
export function bpToInput(bp: number | null | undefined): string {
  if (bp == null || !Number.isFinite(bp)) return "";
  const pct = bp / 100;
  return String(Number.isInteger(pct) ? pct : Number(pct.toFixed(2)));
}

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const STATUS_LABEL: Record<StageDisplayStatus, string> = {
  planned: "Planned",
  sending: "Sending",
  failed: "Couldn't send",
  cancelled: "Cancelled",
  draft_in_xero: "Draft in Xero",
  awaiting_payment: "Awaiting payment",
  part_paid: "Part paid",
  paid: "Paid",
  overdue: "Overdue",
  voided: "Voided",
  deleted_in_xero: "Deleted in Xero",
  sent_unchecked: "Sent, not yet checked",
};

export const STATUS_TONE: Record<StageDisplayStatus, Tone> = {
  planned: "neutral",
  sending: "info",
  failed: "danger",
  cancelled: "neutral",
  draft_in_xero: "info",
  awaiting_payment: "info",
  part_paid: "warning",
  paid: "success",
  overdue: "danger",
  voided: "neutral",
  deleted_in_xero: "neutral",
  sent_unchecked: "warning",
};

/** "2026-12-01" → "1 Dec 2026" (no timezone maths: it is a calendar date). */
export function formatDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[m - 1];
  if (!month) return "";
  return `${d} ${month} ${y}`;
}

export const XERO_SETTINGS_PATH = "/settings/integrations/xero";

/**
 * What to tell the office when Xero can't be used for invoices yet, and the
 * one thing that fixes it. `null` = Xero is usable.
 */
export function xeroBlocker(
  state: XeroReadinessState
): { message: string; action: string } | null {
  switch (state) {
    case "connected":
      return null;
    case "missing_permission":
      return {
        message: "Xero is connected, but without permission for invoices.",
        action: "Reconnect Xero to allow invoices",
      };
    case "reconnect_required":
      return { message: "The Xero connection has expired.", action: "Reconnect Xero" };
    case "connecting":
      return {
        message: "Xero is connected, but no organisation has been chosen yet.",
        action: "Finish connecting Xero",
      };
    case "disconnected":
      return { message: "Xero isn't connected.", action: "Connect Xero" };
    case "not_configured":
      return { message: "Xero isn't set up for this site yet.", action: "Open Xero settings" };
    case "unavailable":
      return {
        message: "Couldn't check the Xero connection just now.",
        action: "Open Xero settings",
      };
  }
}

// ── sending (#1150) ─────────────────────────────────────────────────────────

/** Why a stage can't be sent yet, in plain words, with what fixes it. */
export function blockerMessage(code: string): string {
  switch (code) {
    case "not_planned":
      return "This stage has already been sent.";
    case "xero_not_ready":
      return "Xero isn't ready for invoices. Check the Xero connection in Settings.";
    case "settings_incomplete":
      return "The sales account, GST rate and payment terms aren't chosen yet. Choose them in the Xero settings.";
    case "no_client_link":
      return "This job's client isn't linked to a Xero contact. Link the client first.";
    case "client_other_organisation":
      return "The client was linked in a different Xero organisation. Link the client again.";
    case "no_client_chosen":
      return "No client is chosen for this invoice. Edit it and choose the client.";
    case "client_chosen_other_organisation":
      return "The client was chosen in a different Xero organisation. Edit the invoice and choose the client again.";
    case "no_job_code":
      return "This job has no IV number, so the invoice can't be numbered.";
    case "no_contract_value":
      return "This stage is a percentage of the contract, and the job has no contract value yet. Set it on the Money card.";
    case "no_lines":
      return "This invoice has no lines with a price yet. Edit it and add one.";
    case "amount_invalid":
      return "The stage's amount can't be worked out. Edit the stage and check the figures.";
    case "nothing_to_invoice":
      return "After retention there is nothing left to invoice on this stage.";
    case "not_awaiting_xero":
      return "This stage isn't waiting on Xero any more. The list has been refreshed.";
    case "other_organisation":
      return "This stage was sent while a different Xero organisation was connected. Reconnect to that organisation to check on it.";
    default:
      return "This stage can't be sent yet.";
  }
}

/**
 * What to tell the office about a stage that didn't land. Xero's own
 * sentence, when it gave one, is the most useful thing to show.
 */
export function failureMessage(category: string | null | undefined, detail: string | null | undefined): string {
  if (category === "number_taken") {
    return detail
      ? `${detail}. Use the next number instead.`
      : "Xero already has an invoice with this number. Use the next number instead.";
  }
  if (category === "validation") {
    return detail ? `Xero refused it: ${detail}` : "Xero refused this invoice as invalid.";
  }
  if (category === "rate_limit") return "Xero was too busy to take it. Nothing was created — try again in a minute.";
  if (category === "reconnect_required" || category === "auth" || category === "forbidden") {
    return "Xero refused the request. Reconnect Xero, then try again. Nothing was created.";
  }
  if (category === "not_connected" || category === "pending_selection" || category === "not_configured") {
    return "Xero wasn't connected. Nothing was created.";
  }
  return detail ? `It didn't go through: ${detail}` : "It didn't go through. Nothing was created in Xero.";
}

/** The line shown while a stage is `sending` with no confirmed answer. */
export const UNKNOWN_SEND_MESSAGE =
  "BuhlOS didn't hear back from Xero, so this invoice may or may not be there. Check Xero before anything else — it won't be sent twice.";

/** One line for the result of a send / check / reset, for the card's banner. */
export function sendOutcomeMessage(r: {
  outcome: string;
  invoiceNumber: string | null;
  verified: boolean | null;
  category: string | null;
  detail: string | null;
}): { tone: "success" | "warning" | "danger"; text: string } {
  const n = r.invoiceNumber ?? "The invoice";
  switch (r.outcome) {
    case "sent":
      return r.verified
        ? { tone: "success", text: `${n} is in Xero as a draft. Approve and email it from Xero.` }
        : { tone: "warning", text: `${n} is in Xero as a draft, but it doesn't match what BuhlOS sent. Open it in Xero and check it.` };
    case "adopted":
      return { tone: "success", text: `${n} was already in Xero. BuhlOS has picked it up — nothing was sent twice.` };
    case "reset":
      return { tone: "success", text: "Xero has nothing under that number, so the stage is back to planned. Edit it and send again." };
    case "unknown":
      return { tone: "warning", text: UNKNOWN_SEND_MESSAGE };
    default:
      return { tone: "danger", text: failureMessage(r.category, r.detail) };
  }
}

/**
 * "12 minutes ago" for how fresh Xero's figures are. Coarse on purpose — the
 * point is whether it is minutes, hours or days old.
 */
export function agoLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "not checked yet";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "not checked yet";
  const mins = Math.max(0, Math.round((now.getTime() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** One line for what "Check Xero now" found. */
export function refreshMessage(r: { checked: number; changed: number; notFound: number }): {
  tone: "success" | "warning";
  text: string;
} {
  if (r.checked === 0) return { tone: "success", text: "Nothing has been sent to Xero for this job yet, so there was nothing to check." };
  const n = `${r.checked} ${r.checked === 1 ? "invoice" : "invoices"}`;
  if (r.notFound > 0) {
    return { tone: "warning", text: `Checked ${n}. Xero no longer has ${r.notFound === 1 ? "one of them" : `${r.notFound} of them`} — see below.` };
  }
  return r.changed === 0
    ? { tone: "success", text: `Checked ${n} with Xero. Nothing has changed.` }
    : { tone: "success", text: `Checked ${n} with Xero. ${r.changed} ${r.changed === 1 ? "has" : "have"} changed — the figures below are up to date.` };
}

/** Open an invoice in Xero's web app. (Xero then asks for a login if needed.) */
export function xeroInvoiceUrl(xeroInvoiceId: string): string {
  return `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(xeroInvoiceId)}`;
}

/** Today in the office's timezone, as YYYY-MM-DD (the send's default date). */
export function sydneyToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Plain words for the stable error codes the API answers with. */
export function errorMessage(code: string | null, status: number): string {
  switch (code) {
    case "stale_version":
      return "Someone else changed this while you were editing. It has been refreshed — check it and try again.";
    case "stage_not_editable":
      return "This stage has already been sent, so it can no longer be changed here.";
    case "stage_not_found":
      return "This stage no longer exists. The list has been refreshed.";
    case "job_not_found":
      return "This job no longer exists.";
    case "invalid_request":
      return "Something in the form isn't valid. Check the amounts and try again.";
    case "store_unavailable":
    case "store_unprovisioned":
      return "The invoice records can't be reached right now. Nothing was saved — try again shortly.";
    case "number_clash":
      return "Another stage on this job was being sent at the same moment. Nothing was sent for this one — try again.";
    case "not_resettable":
    case "not_raisable":
      return "This stage has moved on since the page loaded. The list has been refreshed.";
    case "exceeds_retention_held":
      return "That is more than the retention still held on this job.";
    // ── itemised invoices, hours and materials, variations (part 2) ──
    case "already_billed":
      return "Something on this invoice is already on another invoice, so it can't be billed again. Take it off and try again.";
    case "ref_not_found":
      return "Some of the hours or materials on this invoice are no longer on the job. Take those lines off and add them again.";
    case "line_invalid":
      return "One of the lines has a quantity or price that can't be used. Check the figures.";
    case "mixed_refs":
    case "ref_invalid":
    case "too_many_refs":
      return "One of the lines couldn't be read. Take it off and add it again.";
    case "kind_mismatch":
      return "That can't be done with this kind of invoice. The list has been refreshed.";
    case "no_job_itemised_only":
    case "no_job_typed_lines_only":
    case "no_job_no_retention":
    case "client_is_the_jobs":
      return "That can't be saved on this kind of invoice. Check the lines and try again.";
    case "too_many_lines":
      return "That stage already has as many extra lines as it can hold. Put the variation on its own invoice instead.";
    case "variation_not_found":
      return "That variation no longer exists. The list has been refreshed.";
    case "variation_not_approved":
      return "Only an approved variation can go on an invoice.";
    case "variation_billed":
      return "That variation is already on an invoice, so it can't be changed. Take it off the invoice first.";
    case "variation_decided":
      return "An approved variation can't be edited. Put it back to proposed first.";
    case "variation_amount":
      return "A variation is billed at exactly what was approved. Check the approved amount.";
    case "blocked":
      return "This stage can't be sent yet. Open Send to see what's missing.";
    case "contact_not_found":
      return "That contact no longer exists in Xero. Search again and pick another.";
    case "contact_not_active":
      return "That contact is archived in Xero. Restore it in Xero, or pick another.";
    case "account_not_in_xero":
      return "That sales account is no longer active in Xero. The list has been refreshed — pick again.";
    case "tax_rate_not_in_xero":
      return "That tax rate is no longer active in Xero. The list has been refreshed — pick again.";
    case "xero_reconnect_required":
      return "Xero needs to be reconnected before this will work. Nothing was changed.";
    case "xero_not_connected":
    case "xero_pending_selection":
    case "xero_not_configured":
      return "Xero isn't connected. Nothing was changed.";
    case "xero_rate_limit":
      return "Xero is busy right now. Wait a minute and try again.";
    case "xero_timeout":
    case "xero_network":
    case "xero_server":
      return "Couldn't reach Xero. Nothing was changed — try again shortly.";
    case "xero_forbidden":
    case "xero_auth":
      return "Xero refused the request. Reconnect Xero and try again.";
    default:
      return status > 0 ? `Couldn't save (error ${status}). Nothing was changed.` : "Couldn't reach BuhlOS. Nothing was changed.";
  }
}
