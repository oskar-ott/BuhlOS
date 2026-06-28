import type { ITPInstance, ITPTemplatePoint } from "./types";
import type { Job } from "@/domains/jobs/types";
import {
  evidenceCoverage,
  formatProgress,
  scopeContextLine,
  statusLabel,
  valuePassFail,
} from "./format";
import {
  applicabilityReason,
  isPointApplicable,
} from "./applicability";
import { resolveScopeName } from "@/components/phil/itp-scope";

/**
 * Compliance pack model (#286) — the PURE builder behind the printable
 * per-job ITP pack. Same data → same pack (the generation timestamp is the
 * caller's), so re-issued packs never invite "which version is real".
 *
 * Composable sections by design (cover / summary / per-instance): #374's
 * closeout matrix plans to PREPEND its handover checklist to this pack, and
 * #370's docket PDF is the same family — new sections slot in, no second
 * export pipeline.
 *
 * Honesty rules baked in:
 *   - pending / in-progress instances carry an IN PROGRESS watermark — the
 *     pack never renders something as complete that isn't;
 *   - witnessed-but-unsigned reads "awaiting sign-off" (distinct state);
 *   - a point with no result row renders "Not recorded", never blank;
 *   - archived instances are EXCLUDED and COUNTED — removal can't hide;
 *   - signedOffBy renders as stored (a username string) — never re-resolved,
 *     so later renames can't rewrite history.
 */

export interface PackPointRow {
  id: string;
  label: string;
  type: string;
  required: boolean;
  recorded: boolean;
  /** Display value ("42 MΩ", "Complete", note-only points → null). */
  valueLabel: string | null;
  passFail: "pass" | "fail" | null;
  note: string | null;
  photoUrl: string | null;
  byUsername: string | null;
  at: string | null;
  /** #293 — false when a conditional point doesn't apply to this
   *  instance's scope. The pack renders these as a DEFENSIBLE exclusion
   *  ("Not applicable: …"), never a silent gap. Same evaluation fn as
   *  Phil + admin (one source of truth). */
  applicable: boolean;
  /** Human reason, e.g. "Only applies to switchboard". Null when applicable. */
  notApplicableReason: string | null;
}

export interface PackInstanceSection {
  id: string;
  templateName: string;
  scopeLine: string;
  status: string;
  statusLabel: string;
  /** True for pending/in-progress — drives the watermark. */
  inProgress: boolean;
  /** True for witnessed (every required point recorded, not yet signed). */
  awaitingSignOff: boolean;
  progress: { done: number; total: number };
  evidenceCoverage: { required: number; photographed: number } | null;
  points: PackPointRow[];
  signOff: {
    signedOffBy: string;
    signedOffAt: string;
    overrideJustification: string | null;
  } | null;
  createdAt: string | null;
}

/**
 * #374 — one closeout obligation as it appears in the handover checklist
 * section. Statuses + linked refs only (no live re-derivation here; the caller
 * passes the already-derived matrix view). The pack renders the honest status,
 * never a fabricated "done".
 */
export interface HandoverChecklistRow {
  id: string;
  title: string;
  /** "Closed out" / "Waived" / "In progress" / "Outstanding". */
  statusLabel: string;
  /** True for satisfied OR waived (the discharged set). */
  discharged: boolean;
  /** The records cited as discharging it — `type:id`, only the ones that resolve. */
  linkedRefs: string[];
}

export interface HandoverChecklistSection {
  /** Discharged of total — the N of "N of M". */
  discharged: number;
  total: number;
  rows: HandoverChecklistRow[];
}

export interface CompliancePack {
  jobName: string;
  jobId: string;
  jobRef: string | null;
  /** Site address for the document letterhead; null when not captured. */
  siteAddress: string | null;
  generatedAt: string;
  /** Where override justifications were sourced + the window's honesty note. */
  overridesNote: string;
  /**
   * #374 — the closeout/handover checklist, PREPENDED to the pack when the
   * caller supplies the matrix. Composable: a new section, no second export
   * pipeline. `null` when no closeout requirements exist (honest absence —
   * never an empty "0 of 0" section).
   */
  handoverChecklist: HandoverChecklistSection | null;
  summary: Array<{
    id: string;
    templateName: string;
    scopeLine: string;
    statusLabel: string;
    signedOffBy: string | null;
    signedOffAt: string | null;
    progress: { done: number; total: number };
  }>;
  instances: PackInstanceSection[];
  archivedCount: number;
}

/**
 * #374 — the matrix shape the pack consumes. A structural subset of the
 * closeout read-shaper's `CloseoutRequirementView[]` so the pack domain doesn't
 * depend on the server module; the caller maps the view in.
 */
export interface HandoverChecklistInputRow {
  id: string;
  title: string;
  status: string;
  links?: ReadonlyArray<{ type: string; id: string; resolved: boolean }>;
}

const CLOSEOUT_STATUS_LABEL: Record<string, string> = {
  satisfied: "Closed out",
  waived: "Waived",
  in_progress: "In progress",
  outstanding: "Outstanding",
};

/**
 * Build the composable handover-checklist section from the closeout matrix
 * requirements. PURE: same input → same section. Returns `null` for an empty
 * matrix (honest absence). Only RESOLVING links are listed (a dangling link is
 * not evidence of handover). Discharged = satisfied or waived.
 */
export function buildHandoverChecklistSection(
  requirements: ReadonlyArray<HandoverChecklistInputRow>,
): HandoverChecklistSection | null {
  if (requirements.length === 0) return null;
  const rows: HandoverChecklistRow[] = requirements.map((r) => {
    const discharged = r.status === "satisfied" || r.status === "waived";
    return {
      id: r.id,
      title: r.title,
      statusLabel: CLOSEOUT_STATUS_LABEL[r.status] ?? r.status,
      discharged,
      linkedRefs: (r.links ?? []).filter((l) => l.resolved).map((l) => `${l.type}:${l.id}`),
    };
  });
  return {
    discharged: rows.filter((r) => r.discharged).length,
    total: rows.length,
    rows,
  };
}

/** Overrides harvested from the audit log (itp.signed_off metadata), keyed
 *  by instance id. The instance itself does not persist the justification. */
export type OverrideByInstanceId = Readonly<Record<string, string>>;

export function buildCompliancePack(input: {
  job: Job;
  instances: ReadonlyArray<ITPInstance>;
  overrides: OverrideByInstanceId;
  overridesWindowMonths: number;
  generatedAt: string;
  /** #374 — OPTIONAL closeout matrix requirements. When supplied (and non-empty)
   *  the pack carries a prepended handover checklist section; omitted → null. */
  closeoutRequirements?: ReadonlyArray<HandoverChecklistInputRow>;
}): CompliancePack {
  const { job, overrides } = input;
  const live = input.instances.filter((i) => !i.archived);
  const archivedCount = input.instances.length - live.length;

  // Determinism: instances by createdAt (id tiebreak), points in the same
  // (order ?? position) sort ITPRecording renders.
  const ordered = [...live].sort(
    (a, b) =>
      String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
      a.id.localeCompare(b.id)
  );

  const sections = ordered.map((instance) =>
    buildInstanceSection(job, instance, overrides[instance.id] ?? null)
  );

  return {
    jobName: job.name,
    jobId: job.id,
    jobRef: job.ref ?? null,
    siteAddress: job.siteAddress ? String(job.siteAddress).trim() || null : null,
    generatedAt: input.generatedAt,
    overridesNote: `Independence override justifications are sourced from the job audit log (last ${input.overridesWindowMonths} months). Older overrides remain in the audit record.`,
    handoverChecklist: buildHandoverChecklistSection(input.closeoutRequirements ?? []),
    summary: sections.map((s) => ({
      id: s.id,
      templateName: s.templateName,
      scopeLine: s.scopeLine,
      statusLabel: s.statusLabel,
      signedOffBy: s.signOff?.signedOffBy ?? null,
      signedOffAt: s.signOff?.signedOffAt ?? null,
      progress: s.progress,
    })),
    instances: sections,
    archivedCount,
  };
}

function buildInstanceSection(
  job: Job,
  instance: ITPInstance,
  overrideJustification: string | null
): PackInstanceSection {
  const points = (instance.templateSnapshot?.points ?? [])
    .filter((p) => !p.archived)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const progress = formatProgress(instance);
  const scopeName = resolveScopeName(job, instance);
  const status = instance.status;

  return {
    id: instance.id,
    templateName: instance.templateSnapshot?.name?.trim() || "Untitled ITP",
    scopeLine: scopeContextLine(instance.scope, scopeName),
    status,
    statusLabel: statusLabel(status),
    inProgress: status === "pending" || status === "in-progress",
    awaitingSignOff: status === "witnessed",
    progress: { done: progress.done, total: progress.total },
    evidenceCoverage: evidenceCoverage(instance),
    points: points.map((p) => buildPointRow(p, instance)),
    signOff:
      instance.signedOffBy && instance.signedOffAt
        ? {
            signedOffBy: instance.signedOffBy,
            signedOffAt: instance.signedOffAt,
            overrideJustification,
          }
        : null,
    createdAt: instance.createdAt ?? null,
  };
}

function buildPointRow(point: ITPTemplatePoint, instance: ITPInstance): PackPointRow {
  const result = instance.results?.[point.id];
  const recorded = Boolean(result?.at);

  // #293 — snapshot-driven applicability (instance.scope). Same fn as
  // Phil + admin + the server gate; one source of truth.
  const ctx = { scope: instance.scope };
  const applicable = isPointApplicable(point, ctx);
  const notApplicableReason = applicable
    ? null
    : applicabilityReason(point, ctx);

  let valueLabel: string | null = null;
  let passFail: "pass" | "fail" | null = null;
  if (recorded && result) {
    if (point.type === "value") {
      const v = result.value;
      valueLabel =
        v === null || v === undefined || v === ""
          ? null
          : `${String(v)}${point.unit ? ` ${point.unit}` : ""}`;
      passFail = valuePassFail(point, result);
    } else if (point.type === "signoff") {
      valueLabel = result.value === true ? "Complete" : null;
    }
  }

  return {
    id: point.id,
    label: point.label,
    type: point.type,
    required: point.required !== false,
    recorded,
    valueLabel,
    passFail,
    note: result?.note?.trim() ? result.note : null,
    photoUrl: result?.photoUrl?.trim() ? result.photoUrl : null,
    byUsername: result?.byUsername ?? null,
    at: result?.at ?? null,
    applicable,
    notApplicableReason,
  };
}
