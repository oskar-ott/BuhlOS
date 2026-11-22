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
