import { isRequiredEvidenceMet } from "@/domains/job-control/task-context";
import {
  PersistedJobControlSchema,
  jobControlKey,
  jobControlRevisionOf,
  type PersistedJobControl,
} from "./compile-producer";
import { readJsonBlob } from "./blob";

/**
 * Admin proof-status READER (read-only office audit of the compiled job-control
 * artifact). The mirror of the L2 field read (`read.ts`), but admin-facing: it
 * answers "what proof did we compile for Phil, and what has the field captured?"
 *
 * Server-only, like `read.ts` — it has NO auth of its own and reads the Blob
 * directly, so it MUST be called from an already-admin-gated path (the
 * `/v2/jobs/[jobId]/job-control` page, which gates `isAdminRole`). It WRITES
 * NOTHING, compiles nothing, links nothing — it only reads
 * `jobs/<jobId>/job-control.json` and derives a needed/met matrix.
 *
 * The needed/met rule is the SHARED `isRequiredEvidenceMet` (task-context.ts) —
 * the exact same predicate Phil uses — so the office and the field never
 * disagree about whether a proof is satisfied (P7).
 *
 * Admin-appropriate (unlike the field read it does NOT strip the office-side
 * compile fingerprints / gap count): the office may see the revision, the source
 * hashes and the gap count. It still NEVER exposes secrets, Blob tokens or signed
 * URLs — none live in the artifact, and the response is an explicit field
 * allowlist, never a raw spread.
 */

export interface ProofEvidenceLinkView {
  evidenceId: string | null;
  observationId: string | null;
  linkedAt: string | null;
  linkedBy: string | null;
}

export interface ProofRequirementView {
  id: string;
  label: string;
  kind: string;
  note: string | null;
  status: "needed" | "met";
  evidenceLinks: ProofEvidenceLinkView[];
}

export interface ProofWorkPackageView {
  id: string;
  title: string;
  scopeClauseIds: string[];
  requiredEvidence: ProofRequirementView[];
}

export type ProofStatusResult =
  /** No compiled artifact yet (nothing compiled for Phil). */
  | { ok: true; jobId: string; status: "missing" }
  /** The artifact exists but failed to parse — surfaced, never silently empty. */
  | { ok: true; jobId: string; status: "unreadable" }
  /** Compiled — the full needed/met matrix + office provenance. */
  | {
      ok: true;
      jobId: string;
      status: "compiled";
      revision: string;
      sourceHash: string | null;
      sourceReconciliationHash: string | null;
      sourceStructureHash: string | null;
      generatedAt: string | null;
      confirmedAt: string | null;
      confirmedBy: string | null;
      gapCount: number;
      workPackageCount: number;
      requiredProofTotal: number;
      neededCount: number;
      metCount: number;
      evidenceLinkCount: number;
      workPackages: ProofWorkPackageView[];
    }
  /** The read itself failed (Blob error) — distinct from a missing artifact. */
  | { ok: false; error: string };

export type LoadArtifactResult =
  | { status: "absent" }
  | { status: "ok"; value: PersistedJobControl }
  | { status: "unreadable" };

export interface ProofStatusDeps {
  loadArtifact(jobId: string): Promise<LoadArtifactResult>;
}

/**
 * Pure: shape a loaded artifact into the admin proof-status view. Derives
 * needed/met per requirement via the shared predicate and attaches the matching
 * evidence links. Explicit field allowlist — no raw artifact passthrough.
 */
export function shapeProofStatus(load: LoadArtifactResult, jobId: string): ProofStatusResult {
  if (load.status === "absent") return { ok: true, jobId, status: "missing" };
  if (load.status === "unreadable") return { ok: true, jobId, status: "unreadable" };

  const a = load.value;
  const links = a.evidenceLinks;

  const workPackages: ProofWorkPackageView[] = a.workPackages.map((wp) => {
    const requiredEvidence: ProofRequirementView[] = (wp.requiredEvidence ?? []).map((e) => {
      const matching = links.filter(
        (el) =>
          el.workPackageId === wp.id &&
          el.requiredEvidenceId === e.id &&
          Boolean(el.evidenceId || el.observationId),
      );
      return {
        id: e.id,
        label: e.label,
        kind: e.kind,
        note: e.note ?? null,
        status: isRequiredEvidenceMet(links, wp.id, e.id) ? "met" : "needed",
        evidenceLinks: matching.map((el) => ({
          evidenceId: el.evidenceId ?? null,
          observationId: el.observationId ?? null,
          linkedAt: el.createdAt ?? null,
          linkedBy: el.createdBy ?? null,
        })),
      };
    });
    return {
      id: wp.id,
      title: wp.title,
      scopeClauseIds: [...wp.scopeClauseIds],
      requiredEvidence,
    };
  });

  const allReqs = workPackages.flatMap((wp) => wp.requiredEvidence);
  const metCount = allReqs.filter((r) => r.status === "met").length;
  const meta = a.compileMeta;

  return {
    ok: true,
    jobId,
    status: "compiled",
    revision: jobControlRevisionOf(a),
    sourceHash: meta?.sourceHash ?? null,
    sourceReconciliationHash: meta?.sourceReconciliationHash ?? null,
    sourceStructureHash: meta?.sourceStructureHash ?? null,
    generatedAt: meta?.generatedAt ?? null,
    confirmedAt: meta?.confirmedAt ?? null,
    confirmedBy: meta?.confirmedBy ?? null,
    gapCount: meta?.gaps.length ?? 0,
    workPackageCount: workPackages.length,
    requiredProofTotal: allReqs.length,
    neededCount: allReqs.length - metCount,
    metCount,
    evidenceLinkCount: links.length,
    workPackages,
  };
}

/** Read → shape. Total (never throws): a Blob error becomes `{ ok: false }`,
 *  kept distinct from a missing artifact. Writes NOTHING. */
export async function runProofStatus(
  deps: ProofStatusDeps,
  jobId: string,
): Promise<ProofStatusResult> {
  let load: LoadArtifactResult;
  try {
    load = await deps.loadArtifact(jobId);
  } catch {
    return { ok: false, error: "Could not read job-control status." };
  }
  return shapeProofStatus(load, jobId);
}

/** Production deps: read `jobs/<jobId>/job-control.json` (read-only). Missing →
 *  absent; present-but-unparseable → unreadable (surfaced, never clobbered). */
export function blobProofStatusDeps(): ProofStatusDeps {
  return {
    async loadArtifact(jobId) {
      const raw = await readJsonBlob<unknown>(jobControlKey(jobId), null);
      if (raw == null) return { status: "absent" };
      const parsed = PersistedJobControlSchema.safeParse(raw);
      return parsed.success ? { status: "ok", value: parsed.data } : { status: "unreadable" };
    },
  };
}
