import { z } from "zod";
import type { StatusTone } from "@/components/ui/StatusChip";

/**
 * Owner Console (docs/owner-console.md) — the shared response shape between the
 * owner-gated data endpoint (api/owner.js) and the /owner page, plus the pure
 * presentation helpers the board renders from. The endpoint is the authority;
 * this module only PARSES + CLASSIFIES (no fetching, no business logic), so the
 * mapping from raw values to status tones is tested in isolation.
 *
 * Honesty (P7): every field is either real data from the endpoint or an
 * explicit "not instrumented" list. There are no defaults that invent a value.
 */

export const HealthCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["ok", "warning", "down", "misconfigured"]),
  detail: z.string(),
});

export const HealthSchema = z.object({
  overall: z.enum(["ok", "warning", "needs_attention"]),
  checks: z.array(HealthCheckSchema),
  notInstrumented: z.array(z.string()),
});

export const FlagItemSchema = z.object({
  key: z.string(),
  description: z.string(),
  default: z.boolean(),
  target: z.string(),
  expires: z.string(),
  // resolved = the customer baseline; resolvedForOwner = what the owner sees
  // live (env > owner-preview > baseline). ownerPreview is the raw override
  // (true/false set, null = unset).
  resolved: z.boolean(),
  resolvedForOwner: z.boolean(),
  ownerPreview: z.boolean().nullable(),
  source: z.enum(["env", "override", "default"]),
  ownerSource: z.enum(["env", "override", "default", "owner-preview"]),
  expiryStatus: z.enum(["ok", "expiring", "expired"]),
  protected: z.boolean(),
  toggleable: z.boolean(),
  // #760 Feature Control Board: human label / domain / surface (null for
  // protected/unlabelled flags). killSwitch = a LIVE feature (default-on) the
  // owner can turn off, vs a dark-by-default launch gate.
  label: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  surface: z.enum(["BuhlOS", "Phil", "Shared"]).nullable().optional(),
  killSwitch: z.boolean().optional(),
  // #760: a load-bearing spine feature (jobs/hours/evidence) — the board warns
  // before the owner turns it off.
  core: z.boolean().optional(),
});

export const FlagsSchema = z.object({
  source: z.string(),
  // The flags.json document revision — the CAS token the console echoes back on
  // a toggle (POST /api/owner-flags). Absent if the flag section degraded.
  rev: z.number().optional(),
  items: z.array(FlagItemSchema),
  error: z.string().optional(),
});

export const UsageSchema = z.object({
  source: z.string(),
  auditEvents7d: z.number(),
  distinctActors7d: z.number(),
  monthEntryCount: z.number(),
  monthCap: z.number(),
  topActions: z.array(z.object({ action: z.string(), count: z.number() })),
  notInstrumented: z.array(z.string()),
});

export const AuditEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  action: z.string(),
  actorName: z.string().nullable(),
  actorRole: z.string().nullable(),
  targetType: z.string().nullable(),
  summary: z.string(),
});

export const AuditSchema = z.object({
  source: z.string(),
  available: z.boolean(),
  entries: z.array(AuditEntrySchema),
});

export const CoverageRowSchema = z.object({
  area: z.string(),
  surface: z.string(),
  routeExists: z.boolean(),
  accessGuarded: z.boolean(),
  auditTracked: z.boolean(),
  usageTracked: z.boolean(),
  errorsTracked: z.boolean(),
});

export const CoverageSchema = z.object({
  note: z.string(),
  rows: z.array(CoverageRowSchema),
});

export const ProblemSchema = z.object({
  severity: z.enum(["blocker", "high", "medium", "low", "not_instrumented"]),
  title: z.string(),
  evidence: z.string(),
  why: z.string(),
  action: z.string(),
});

export const NextActionSchema = z.object({
  title: z.string(),
  reason: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  safeNow: z.boolean(),
  suggestedIssue: z.string(),
});

export const OwnerSummarySchema = z.object({
  ok: z.literal(true),
  meta: z.object({
    asOf: z.string(),
    environment: z.string(),
    identityBasis: z.enum(["owner-role", "email-allowlist"]),
    viewer: z.object({
      role: z.string().nullable(),
      name: z.string().nullable(),
      email: z.string().nullable(),
    }),
  }),
  capabilities: z.object({
    flagToggle: z.boolean(),
    flagToggleReason: z.string(),
  }),
  health: HealthSchema,
  flags: FlagsSchema,
  usage: UsageSchema,
  audit: AuditSchema,
  coverage: CoverageSchema,
  problems: z.array(ProblemSchema),
  nextActions: z.array(NextActionSchema),
});

export type OwnerSummary = z.infer<typeof OwnerSummarySchema>;
export type FlagItem = z.infer<typeof FlagItemSchema>;
export type ProblemItem = z.infer<typeof ProblemSchema>;
export type NextActionItem = z.infer<typeof NextActionSchema>;
export type CoverageRow = z.infer<typeof CoverageRowSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ── Pure classification helpers (tested in owner-console.test.ts) ──────────

export type Severity = ProblemItem["severity"];

const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  not_instrumented: 4,
};

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

/** Problems sorted most-urgent first; stable for equal severities. */
export function sortProblems(problems: ReadonlyArray<ProblemItem>): ProblemItem[] {
  return [...problems].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

export function severityTone(s: Severity): StatusTone {
  switch (s) {
    case "blocker":
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
      return "info";
    case "not_instrumented":
      return "neutral";
  }
}

export function severityLabel(s: Severity): string {
  return s === "not_instrumented" ? "Not instrumented" : s;
}

export function healthTone(overall: OwnerSummary["health"]["overall"]): StatusTone {
  switch (overall) {
    case "ok":
      return "success";
    case "warning":
      return "warning";
    case "needs_attention":
      return "danger";
  }
}

export function healthLabel(overall: OwnerSummary["health"]["overall"]): string {
  switch (overall) {
    case "ok":
      return "All clear";
    case "warning":
      return "Warning";
    case "needs_attention":
      return "Needs attention";
  }
}

export function checkTone(status: HealthCheck["status"]): StatusTone {
  switch (status) {
    case "ok":
      return "success";
    case "warning":
      return "warning";
    case "down":
    case "misconfigured":
      return "danger";
  }
}

export function expiryTone(status: FlagItem["expiryStatus"]): StatusTone {
  switch (status) {
    case "ok":
      return "neutral";
    case "expiring":
      return "warning";
    case "expired":
      return "danger";
  }
}

export function flagStateTone(resolved: boolean): StatusTone {
  return resolved ? "success" : "neutral";
}

export function flagSourceLabel(source: FlagItem["source"] | FlagItem["ownerSource"]): string {
  switch (source) {
    case "env":
      return "env override";
    case "override":
      return "blob override";
    case "default":
      return "registry default";
    case "owner-preview":
      return "owner preview";
  }
}

/** A coverage column rendered as a tri-state-ish boolean cell. */
export function coverageTone(value: boolean): StatusTone {
  return value ? "success" : "neutral";
}
