import type { ITPInstance, ITPTemplatePoint } from "./types";
import type { Job } from "@/domains/jobs/types";
import {
  evidenceCoverage,
  formatProgress,
  scopeContextLine,
  statusLabel,
  valuePassFail,
} from "./format";
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

export interface CompliancePack {
  jobName: string;
  jobId: string;
  jobRef: string | null;
  /** Site address for the document letterhead; null when not captured. */
  siteAddress: string | null;
  generatedAt: string;
  /** Where override justifications were sourced + the window's honesty note. */
  overridesNote: string;
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

/** Overrides harvested from the audit log (itp.signed_off metadata), keyed
 *  by instance id. The instance itself does not persist the justification. */
export type OverrideByInstanceId = Readonly<Record<string, string>>;

export function buildCompliancePack(input: {
  job: Job;
  instances: ReadonlyArray<ITPInstance>;
  overrides: OverrideByInstanceId;
  overridesWindowMonths: number;
  generatedAt: string;
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
  };
}
