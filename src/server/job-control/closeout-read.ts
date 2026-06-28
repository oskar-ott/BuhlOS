import {
  deriveCloseoutStatus,
  resolveCloseoutLinks,
  type CloseoutKnownIds,
} from "@/domains/job-control/closeout-matrix";
import type {
  CloseoutAreaScope,
  CloseoutFulfilmentLink,
  CloseoutRequirementStatus,
} from "@/domains/job-control/types";
import {
  PersistedJobControlSchema,
  jobControlKey,
  jobControlRevisionOf,
  type PersistedJobControl,
} from "./compile-producer";
import { readJsonBlob } from "./blob";

/**
 * Closeout matrix READER (#374) — the office-facing readiness view of a job's
 * closeout requirements on `jobs/<jobId>/job-control.json` (the SPINE). Mirrors
 * `reconciliation-read.ts` / `status.ts`: read-only, server-only, NO auth of its
 * own, so it MUST be called from an already-admin-gated path (the closeout page /
 * the hub card's admin-gated fetch). It WRITES NOTHING.
 *
 * The status it shows is ALWAYS RE-DERIVED here from the requirement's fulfilment
 * links + admin confirmation + the LIVE id sets — never read back off the stored
 * `status` flag (except `waived`). So a certificate/document/ITP/evidence record
 * that was deleted since a requirement was confirmed shows the requirement
 * REVERTED (in_progress), never orphaned-green. Pass the known id sets (the
 * production deps load them) or every link resolves fail-closed.
 *
 * The response is an explicit field allowlist, never a raw spread of the spine.
 */

export interface CloseoutLinkView {
  type: CloseoutFulfilmentLink["type"];
  id: string;
  resolved: boolean;
}

export interface CloseoutRequirementView {
  id: string;
  title: string;
  kind: string;
  source: "clause" | "manual";
  areaScope: CloseoutAreaScope;
  scopeClauseIds: string[];
  status: CloseoutRequirementStatus;
  confirmedAt: string | null;
  confirmedBy: string | null;
  links: CloseoutLinkView[];
  /** True when a link the requirement carries points at a record that no longer
   *  exists — the requirement reverted rather than orphaned-green. */
  hasDanglingLink: boolean;
}

/** One record an admin can attach to a requirement as a fulfilment link — a
 *  real certificate / document / as-built / ITP instance / evidence id, with a
 *  human label where the store carries one (falls back to the id). Sourced from
 *  the live stores, so the picker only ever offers records that will resolve. */
export interface CloseoutLinkOption {
  type: CloseoutFulfilmentLink["type"];
  id: string;
  label: string;
}

export interface CloseoutCounts {
  total: number;
  outstanding: number;
  inProgress: number;
  satisfied: number;
  waived: number;
  /** Discharged = satisfied + waived (the N of "N of M"). */
  discharged: number;
  /** Fraction discharged, or null when total = 0 (render "Nothing to close out
   *  yet" — never a fake 0% / 100%). */
  fractionDischarged: number | null;
}

/** The views `shapeCloseoutMatrix` can produce (it never errors — only the
 *  orchestration's Blob read can). Kept separate so callers of the pure shaper
 *  narrow on `status` without a phantom `ok:false` branch. */
export type ShapedCloseoutView =
  /** No compiled spine yet (nothing to close out against). */
  | { ok: true; jobId: string; status: "missing" }
  /** The spine exists but failed to parse — surfaced, never silently empty. */
  | { ok: true; jobId: string; status: "unreadable" }
  /** Read — the full requirement list + N-of-M readiness. `revision` lets a
   *  writer use the precondition without a second read. */
  | {
      ok: true;
      jobId: string;
      status: "ready";
      revision: string;
      counts: CloseoutCounts;
      requirements: CloseoutRequirementView[];
      /** The not-yet-discharged requirements (outstanding + in_progress), in
       *  order — the "what's left" list the card shows. */
      outstanding: CloseoutRequirementView[];
      /** Real records an admin can attach as fulfilment links (the link picker's
       *  source). Empty when no records loaded — the picker then offers nothing
       *  rather than inviting a link that can't resolve. */
      linkOptions: CloseoutLinkOption[];
    };

export type CloseoutMatrixView =
  | ShapedCloseoutView
  /** The read itself failed (Blob error) — distinct from a missing spine. */
  | { ok: false; error: string };

export type LoadCloseoutResult =
  | { status: "absent" }
  | { status: "ok"; value: PersistedJobControl }
  | { status: "unreadable" };

export interface CloseoutReadDeps {
  loadArtifact(jobId: string): Promise<LoadCloseoutResult>;
  /** The job's live record ids, for honest status derivation. Optional: omitted
   *  → links resolve fail-closed (nothing shows satisfied). */
  loadKnownIds?(jobId: string): Promise<CloseoutKnownIds>;
  /** The job's linkable records (id + label), for the admin link picker.
   *  Optional: omitted → the picker offers nothing. Best-effort — a failure
   *  must NOT fail the whole read. */
  loadLinkOptions?(jobId: string): Promise<CloseoutLinkOption[]>;
}

/**
 * Pure: shape a loaded spine into the closeout matrix view. Re-derives each
 * requirement's status from its links + confirmation + live ids (never the
 * stored flag), tallies N-of-M, and lists what's outstanding. Explicit field
 * allowlist — no raw spine passthrough.
 */
export function shapeCloseoutMatrix(
  load: LoadCloseoutResult,
  jobId: string,
  known?: CloseoutKnownIds,
  linkOptions?: CloseoutLinkOption[],
): ShapedCloseoutView {
  if (load.status === "absent") return { ok: true, jobId, status: "missing" };
  if (load.status === "unreadable") return { ok: true, jobId, status: "unreadable" };

  const a = load.value;
  const k = known ?? {};

  const requirements: CloseoutRequirementView[] = [...a.closeoutRequirements]
    .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
    .map((req) => {
      const { resolved, dangling } = resolveCloseoutLinks(req, k);
      const resolvedSet = new Set(resolved.map((l) => `${l.type}:${l.id}`));
      const status = deriveCloseoutStatus(req, k);
      return {
        id: req.id,
        title: req.title,
        kind: req.kind,
        source: (req.source ?? "manual") as "clause" | "manual",
        areaScope: (req.areaScope ?? "job_wide") as CloseoutAreaScope,
        scopeClauseIds: [...req.scopeClauseIds],
        status,
        confirmedAt: req.confirmedAt ?? null,
        confirmedBy: req.confirmedBy ?? null,
        links: (req.fulfilmentLinks ?? []).map((l) => ({
          type: l.type,
          id: l.id,
          resolved: resolvedSet.has(`${l.type}:${l.id}`),
        })),
        hasDanglingLink: dangling.length > 0,
      };
    });

  const counts = tally(requirements);
  const outstanding = requirements.filter(
    (r) => r.status === "outstanding" || r.status === "in_progress",
  );

  return {
    ok: true,
    jobId,
    status: "ready",
    revision: jobControlRevisionOf(a),
    counts,
    requirements,
    outstanding,
    linkOptions: linkOptions ?? [],
  };
}

function tally(requirements: ReadonlyArray<CloseoutRequirementView>): CloseoutCounts {
  let outstanding = 0;
  let inProgress = 0;
  let satisfied = 0;
  let waived = 0;
  for (const r of requirements) {
    switch (r.status) {
      case "outstanding":
        outstanding += 1;
        break;
      case "in_progress":
        inProgress += 1;
        break;
      case "satisfied":
        satisfied += 1;
        break;
      case "waived":
        waived += 1;
        break;
    }
  }
  const total = requirements.length;
  const discharged = satisfied + waived;
  return {
    total,
    outstanding,
    inProgress,
    satisfied,
    waived,
    discharged,
    fractionDischarged: total === 0 ? null : discharged / total,
  };
}

/** Read → shape. Total (never throws): a Blob error becomes `{ ok: false }`,
 *  kept distinct from a missing spine. Writes NOTHING. */
export async function runCloseoutMatrixView(
  deps: CloseoutReadDeps,
  jobId: string,
): Promise<CloseoutMatrixView> {
  let load: LoadCloseoutResult;
  try {
    load = await deps.loadArtifact(jobId);
  } catch {
    return { ok: false, error: "Could not read job closeout." };
  }
  // Best-effort: a failure to load the live id sets must NOT fail the whole read.
  let known: CloseoutKnownIds | undefined;
  if (deps.loadKnownIds) {
    try {
      known = await deps.loadKnownIds(jobId);
    } catch {
      known = undefined;
    }
  }
  // Best-effort: a failure to load the picker options must NOT fail the read —
  // an admin can still confirm/waive/remove without the picker.
  let linkOptions: CloseoutLinkOption[] | undefined;
  if (deps.loadLinkOptions) {
    try {
      linkOptions = await deps.loadLinkOptions(jobId);
    } catch {
      linkOptions = undefined;
    }
  }
  return shapeCloseoutMatrix(load, jobId, known, linkOptions);
}

// ── Real deps (Vercel Blob) ───────────────────────────────────────────────────

export function blobCloseoutReadDeps(): CloseoutReadDeps {
  return {
    async loadArtifact(jobId) {
      const raw = await readJsonBlob<unknown>(jobControlKey(jobId), null);
      if (raw == null) return { status: "absent" };
      const parsed = PersistedJobControlSchema.safeParse(raw);
      return parsed.success ? { status: "ok", value: parsed.data } : { status: "unreadable" };
    },
    loadKnownIds: (jobId) => loadJobCloseoutKnownIds(jobId).then((r) => ({
      certificateIds: r.certificateIds,
      documentIds: r.documentIds,
      itpInstanceIds: r.itpInstanceIds,
    })),
    loadLinkOptions: (jobId) => loadJobCloseoutLinkOptions(jobId),
  };
}

/**
 * The record id sets a closeout link can resolve against, read from the real
 * stores: certificates (`jobs/<jobId>/certificates.json#certificates[].id`),
 * documents incl. as-builts (`jobs/<jobId>/plans-index.json#plans[].id`) and ITP
 * instances (`jobs/<jobId>/itps.json#instances[].id`). Evidence is loaded
 * separately by the producer (it shares the proof-id reader with evidence-link).
 * Best-effort and total — a missing/unreadable store yields an empty set, so a
 * link against it simply fails to resolve (fail-closed), never throws.
 */
export async function loadJobCloseoutKnownIds(jobId: string): Promise<{
  certificateIds: Set<string>;
  documentIds: Set<string>;
  itpInstanceIds: Set<string>;
}> {
  const [certs, docs, itps] = await Promise.all([
    readJsonBlob<{ certificates?: Array<{ id?: unknown }> }>(`jobs/${jobId}/certificates.json`, {
      certificates: [],
    }),
    readJsonBlob<{ plans?: Array<{ id?: unknown }> }>(`jobs/${jobId}/plans-index.json`, { plans: [] }),
    readJsonBlob<{ instances?: Array<{ id?: unknown }> }>(`jobs/${jobId}/itps.json`, { instances: [] }),
  ]);
  const idsOf = (rows: Array<{ id?: unknown }> | undefined): Set<string> =>
    new Set((rows ?? []).map((r) => r?.id).filter((id): id is string => typeof id === "string" && id.length > 0));
  return {
    certificateIds: idsOf(certs?.certificates),
    documentIds: idsOf(docs?.plans),
    itpInstanceIds: idsOf(itps?.instances),
  };
}

/**
 * The linkable records the admin picker offers, read from the same live stores
 * as the known-id sets PLUS evidence (`jobs/<jobId>/data.json#evidence[]`), each
 * with a human label where the store carries one (title / name / ref), falling
 * back to the id. A document also surfaces as an `as-built` option so a
 * requirement can cite it under either type. Best-effort and total — a
 * missing/unreadable store contributes nothing, never throws. ONLY real records
 * are offered, so a picked link always resolves (no fabricated options, P7).
 */
export async function loadJobCloseoutLinkOptions(jobId: string): Promise<CloseoutLinkOption[]> {
  const [certs, docs, itps, data] = await Promise.all([
    readJsonBlob<{ certificates?: Array<Record<string, unknown>> }>(`jobs/${jobId}/certificates.json`, {
      certificates: [],
    }),
    readJsonBlob<{ plans?: Array<Record<string, unknown>> }>(`jobs/${jobId}/plans-index.json`, { plans: [] }),
    readJsonBlob<{ instances?: Array<Record<string, unknown>> }>(`jobs/${jobId}/itps.json`, { instances: [] }),
    readJsonBlob<{ evidence?: Array<Record<string, unknown>> }>(`jobs/${jobId}/data.json`, { evidence: [] }),
  ]);

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  const idOf = (row: Record<string, unknown>): string | null => str(row.id);
  const labelOf = (row: Record<string, unknown>, fallbackId: string): string =>
    str(row.title) ?? str(row.name) ?? str(row.label) ?? str(row.referenceNo) ?? str(row.caption) ?? fallbackId;

  const options: CloseoutLinkOption[] = [];
  const push = (
    rows: Array<Record<string, unknown>> | undefined,
    type: CloseoutLinkOption["type"],
  ): void => {
    for (const row of rows ?? []) {
      const id = idOf(row);
      if (!id) continue;
      options.push({ type, id, label: labelOf(row, id) });
    }
  };

  push(certs?.certificates, "certificate");
  // A document is offered under both `document` and `as-built` so the admin can
  // cite an as-built drawing as such; both resolve against the documents id set.
  for (const row of docs?.plans ?? []) {
    const id = idOf(row);
    if (!id) continue;
    const label = labelOf(row, id);
    options.push({ type: "document", id, label });
    options.push({ type: "as-built", id, label });
  }
  push(itps?.instances, "itp-instance");
  push(data?.evidence, "evidence");

  return options;
}
