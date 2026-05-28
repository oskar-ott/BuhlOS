import type {
  Employee,
  EmployeeFilterKey,
  EmployeeRole,
  EmployeeRow,
  InvitePublic,
  StatusMarker,
} from "./types";
import { deriveAppAccess } from "./roles";

/**
 * Pure helpers for the employee-onboarding domain. No I/O, no React, no
 * globals — everything here is unit-testable in isolation, and the same
 * functions run on the server (api/employees.js mirrors the security-critical
 * ones in CommonJS) and in the browser.
 *
 * Bible: "BuhlOS Phil Onboarding Interface Bible.html" §08 (state), §10
 * (security), §12 (copy). Re-exports the role helpers so callers have one
 * import surface for the domain's logic.
 */

export { deriveAppAccess, appAccessFooter, displayRoleLabel, ROLE_DEFS, ROLE_ORDER, isEmployeeRole } from "./roles";

/** Invite validity default (Open Decision Q2 — 14 days). */
export const INVITE_EXPIRY_DEFAULT_DAYS = 14;

/** Token size mandated by bible §10 S01 — 32 bytes, URL-safe. */
export const INVITE_TOKEN_BYTES = 32;

/** Resend rate limit (bible A8 / §10): max 3 resends per hour per employee. */
export const RESEND_MAX_PER_WINDOW = 3;
export const RESEND_WINDOW_MS = 60 * 60 * 1000;

/* ---------------------------------------------------------------------------
 * Display
 * ------------------------------------------------------------------------- */

/** Full name, honouring an explicit displayName/nickname override. */
export function displayNameFor(
  e: Pick<Employee, "firstName" | "lastName" | "displayName">
): string {
  const override = (e.displayName ?? "").trim();
  if (override) return override;
  return `${e.firstName} ${e.lastName}`.trim();
}

/** Two-letter avatar initials. */
export function initialsFor(
  e: Pick<Employee, "firstName" | "lastName" | "displayName">
): string {
  const name = displayNameFor(e);
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/* ---------------------------------------------------------------------------
 * Status marker composition (bible §08 — EmployeeStatusChip)
 *
 * One chip renders the combined employee + invite state. Composition rule from
 * the bible: setup_complete + active = "active". Internal states are mapped
 * onto the fixed visible vocabulary here, never invented at the call site.
 * ------------------------------------------------------------------------- */

export function employeeStatusMarker(
  employee: Pick<Employee, "status">,
  invite?: Pick<InvitePublic, "status"> | null
): StatusMarker {
  if (employee.status === "disabled") {
    return { key: "disabled", label: "Disabled", tone: "neutral" };
  }
  if (employee.status === "active") {
    return { key: "active", label: "Active", tone: "success" };
  }
  // Draft / invited employee — the invite carries the fine-grained state.
  if (!invite) {
    return { key: "draft", label: "Draft", tone: "neutral" };
  }
  switch (invite.status) {
    case "sent":
      return { key: "invited", label: "Invited", tone: "warning" };
    case "opened":
      return { key: "opened", label: "Opened", tone: "info" };
    case "accepted":
      return { key: "active", label: "Active", tone: "success" };
    case "expired":
      return { key: "expired", label: "Expired", tone: "danger" };
    case "revoked":
      return { key: "revoked", label: "Revoked", tone: "neutral" };
    case "failed":
      return { key: "failed", label: "Failed", tone: "danger" };
    case "draft":
    default:
      return { key: "draft", label: "Draft", tone: "neutral" };
  }
}

/* ---------------------------------------------------------------------------
 * Register filtering + search (bible A1)
 * ------------------------------------------------------------------------- */

/** Does a row belong in the given filter bucket? */
export function matchesFilter(row: EmployeeRow, filter: EmployeeFilterKey): boolean {
  const marker = employeeStatusMarker(row.employee, row.invite ?? null);
  switch (filter) {
    case "all":
      return true;
    case "active":
      return marker.key === "active";
    case "invited":
      return marker.key === "invited";
    case "incomplete":
      // "Setup incomplete" — engaged or stuck, but not finished.
      return marker.key === "opened" || marker.key === "expired" || marker.key === "failed";
    case "field":
      return row.employee.appAccess === "phil";
    case "admin":
      return row.employee.appAccess === "buhlos" || row.employee.appAccess === "both";
    case "disabled":
      return marker.key === "disabled";
  }
}

/** Case-insensitive search over name + email. */
export function matchesSearch(row: EmployeeRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const e = row.employee;
  const haystack = [displayNameFor(e), e.firstName, e.lastName, e.email]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function filterEmployees(
  rows: ReadonlyArray<EmployeeRow>,
  filter: EmployeeFilterKey,
  query: string
): EmployeeRow[] {
  return rows.filter((r) => matchesFilter(r, filter) && matchesSearch(r, query));
}

/** Count rows per filter for the filter-bar badges. */
export function filterCounts(
  rows: ReadonlyArray<EmployeeRow>
): Record<EmployeeFilterKey, number> {
  const keys: EmployeeFilterKey[] = [
    "all",
    "active",
    "invited",
    "incomplete",
    "field",
    "admin",
    "disabled",
  ];
  const out = {} as Record<EmployeeFilterKey, number>;
  for (const key of keys) out[key] = rows.filter((r) => matchesFilter(r, key)).length;
  return out;
}

/* ---------------------------------------------------------------------------
 * Validation (shared client + server)
 * ------------------------------------------------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(String(email).trim());
}

/**
 * Find an existing employee that already owns `email` (case-insensitive),
 * optionally ignoring one id (for edits). Drives the bible's duplicate-email
 * block-with-link behaviour (A2 / §11).
 */
export function findDuplicateEmail(
  employees: ReadonlyArray<Pick<Employee, "id" | "email">>,
  email: string,
  exceptId?: string
): Employee["id"] | null {
  const target = String(email).trim().toLowerCase();
  if (!target) return null;
  const hit = employees.find(
    (e) => e.email.trim().toLowerCase() === target && e.id !== exceptId
  );
  return hit ? hit.id : null;
}

/**
 * Normalise an AU mobile to E.164 (+61…). Returns the canonical form or null
 * if it isn't a valid AU mobile. Phone is optional everywhere (Q8), so callers
 * only validate when a value is present.
 *
 * Accepts: 0421558902 · 0421 558 902 · +61421558902 · +61 421 558 902 ·
 * 61421558902. AU mobiles are 04xx xxx xxx → +61 4xx xxx xxx.
 */
export function normaliseAuMobile(raw: string): string | null {
  const digits = String(raw).replace(/[\s()\-.]/g, "");
  let national: string | null = null;
  if (/^\+61\d{9}$/.test(digits)) national = "0" + digits.slice(3);
  else if (/^61\d{9}$/.test(digits)) national = "0" + digits.slice(2);
  else if (/^0\d{9}$/.test(digits)) national = digits;
  else return null;
  // National form must be a mobile: 04xxxxxxxx.
  if (!/^04\d{8}$/.test(national)) return null;
  return "+61" + national.slice(1);
}

export function isValidAuMobile(raw: string): boolean {
  return normaliseAuMobile(raw) !== null;
}

/* ---------------------------------------------------------------------------
 * PIN rules (bible §06 P5 + §10 S09). Defined in O1 so the rules are tested
 * and shared; the PIN is created in O3 (the worker setup flow).
 * ------------------------------------------------------------------------- */

// Trivially-guessable PINs blocked outright (bible §06 P5). Repeated-digit and
// sequential patterns are caught structurally below; this set covers the
// well-known "easy" PINs that aren't pure sequences (keypad columns, doubles,
// 6969). Mirrored in api/invites.js#isCommonPin — keep both in sync.
const EXPLICIT_BLOCKED_PINS = new Set([
  "0000", "1111", "1234", "4321", "1212", "6969", "2580", "0852",
]);

/** True for trivially guessable PINs the bible forbids. */
export function isCommonPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return false;
  if (EXPLICIT_BLOCKED_PINS.has(pin)) return true;
  // All four digits the same (1111, 7777…).
  if (/^(\d)\1{3}$/.test(pin)) return true;
  const d = pin.split("").map((c) => Number(c));
  // Strictly ascending or descending run of 1 (1234, 4567, 9876…).
  const asc = d.every((n, i) => i === 0 || n === d[i - 1]! + 1);
  const desc = d.every((n, i) => i === 0 || n === d[i - 1]! - 1);
  // Repeated 2-digit pair (1212, 3434…).
  const pair = pin[0] === pin[2] && pin[1] === pin[3];
  return asc || desc || pair;
}

export type PinValidation = { ok: true } | { ok: false; reason: string };

export function validatePin(pin: string): PinValidation {
  if (!/^\d{4}$/.test(pin)) return { ok: false, reason: "PIN must be 4 digits" };
  if (isCommonPin(pin)) return { ok: false, reason: "Pick something less easy to guess" };
  return { ok: true };
}

/** P5 confirm step — calm, inline "These don't match" (bible P11). */
export function pinsMatch(pin: string, confirm: string): boolean {
  return pin === confirm;
}

/* ---------------------------------------------------------------------------
 * Token format (bible §10 S01). The token itself is generated server-side
 * (crypto.randomBytes) — this validates the *shape* for tests and for the
 * /phil/invite/[token] route guard (O3).
 * ------------------------------------------------------------------------- */

const URL_SAFE_RE = /^[A-Za-z0-9_-]+$/;

/**
 * A 32-byte value base64url-encodes to 43 chars (no padding). We accept ≥43 so
 * a longer token still passes, and reject anything with non-URL-safe chars.
 */
export function isUrlSafeToken(token: string, minBytes = INVITE_TOKEN_BYTES): boolean {
  if (typeof token !== "string") return false;
  const minLen = Math.ceil((minBytes * 4) / 3); // base64 length for N bytes
  return token.length >= minLen && URL_SAFE_RE.test(token);
}

/* ---------------------------------------------------------------------------
 * Invite expiry (bible §10 S04)
 * ------------------------------------------------------------------------- */

export function computeExpiresAt(fromIso: string, days: number): string {
  const base = new Date(fromIso);
  base.setDate(base.getDate() + days);
  return base.toISOString();
}

/** Server-side hard-expiry check (client display is informational, S04). */
export function isInviteExpired(
  invite: Pick<InvitePublic, "expiresAt" | "status">,
  nowMs: number = Date.now()
): boolean {
  if (invite.status === "accepted" || invite.status === "revoked") return false;
  const exp = Date.parse(invite.expiresAt);
  return Number.isFinite(exp) && exp < nowMs;
}

/**
 * Lazy expiry (bible A8: "Status flips at midnight after expiry"). Returns the
 * effective invite status for display/decisions — flips a stale `sent`/`opened`
 * invite to `expired` without a cron. Pure: callers persist the flip on
 * mutations; GET applies it in-memory for display only.
 */
export function effectiveInviteStatus(
  invite: Pick<InvitePublic, "expiresAt" | "status">,
  nowMs: number = Date.now()
): InvitePublic["status"] {
  if ((invite.status === "sent" || invite.status === "opened") && isInviteExpired(invite, nowMs)) {
    return "expired";
  }
  return invite.status;
}

/**
 * How many resends happened inside the rate-limit window ending at `nowMs`
 * (bible A8 / §10). Mirrored in api/employees.js — keep both in sync.
 */
export function recentResendCount(
  timestamps: ReadonlyArray<string> | undefined,
  nowMs: number = Date.now()
): number {
  if (!timestamps) return 0;
  const cutoff = nowMs - RESEND_WINDOW_MS;
  return timestamps.filter((t) => {
    const ms = Date.parse(t);
    return Number.isFinite(ms) && ms > cutoff;
  }).length;
}

/** Whether another resend is allowed right now (≤ RESEND_MAX_PER_WINDOW per hour). */
export function canResendNow(
  timestamps: ReadonlyArray<string> | undefined,
  nowMs: number = Date.now()
): boolean {
  return recentResendCount(timestamps, nowMs) < RESEND_MAX_PER_WINDOW;
}

/**
 * Map a matched invite (+ its employee) to the worker-facing landing state
 * (bible P1 / P8–P10). Pure — the bcrypt token match + I/O live in
 * api/invites.js, which mirrors this. A `failed` invite (email send failed)
 * still has a live token, so it resolves as `valid` — the copy-link works.
 * A disabled employee resolves as `invalid` (P13: "account isn't active").
 */
export function resolveInviteState(
  invite: Pick<InvitePublic, "status" | "expiresAt"> | null | undefined,
  employee?: { status: string } | null,
  nowMs: number = Date.now()
): "valid" | "expired" | "revoked" | "accepted" | "invalid" {
  if (!invite) return "invalid";
  if (employee && employee.status === "disabled") return "invalid";
  switch (effectiveInviteStatus(invite, nowMs)) {
    case "accepted":
      return "accepted";
    case "revoked":
      return "revoked";
    case "expired":
      return "expired";
    case "sent":
    case "opened":
    case "failed":
      return "valid";
    default:
      return "invalid";
  }
}

/* ---------------------------------------------------------------------------
 * Derivation used by the create path (kept pure for testing)
 * ------------------------------------------------------------------------- */

/** Build the derived employee fields from create input. */
export function deriveEmployeeFields(input: {
  role: EmployeeRole;
  firstName: string;
  lastName: string;
  displayName?: string | null;
}): { appAccess: ReturnType<typeof deriveAppAccess>; displayName: string } {
  return {
    appAccess: deriveAppAccess(input.role),
    displayName: displayNameFor(input),
  };
}
