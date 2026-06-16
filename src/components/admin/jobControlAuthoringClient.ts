/**
 * Admin client for required-proof authoring — the BuhlOS half of the job-control
 * loop. Replaces the DevTools-JSON route path (#471) with a real click-path: an
 * admin selects a scope clause, ties it to an existing worker task, names the
 * required proof, and runs L0 reconciliation confirm → L1 compile preview →
 * confirm so Phil shows "Capture proof".
 *
 * Pure on purpose (the repo has no RTL/jsdom): the payload builders, the
 * save-gate, the route wrappers (fetch injectable) and the result summaries are
 * all unit-tested here; the React panel is a thin shell over these. It only ever
 * sends the domain's real classifications + real task coordinates — never an
 * invented id, never a fabricated proof item.
 */

/** The field-delivering classifications an admin may pick — the ONLY ones that
 *  compile into a work package with worker tasks. Plain labels, never the raw
 *  enum; values are the domain's closed set (no `field_delivered` etc.). */
export const FIELD_CLASSIFICATION_OPTIONS = [
  { value: "priced", label: "Priced field work" },
  { value: "general_allowance", label: "General allowance" },
  { value: "pc_provisional", label: "PC / provisional" },
] as const;

export type FieldClassification = (typeof FIELD_CLASSIFICATION_OPTIONS)[number]["value"];

/** Proof kinds — the closed REQUIRED_EVIDENCE_KINDS set, with worker-plain labels. */
export const EVIDENCE_KIND_OPTIONS = [
  { value: "photo", label: "Photo" },
  { value: "test_result", label: "Test result" },
  { value: "as_built", label: "As-built" },
  { value: "certificate", label: "Certificate" },
] as const;

export type EvidenceKind = (typeof EVIDENCE_KIND_OPTIONS)[number]["value"];

/** The two job-control stages, worker-plain. */
export const STAGE_OPTIONS = [
  { value: "roughIn", label: "Rough-in" },
  { value: "fitOff", label: "Fit-off" },
] as const;

export type AuthoringStage = (typeof STAGE_OPTIONS)[number]["value"];

/** The admin's in-progress selection for one clause. */
export interface AuthoringSelection {
  clauseId: string;
  classification: FieldClassification | "";
  areaId: string;
  stage: AuthoringStage | "";
  taskId: string;
  proofLabel: string;
  proofKind: EvidenceKind;
  proofNote: string;
}

export const EMPTY_SELECTION: AuthoringSelection = {
  clauseId: "",
  classification: "",
  areaId: "",
  stage: "",
  taskId: "",
  proofLabel: "",
  proofKind: "photo",
  proofNote: "",
};

/** Save is allowed only with a clause, a field classification, a COMPLETE task
 *  coordinate, and at least one named proof item — so we never POST a partial
 *  classification or an empty/fabricated proof. */
export function canSave(sel: AuthoringSelection): boolean {
  return Boolean(
    sel.clauseId &&
      sel.classification &&
      sel.areaId &&
      sel.stage &&
      sel.taskId &&
      sel.proofLabel.trim() &&
      sel.proofKind,
  );
}

export interface ClassificationPatch {
  classification: FieldClassification;
  deliveredBy: Array<{ areaId: string; stage: AuthoringStage; taskId: string }>;
  requiredEvidence: Array<{ label: string; kind: EvidenceKind; note?: string }>;
}

/** Build the clause patch from a (validated) selection. The proof id is OMITTED
 *  on purpose — the L0 producer derives a stable `re_…` id from the label
 *  (#471 `deriveRequiredEvidenceId`). Note is included only when non-empty. */
export function buildClassificationPatch(sel: AuthoringSelection): ClassificationPatch {
  const note = sel.proofNote.trim();
  return {
    classification: sel.classification as FieldClassification,
    deliveredBy: [{ areaId: sel.areaId, stage: sel.stage as AuthoringStage, taskId: sel.taskId }],
    requiredEvidence: [
      { label: sel.proofLabel.trim(), kind: sel.proofKind, ...(note ? { note } : {}) },
    ],
  };
}

/** The exact L0 reconciliation-confirm body (one clause). */
export function buildReconciliationConfirmBody(jobId: string, sel: AuthoringSelection) {
  return { jobId, classifications: { [sel.clauseId]: buildClassificationPatch(sel) } };
}

// ── Route wrappers (fetch injectable for tests) ───────────────────────────────

export type ClientResult<T> = { ok: true; data: T } | { ok: false; message: string };

async function postJson(
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* non-JSON / empty — fall back to status mapping */
  }
  return { status: res.status, ok: res.ok, body: (parsed ?? {}) as Record<string, unknown> };
}

/** Plain, admin-readable error copy from a route failure. */
function failMessage(
  action: string,
  r: { status: number; body: Record<string, unknown> },
): string {
  if (r.status === 401 || r.status === 403) return "Authoring required proof needs an admin login.";
  const code = r.body.code;
  if (code === "stale_source")
    return "The job changed since you loaded it. Reload and try again.";
  if (code === "stale_revision")
    return "The compiled job changed since you loaded it. Reload and try again.";
  if (code === "no_reconciliation") return "Save the required proof first, then compile.";
  if (r.status === 404) return "This job isn’t available.";
  const apiErr = typeof r.body.error === "string" ? r.body.error : "";
  return apiErr || `Couldn’t ${action}. Try again.`;
}

export interface SaveReconciliationData {
  status: string;
  sourceHash: string;
}

/** POST /api/job-control/reconciliation/confirm */
export async function saveReconciliation(
  jobId: string,
  sel: AuthoringSelection,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientResult<SaveReconciliationData>> {
  let r: Awaited<ReturnType<typeof postJson>>;
  try {
    r = await postJson(
      "/api/job-control/reconciliation/confirm",
      buildReconciliationConfirmBody(jobId, sel),
      fetchImpl,
    );
  } catch {
    return { ok: false, message: "Network error. Try again." };
  }
  const saved = r.body.saved as { status?: string; sourceHash?: string } | undefined;
  if (r.ok && r.body.ok === true && saved) {
    return { ok: true, data: { status: saved.status ?? "", sourceHash: saved.sourceHash ?? "" } };
  }
  return { ok: false, message: failMessage("save the proof", r) };
}

export interface CompilePreviewData {
  workPackageCount: number;
  requiredProofCount: number;
  gaps: string[];
  added: number;
  updated: number;
  removed: number;
  sourceHash: string;
}

/** POST /api/job-control/compile/preview */
export async function compilePreview(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientResult<CompilePreviewData>> {
  let r: Awaited<ReturnType<typeof postJson>>;
  try {
    r = await postJson("/api/job-control/compile/preview", { jobId }, fetchImpl);
  } catch {
    return { ok: false, message: "Network error. Try again." };
  }
  if (r.ok && r.body.ok === true) {
    return { ok: true, data: summarisePreview(r.body) };
  }
  return { ok: false, message: failMessage("preview the compile", r) };
}

/** Pure: shape a raw preview response into the admin-facing summary. */
export function summarisePreview(body: Record<string, unknown>): CompilePreviewData {
  const workPackages = Array.isArray(body.workPackages) ? body.workPackages : [];
  const gaps = Array.isArray(body.gaps) ? body.gaps : [];
  const diff = (body.diff ?? {}) as { added?: number; updated?: number; removed?: number };
  const requiredProofCount = workPackages.reduce((sum: number, wp) => {
    const re = (wp as { requiredEvidence?: unknown[] }).requiredEvidence;
    return sum + (Array.isArray(re) ? re.length : 0);
  }, 0);
  return {
    workPackageCount: workPackages.length,
    requiredProofCount,
    gaps: gaps.map((g) => String((g as { message?: unknown }).message ?? "")).filter(Boolean),
    added: diff.added ?? 0,
    updated: diff.updated ?? 0,
    removed: diff.removed ?? 0,
    sourceHash: typeof body.sourceHash === "string" ? body.sourceHash : "",
  };
}

export interface CompileConfirmData {
  revision: string;
  workPackageCount: number;
  gapCount: number;
  key: string;
}

/** POST /api/job-control/compile/confirm */
export async function compileConfirm(
  jobId: string,
  sourceHash: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientResult<CompileConfirmData>> {
  let r: Awaited<ReturnType<typeof postJson>>;
  try {
    r = await postJson(
      "/api/job-control/compile/confirm",
      sourceHash ? { jobId, sourceHash } : { jobId },
      fetchImpl,
    );
  } catch {
    return { ok: false, message: "Network error. Try again." };
  }
  const saved = r.body.saved as
    | { revision?: string; workPackageCount?: number; gapCount?: number; key?: string }
    | undefined;
  if (r.ok && r.body.ok === true && saved) {
    return {
      ok: true,
      data: {
        revision: saved.revision ?? "",
        workPackageCount: saved.workPackageCount ?? 0,
        gapCount: saved.gapCount ?? 0,
        key: saved.key ?? "",
      },
    };
  }
  return { ok: false, message: failMessage("compile for Phil", r) };
}
