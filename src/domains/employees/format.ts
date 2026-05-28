import { format, isToday, isYesterday } from "date-fns";
import type { InvitePublic } from "./types";

/**
 * Display formatters for the employee-onboarding domain. Copy follows bible
 * §12 (plain words, no corporate phrasing) and the screen mocks in §05/§06.
 *
 * Dates are formatted in the org's locale shape ("11 Jun 2026", "26 May ·
 * 14:02"); the underlying values are always ISO timestamps from the store.
 */

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "11 Jun 2026" */
export function formatShortDate(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? format(d, "d MMM yyyy") : "—";
}

/** "26 May · 14:02" — used in the invite timeline. */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? format(d, "d MMM · HH:mm") : "—";
}

/** Chip text: "expires 11 Jun". */
export function formatExpiryChip(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? `expires ${format(d, "d MMM")}` : "no expiry";
}

/** Invite preview line: "14 days · 11 Jun 2026". */
export function inviteExpiryLine(expiresAt: string, days: number): string {
  return `${days} days · ${formatShortDate(expiresAt)}`;
}

/**
 * Register "last active" cell. Honest about the absence of a Phil heartbeat —
 * null reads as "never" rather than a faked value (bible §15: don't fake last
 * active if no heartbeat exists).
 */
export function lastActiveLabel(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "never";
  if (isToday(d)) return `today · ${format(d, "HH:mm")}`;
  if (isYesterday(d)) return "yesterday";
  return format(d, "d MMM");
}

/** Friendly text for a sanitised send-failure category (O2). */
export function sendErrorText(reason: string | null | undefined): string {
  switch (reason) {
    case "not_configured":
      return "no email provider is configured";
    case "provider_rejected":
      return "the email provider rejected it";
    case "provider_rate_limited":
      return "the email provider is rate-limiting";
    case "provider_error":
      return "the email provider had an error";
    case "network_error":
      return "couldn't reach the email provider";
    case "invalid_message":
      return "the message was invalid";
    default:
      return "the send failed";
  }
}

/** One-line summary for the invite status card (bible A8). */
export function inviteSummaryLine(invite: InvitePublic): string {
  switch (invite.status) {
    case "sent":
      if (invite.delivery === "link") {
        return `Link created ${formatDateTime(invite.sentAt)} · ${formatExpiryChip(
          invite.expiresAt
        )} · worker setup lands in O3`;
      }
      return `Sent ${formatDateTime(invite.sentAt)} to ${invite.email} · ${formatExpiryChip(
        invite.expiresAt
      )} · resent ${invite.resentCount ?? 0}×`;
    case "opened":
      return `Opened ${formatDateTime(invite.openedAt)} · setup not finished · ${formatExpiryChip(
        invite.expiresAt
      )}`;
    case "accepted":
      return `Joined ${formatDateTime(invite.acceptedAt)} · PIN set`;
    case "expired":
      return `Expired ${formatShortDate(invite.expiresAt)} · resent ${
        invite.resentCount ?? 0
      }× · worker never finished`;
    case "revoked":
      return `Revoked ${formatDateTime(invite.revokedAt)} · token dead`;
    case "failed":
      return `Email send failed — ${sendErrorText(invite.sendError)}. Copy the link or resend.`;
    case "draft":
    default:
      return `Draft · not sent yet`;
  }
}
