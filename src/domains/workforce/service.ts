import type { Credential, CredentialStatus } from "./types";

/**
 * Presentation helpers for licence records (#331). Status itself is computed
 * SERVER-side (api/_lib/licence-compliance.js) — these only translate the
 * server's verdict into chips and sentences, so the maths can't fork.
 */

export function credentialToneFor(
  status: CredentialStatus
): "success" | "warning" | "danger" | "neutral" {
  if (status === "expired") return "danger";
  if (status === "expiring") return "warning";
  if (status === "current") return "success";
  return "neutral";
}

export function credentialStatusLabel(status: CredentialStatus): string {
  if (status === "expired") return "Expired";
  if (status === "expiring") return "Expiring";
  if (status === "current") return "Current";
  return "No expiry";
}

/** "expires 12 Jul 2026 · 18 days" / "expired 3 days ago" / "no expiry date". */
export function expiryLabel(credential: Pick<Credential, "expiryDate" | "daysToExpiry">): string {
  if (!credential.expiryDate || credential.daysToExpiry === null) return "no expiry date";
  const date = formatDay(credential.expiryDate);
  const d = credential.daysToExpiry;
  if (d < 0) return `expired ${Math.abs(d)} ${Math.abs(d) === 1 ? "day" : "days"} ago (${date})`;
  if (d === 0) return `expires today (${date})`;
  return `expires ${date} · ${d} ${d === 1 ? "day" : "days"}`;
}

function formatDay(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

/** Sort for lists: expired first, then soonest expiry, then no-expiry, by label. */
export function sortCredentials(credentials: ReadonlyArray<Credential>): Credential[] {
  return [...credentials].sort((a, b) => {
    const ad = a.daysToExpiry ?? Number.POSITIVE_INFINITY;
    const bd = b.daysToExpiry ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return a.label.localeCompare(b.label);
  });
}
