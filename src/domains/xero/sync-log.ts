import { z } from "zod";

/**
 * Xero sync-log contract (#251, M5 #890) — the TS mirror of the recorder
 * (`api/_lib/xero-sync-log.js`) plus the pure selectors the dashboard and
 * badge counts will consume.
 *
 * MIRROR LAW: the CJS recorder owns the runtime; the closed lists below
 * (sync types, statuses, error taxonomy) are hand-mirrors — change them
 * TOGETHER; `sync-log.test.ts` pins the lists 1:1 against the CJS exports.
 *
 * Two stores (issue #251 audit ruling):
 *   - `xero/sync-open.json` — the bounded working set of UNRESOLVED
 *     failures/skips, upserted by operation id, **never FIFO-trimmed**,
 *     plus per-type last-success stamps.
 *   - `xero/sync-log/<yyyy-mm>.json` — append-only history of TERMINAL
 *     outcomes only (ok / resolved / resolved_meanwhile / acknowledged),
 *     capped + trimmed like the audit log. Open items are not in history,
 *     so trimming can never lose an unresolved finance failure.
 */

/** Closed set — the recorder REJECTS anything else (a typo'd type must not
 *  create an invisible category). Additive: new sync children extend BOTH
 *  lists (here + CJS) in one PR. */
export const XERO_SYNC_TYPES = [
  "reference_sync",
  "timesheet_export",
  "reconciliation",
] as const;
export type XeroSyncType = (typeof XERO_SYNC_TYPES)[number];

/** An unresolved item's status (the open working set). */
export const OPEN_STATUSES = ["failed", "skipped"] as const;
export type OpenStatus = (typeof OPEN_STATUSES)[number];

/** Terminal outcomes (history rows). `ok` = the exchange succeeded first
 *  time; `resolved` = a retry landed it; `resolved_meanwhile` = the retry
 *  found the underlying record already fixed (e.g. a full re-push);
 *  `acknowledged` = a human closed it with a required note. */
export const TERMINAL_OUTCOMES = ["ok", "resolved", "resolved_meanwhile", "acknowledged"] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

export const OpenItemSchema = z.object({
  /** Stable per-exchange operation id — the upsert key (idempotent append). */
  operation: z.string(),
  syncType: z.enum(XERO_SYNC_TYPES),
  status: z.enum(OPEN_STATUSES),
  /** Business reference (batch id, worker id, reference kind…). */
  recordRef: z.string(),
  reason: z.string().default(""),
  category: z.string().optional(),
  /** Raw Xero error, credential-scrubbed at the recorder chokepoint. */
  xeroError: z.unknown().optional(),
  firstSeenAt: z.coerce.string(),
  lastSeenAt: z.coerce.string(),
  /** How many times this operation has reported the failure (re-record bumps). */
  seenCount: z.number().int().min(1).default(1),
});
export type OpenItem = z.infer<typeof OpenItemSchema>;

export const OpenStoreSchema = z.object({
  items: z.array(OpenItemSchema).default([]),
  /** Per-type last successful exchange (the dashboard's freshness strip). */
  lastSuccessAt: z.record(z.string(), z.string()).default({}),
});
export type OpenStore = z.infer<typeof OpenStoreSchema>;

export const HistoryEntrySchema = z.object({
  id: z.string(),
  ts: z.coerce.string(),
  syncType: z.enum(XERO_SYNC_TYPES),
  operation: z.string(),
  recordRef: z.string(),
  outcome: z.enum(TERMINAL_OUTCOMES),
  reason: z.string().default(""),
  category: z.string().optional(),
  acknowledgedBy: z.string().optional(),
  acknowledgedNote: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

// ── Selectors (pure — the dashboard + badges consume these) ─────────────

export function openCounts(items: ReadonlyArray<Pick<OpenItem, "syncType">>): {
  total: number;
  byType: Record<XeroSyncType, number>;
} {
  const byType = Object.fromEntries(XERO_SYNC_TYPES.map((t) => [t, 0])) as Record<
    XeroSyncType,
    number
  >;
  for (const i of items) byType[i.syncType] += 1;
  return { total: items.length, byType };
}

export function opensByType(
  items: ReadonlyArray<OpenItem>,
  type: XeroSyncType,
): OpenItem[] {
  return items.filter((i) => i.syncType === type);
}

/**
 * The dashboard's headline discrimination (#251 audit AC): green must mean
 * "connected AND nothing failed" — never just "nothing recorded".
 */
export type SyncHeadlineState = "never_connected" | "disconnected" | "all_clear" | "attention";

export function headlineState(input: {
  /** Xero connection state from the #247 foundation. */
  connection: "never" | "disconnected" | "connected";
  openTotal: number;
}): SyncHeadlineState {
  if (input.connection === "never") return "never_connected";
  if (input.connection === "disconnected") return "disconnected";
  return input.openTotal > 0 ? "attention" : "all_clear";
}

// ── Operator-facing error taxonomy (#251, consolidated 2026-07-12) ──────

export interface XeroErrorCategoryMeta {
  /** What the office reads on the dashboard row. Site language, no jargon. */
  readonly operatorMessage: string;
  /** What support/devs need to know to act. */
  readonly developerDetail: string;
  /** Whether the shared retry path can sensibly re-attempt. */
  readonly retryable: boolean;
  /** The human action that actually clears it. */
  readonly requiredAction: string;
  readonly auditSeverity: "info" | "warning" | "critical";
}

export const XERO_ERROR_TAXONOMY = {
  authentication: {
    operatorMessage: "Xero connection has expired — reconnect to continue.",
    developerDetail: "401 from Xero; access token invalid and refresh failed.",
    retryable: false,
    requiredAction: "Reconnect Xero from Settings.",
    auditSeverity: "critical",
  },
  authorization: {
    operatorMessage: "Xero refused this action for the connected user.",
    developerDetail: "403; the connection's grant lacks a required scope or org role.",
    retryable: false,
    requiredAction: "Reconnect Xero so the missing permission is granted.",
    auditSeverity: "critical",
  },
  tenant_mismatch: {
    operatorMessage: "Connected to a different Xero organisation than expected.",
    developerDetail: "xero-tenant-id on the connection no longer matches the org the mappings were made against.",
    retryable: false,
    requiredAction: "Reconnect and pick the right organisation, then re-check mappings.",
    auditSeverity: "critical",
  },
  token_refresh: {
    operatorMessage: "Couldn't refresh the Xero connection — will need a reconnect if it persists.",
    developerDetail: "Refresh-token exchange failed (revoked, rotated elsewhere, or Xero identity outage).",
    retryable: true,
    requiredAction: "Retry; reconnect if it keeps failing.",
    auditSeverity: "warning",
  },
  rate_limit: {
    operatorMessage: "Xero is rate-limiting us — try again shortly.",
    developerDetail: "429 with Retry-After; the shared client's budget was exhausted.",
    retryable: true,
    requiredAction: "Wait for the limit window, then retry.",
    auditSeverity: "info",
  },
  network_timeout: {
    operatorMessage: "Couldn't reach Xero — network problem or Xero outage.",
    developerDetail: "Request timed out or connection failed before a response.",
    retryable: true,
    requiredAction: "Retry once the connection is back.",
    auditSeverity: "warning",
  },
  xero_validation: {
    operatorMessage: "Xero rejected the record as invalid.",
    developerDetail: "400 ValidationException; element-level errors preserved in xeroError.",
    retryable: false,
    requiredAction: "Fix the named field in BuhlOS or Xero, then retry.",
    auditSeverity: "warning",
  },
  employee_inactive: {
    operatorMessage: "This worker's Xero employee record is inactive.",
    developerDetail: "Payroll employee archived/terminated in Xero; timesheet lines refused.",
    retryable: false,
    requiredAction: "Reactivate the employee in Xero or fix the worker mapping.",
    auditSeverity: "warning",
  },
  payroll_calendar_mismatch: {
    operatorMessage: "The pay period doesn't line up with this worker's Xero pay calendar.",
    developerDetail: "Batch period start/end doesn't match the employee's payroll-calendar period.",
    retryable: false,
    requiredAction: "Align the batch period or the employee's calendar, then retry.",
    auditSeverity: "warning",
  },
  earnings_rate_inactive: {
    operatorMessage: "A mapped earnings rate no longer exists or is inactive in Xero.",
    developerDetail: "EarningsRateID rejected; the work-type mapping points at a dead rate.",
    retryable: false,
    requiredAction: "Re-map the work type to a live earnings rate.",
    auditSeverity: "warning",
  },
  period_locked: {
    operatorMessage: "That pay period is locked in Xero.",
    developerDetail: "Payroll period closed/locked; draft timesheets refused.",
    retryable: false,
    requiredAction: "Unlock the period in Xero or move the batch to an open period.",
    auditSeverity: "warning",
  },
  duplicate_idempotency: {
    operatorMessage: "Xero already has this record — nothing was sent twice.",
    developerDetail: "Idempotency guard matched an existing TimesheetID/hash; treated as already-landed.",
    retryable: true,
    requiredAction: "Reconcile to confirm the existing record, no re-send needed.",
    auditSeverity: "info",
  },
  local_persistence: {
    operatorMessage: "Xero accepted it but saving the result here failed.",
    developerDetail: "Local store write failed AFTER the remote call — reconcile before any retry.",
    retryable: false,
    requiredAction: "Run reconcile; contact support if the mismatch persists.",
    auditSeverity: "critical",
  },
  unknown_remote: {
    operatorMessage: "Xero gave an unexpected answer — the record's state is unknown.",
    developerDetail: "Non-2xx without a recognised shape, or 2xx that failed readback.",
    retryable: false,
    requiredAction: "Reconcile first; never blind-retry an unknown state.",
    auditSeverity: "critical",
  },
  reconciliation_drift: {
    operatorMessage: "What's in Xero no longer matches what was sent.",
    developerDetail: "Readback differs from the commit-time snapshot (changed/deleted after export).",
    retryable: false,
    requiredAction: "Review the drift; resolve in Xero or raise a correction batch.",
    auditSeverity: "warning",
  },
} as const satisfies Record<string, XeroErrorCategoryMeta>;

export type XeroErrorCategory = keyof typeof XERO_ERROR_TAXONOMY;
export const XERO_ERROR_CATEGORIES = Object.keys(XERO_ERROR_TAXONOMY) as XeroErrorCategory[];

export function taxonomyFor(category: string): XeroErrorCategoryMeta | null {
  return (XERO_ERROR_TAXONOMY as Record<string, XeroErrorCategoryMeta>)[category] ?? null;
}
