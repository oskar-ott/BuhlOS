import { z } from "zod";

/**
 * Pre-start readiness gate — pure engine (#371). "Can we actually start Monday?"
 * gets ONE honest answer computed from REAL signals only:
 *   No / With warnings / Yes — itemised, down to which worker is blocked, with an
 *   admin override-with-reason that is visibly flagged and NEVER rendered green.
 *
 * Signals in → state + items out. The caller resolves the signals from the real
 * stores (induction register #332, licences #331, safety docs #219, the crew from
 * users.assignedJobIds) and the one new per-job blob `jobs/<jobId>/prestart.json`
 * for the manual checklist; an absent register is passed as `null` and renders
 * "not tracked", never green (standing rule: missing data is named, not faked).
 *
 * This module is PURE and side-effect-free. The API route + admin panel + Phil
 * nudges that consume it are separate slices (the manual-checklist half can ship
 * first and absorb the register signals as they land).
 */

// ── The one new per-job blob: jobs/<jobId>/prestart.json ──────────────────────

export const PrestartManualItemSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    ticked: z.boolean().default(false),
    /** Named admin + timestamp — required to read as ticked honestly. */
    tickedBy: z.string().nullable().optional(),
    tickedAt: z.string().nullable().optional(),
  })
  .passthrough();
export type PrestartManualItem = z.infer<typeof PrestartManualItemSchema>;

export const PrestartOverrideSchema = z
  .object({
    reason: z.string().min(1),
    by: z.string().min(1),
    at: z.string().min(1),
  })
  .passthrough();
export type PrestartOverride = z.infer<typeof PrestartOverrideSchema>;

export const PrestartSchema = z
  .object({
    items: z.array(PrestartManualItemSchema).default([]),
    override: PrestartOverrideSchema.nullable().optional(),
  })
  .passthrough();
export type Prestart = z.infer<typeof PrestartSchema>;

/** The honest v1 default obligations — non-integrated (Sign-on-Site / AMPC /
 *  insurances have no integration anywhere), each ticked by a named admin. */
export const DEFAULT_PRESTART_ITEMS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "insurances", label: "Insurances lodged" },
  { id: "swms", label: "SWMS uploaded to the builder's system" },
  { id: "ampc_induction", label: "AMPC induction completed" },
  { id: "site_rules", label: "Site rules issued" },
];

/** Seed a fresh prestart from the defaults (used by the API on first read). */
export function defaultPrestartItems(): PrestartManualItem[] {
  return DEFAULT_PRESTART_ITEMS.map((d) => ({
    id: d.id,
    label: d.label,
    ticked: false,
    tickedBy: null,
    tickedAt: null,
  }));
}

// ── Signals (resolved by the caller; an absent register is null) ──────────────

export interface CrewMember {
  id: string;
  name: string;
}

/** A per-worker register signal: the ids of the crew that are CLEAR for it.
 *  Absent register → pass `null` (renders "not tracked"). */
export interface CrewRegisterSignal {
  /** worker id → true when that worker satisfies this register. */
  byWorkerId: Readonly<Record<string, boolean>>;
}

export interface ReadinessSignals {
  /** Assigned field/LH crew in scope (users.assignedJobIds). */
  crew: ReadonlyArray<CrewMember>;
  /** #332 induction register — null when absent. A real gap is a hard blocker. */
  inductions: CrewRegisterSignal | null;
  /** #331 licence currency — null when absent. Optional signal → soft warning. */
  licences: CrewRegisterSignal | null;
  /** #219 safety-doc acknowledgements — byWorkerId acked all CURRENT docs; satisfied when none. */
  safetyDocs: CrewRegisterSignal | null;
  /** Manual checklist (prestart.json items). An unticked obligation is a blocker. */
  manualItems: ReadonlyArray<PrestartManualItem>;
  /** Admin override-with-reason, or null. Never flips state to green. */
  override: PrestartOverride | null;
}

// ── Result ────────────────────────────────────────────────────────────────────

export type ReadinessItemStatus = "satisfied" | "missing" | "warning" | "not_tracked";
export interface ReadinessWorker {
  id: string;
  name: string;
  ok: boolean;
}
export interface ReadinessItem {
  key: string;
  label: string;
  status: ReadinessItemStatus;
  detail: string;
  /** Per-worker breakdown for register items (who is blocked). */
  workers?: ReadinessWorker[];
}
export type ReadinessState = "no" | "warnings" | "yes";
export interface ReadinessResult {
  /** The HONEST computed readiness — never altered by an override. */
  state: ReadinessState;
  /** Cleared to start: state is "yes" OR a valid override exists. */
  startApproved: boolean;
  /** An override forced start-approval despite state !== "yes" (flag it; never green). */
  overridden: boolean;
  override: PrestartOverride | null;
  items: ReadinessItem[];
  blockingCount: number;
  warningCount: number;
}

// ── Engine ──────────────────────────────────────────────────────────────────--

function registerItem(
  key: string,
  label: string,
  signal: CrewRegisterSignal | null,
  crew: ReadonlyArray<CrewMember>,
  gapStatus: "missing" | "warning"
): ReadinessItem {
  if (!signal) {
    return { key, label, status: "not_tracked", detail: `${label} — not tracked` };
  }
  if (crew.length === 0) {
    return { key, label, status: "not_tracked", detail: "No crew assigned yet" };
  }
  const workers: ReadinessWorker[] = crew.map((c) => ({
    id: c.id,
    name: c.name,
    ok: signal.byWorkerId[c.id] === true,
  }));
  const gaps = workers.filter((w) => !w.ok);
  if (gaps.length === 0) {
    return { key, label, status: "satisfied", detail: `All ${crew.length} clear`, workers };
  }
  return {
    key,
    label,
    status: gapStatus,
    detail: `${gaps.length} of ${crew.length} outstanding: ${gaps.map((w) => w.name).join(", ")}`,
    workers,
  };
}

function manualItem(item: PrestartManualItem): ReadinessItem {
  return {
    key: `manual:${item.id}`,
    label: item.label,
    status: item.ticked ? "satisfied" : "missing",
    detail: item.ticked
      ? `Ticked${item.tickedBy ? ` by ${item.tickedBy}` : ""}${item.tickedAt ? ` · ${item.tickedAt}` : ""}`
      : "Outstanding",
  };
}

/** Pure: signals → readiness state + itemised reasons. */
export function computeReadiness(signals: ReadinessSignals): ReadinessResult {
  const items: ReadinessItem[] = [
    registerItem("induction", "Site induction", signals.inductions, signals.crew, "missing"),
    registerItem(
      "safety_docs",
      "Safety docs acknowledged",
      signals.safetyDocs,
      signals.crew,
      "missing"
    ),
    registerItem("licences", "Licences current", signals.licences, signals.crew, "warning"),
    ...signals.manualItems.map(manualItem),
  ];

  const blockingCount = items.filter((i) => i.status === "missing").length;
  const warningCount = items.filter(
    (i) => i.status === "warning" || i.status === "not_tracked"
  ).length;
  const state: ReadinessState = blockingCount > 0 ? "no" : warningCount > 0 ? "warnings" : "yes";

  const override = signals.override && signals.override.reason ? signals.override : null;
  const overridden = Boolean(override) && state !== "yes";
  const startApproved = state === "yes" || overridden;

  return { state, startApproved, overridden, override, items, blockingCount, warningCount };
}

// ── Presentation helpers (pure) ───────────────────────────────────────────────

export function readinessStateLabel(state: ReadinessState): string {
  switch (state) {
    case "yes":
      return "Ready to start";
    case "warnings":
      return "Ready — with warnings";
    case "no":
      return "Not ready to start";
  }
}

export function readinessStateTone(state: ReadinessState): "success" | "warning" | "danger" {
  switch (state) {
    case "yes":
      return "success";
    case "warnings":
      return "warning";
    case "no":
      return "danger";
  }
}
