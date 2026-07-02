import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  isBlobConfigured,
  readJsonBlob,
  writeJsonBlob,
} from "@/server/job-control/blob";
import { ProgressClaimsDocSchema, CLAIM_ID_PREFIXES } from "@/domains/progress-claims/schema";
import type {
  ClaimAttachment,
  ClaimEvidenceRef,
  ProgressClaim,
  ProgressClaimLine,
  ProgressClaimsDoc,
  ProgressClaimStatus,
} from "@/domains/progress-claims/types";
import {
  canTransition,
  certifiedVarianceCents,
  computeClaimTotals,
  countedClaims,
  deriveClaimedToDateCents,
  isImmutable,
  oldestUnpaidClaimDays,
  validateForSubmit,
  validateLine,
  withComputedValues,
} from "@/domains/progress-claims/math";
import {
  carryForwardManualLines,
  manualSourceKey,
  seedLinesFromPackages,
  seedLinesFromQuote,
  type SeedQuote,
  type SeedWorkPackage,
} from "@/domains/progress-claims/seed";

/**
 * Per-job progress-claims store (#372) — `jobs/<jobId>/claims.json`.
 *
 * Follows the job-control runtime conventions (ADR:
 * docs/architecture/job-control-runtime-adr.md):
 *   - deps-injected reads/writes so every operation is unit-testable without
 *     Blob (see store.test.ts);
 *   - a content-hash `revision` on the doc; every MUTATION requires the
 *     revision the caller read and 409s `stale_revision` when it moved
 *     (advisory CAS — Blob `put` has no conditional write);
 *   - ONE `saveDoc` write per mutation; the jobs.json derived rollup is the
 *     ROUTE's follow-up through the guarded legacy writer, never a raw write
 *     from here.
 *
 * The store is the ONLY writer of claims.json. The key sits under the `jobs/`
 * backup prefix (api/_lib/backup-manifest.js), so it is snapshot-covered from
 * the first write.
 */

export const claimsKey = (jobId: string): string => `jobs/${jobId}/claims.json`;

// ── Revision (job-control revision-guard pattern) ────────────────────────────

export function computeClaimsRevision(doc: Pick<ProgressClaimsDoc, "jobId" | "claims">): string {
  return createHash("sha256")
    .update(JSON.stringify({ jobId: doc.jobId, claims: doc.claims }))
    .digest("hex");
}

export function claimsRevisionOf(doc: ProgressClaimsDoc): string {
  return doc.revision ?? computeClaimsRevision(doc);
}

// ── Deps ─────────────────────────────────────────────────────────────────────

/** Minimal shapes read from neighbouring stores — validated leniently here
 *  (safeParse + passthrough); their own domains stay authoritative. */
const JobsBlobSchema = z.object({
  jobs: z.array(z.object({ id: z.string() }).passthrough()).default([]),
});
const QuoteDocSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    sections: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string().nullable().optional(),
            lines: z
              .array(
                z
                  .object({
                    id: z.string(),
                    description: z.string().default(""),
                    qty: z.number(),
                    rate: z.number(),
                  })
                  .passthrough(),
              )
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
const SpineSchema = z
  .object({
    workPackages: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string().default(""),
            boqLineRefs: z
              .array(
                z
                  .object({ quoteId: z.string(), sectionId: z.string(), lineId: z.string() })
                  .passthrough(),
              )
              .default([]),
            taskRefs: z
              .array(
                z
                  .object({ areaId: z.string(), stage: z.string(), taskId: z.string() })
                  .passthrough(),
              )
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
const JobDataSchema = z
  .object({
    dwellings: z.record(z.string(), z.unknown()).default({}),
    evidence: z.array(z.object({ id: z.string() }).passthrough()).default([]),
  })
  .passthrough();
const ItpsDocSchema = z
  .object({
    instances: z.array(z.object({ id: z.string() }).passthrough()).default([]),
  })
  .passthrough();
const VariationsDocSchema = z
  .object({
    claims: z.array(z.object({ id: z.string() }).passthrough()).default([]),
  })
  .passthrough();
const DayworksDocSchema = z
  .object({
    dockets: z.array(z.object({ id: z.string() }).passthrough()).default([]),
  })
  .passthrough();

export interface ClaimsStoreDeps {
  loadDoc(jobId: string): Promise<unknown | null>;
  saveDoc(jobId: string, doc: ProgressClaimsDoc): Promise<void>;
  /** The job row from jobs.json (fromQuoteId + the hand-set money scalars). */
  loadJob(jobId: string): Promise<Record<string, unknown> | null>;
  loadQuote(quoteId: string): Promise<unknown | null>;
  /** jobs/<id>/job-control.json — compiled work packages (#367). */
  loadSpine(jobId: string): Promise<unknown | null>;
  /** jobs/<id>/data.json — evidence records + dwellings task state. */
  loadJobData(jobId: string): Promise<unknown | null>;
  loadItps(jobId: string): Promise<unknown | null>;
  loadVariations(jobId: string): Promise<unknown | null>;
  loadDayworks(jobId: string): Promise<unknown | null>;
  mintClaimId(): string;
  mintLineId(): string;
}

export function blobClaimsDeps(): ClaimsStoreDeps {
  return {
    loadDoc: (jobId) => readJsonBlob<unknown>(claimsKey(jobId), null),
    saveDoc: (jobId, doc) => writeJsonBlob(claimsKey(jobId), doc),
    async loadJob(jobId) {
      const data = await readJsonBlob<unknown>("jobs.json", null);
      const parsed = JobsBlobSchema.safeParse(data);
      if (!parsed.success) return null;
      return parsed.data.jobs.find((j) => j.id === jobId) ?? null;
    },
    loadQuote: (quoteId) => readJsonBlob<unknown>(`quotes-v2/${quoteId}.json`, null),
    loadSpine: (jobId) => readJsonBlob<unknown>(`jobs/${jobId}/job-control.json`, null),
    loadJobData: (jobId) => readJsonBlob<unknown>(`jobs/${jobId}/data.json`, null),
    loadItps: (jobId) => readJsonBlob<unknown>(`jobs/${jobId}/itps.json`, null),
    loadVariations: (jobId) => readJsonBlob<unknown>(`jobs/${jobId}/variations.json`, null),
    loadDayworks: (jobId) => readJsonBlob<unknown>(`jobs/${jobId}/dayworks.json`, null),
    mintClaimId: () => `${CLAIM_ID_PREFIXES.claim}${randomUUID()}`,
    mintLineId: () => `${CLAIM_ID_PREFIXES.claimLine}${randomUUID()}`,
  };
}

export { isBlobConfigured };

// ── Results ──────────────────────────────────────────────────────────────────

export type ClaimsFailure = {
  ok: false;
  status: 400 | 404 | 409 | 422 | 503;
  reason:
    | "job_not_found"
    | "claim_not_found"
    | "line_not_found"
    | "doc_unreadable"
    | "stale_revision"
    | "draft_exists"
    | "immutable_claim"
    | "invalid_transition"
    | "over_claim"
    | "negative_to_date"
    | "submit_blocked"
    | "bad_input"
    | "record_not_found"
    | "already_attached"
    | "not_attachable"
    | "storage_unavailable";
  error: string;
  /** Present on stale_revision — re-read and retry. */
  currentRevision?: string;
  /** Present on submit_blocked. */
  blockers?: ReturnType<typeof validateForSubmit>;
};

export type ClaimsSuccess = {
  ok: true;
  status: 200;
  doc: ProgressClaimsDoc;
  revision: string;
  claim: ProgressClaim | null;
};

export type ClaimsResult = ClaimsSuccess | ClaimsFailure;

const fail = (
  status: ClaimsFailure["status"],
  reason: ClaimsFailure["reason"],
  error: string,
  extra?: Partial<ClaimsFailure>,
): ClaimsFailure => ({ ok: false, status, reason, error, ...extra });

// ── Doc load/save plumbing ───────────────────────────────────────────────────

async function loadParsedDoc(
  deps: ClaimsStoreDeps,
  jobId: string,
): Promise<{ ok: true; doc: ProgressClaimsDoc } | ClaimsFailure> {
  const raw = await deps.loadDoc(jobId);
  if (raw == null) {
    return { ok: true, doc: { jobId, claims: [] } };
  }
  const parsed = ProgressClaimsDocSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(422, "doc_unreadable", "The stored claims document could not be read — refusing to overwrite it.");
  }
  return { ok: true, doc: parsed.data };
}

/** Refresh a claim's computed line values + totals (server is authoritative). */
function recompute(claim: ProgressClaim): ProgressClaim {
  const lines = claim.lines.map(withComputedValues);
  return { ...claim, lines, totals: computeClaimTotals(lines, claim.attachments) };
}

async function saveMutated(
  deps: ClaimsStoreDeps,
  doc: ProgressClaimsDoc,
  claims: ProgressClaim[],
  touched: ProgressClaim | null,
): Promise<ClaimsSuccess> {
  const nextBase: ProgressClaimsDoc = { ...doc, claims };
  const next: ProgressClaimsDoc = { ...nextBase, revision: computeClaimsRevision(nextBase) };
  await deps.saveDoc(next.jobId, next);
  return { ok: true, status: 200, doc: next, revision: next.revision as string, claim: touched };
}

/** Shared preamble for every mutation: job exists, doc parses, revision holds. */
async function beginMutation(
  deps: ClaimsStoreDeps,
  jobId: string,
  expectedRevision: string,
): Promise<{ ok: true; doc: ProgressClaimsDoc; job: Record<string, unknown> } | ClaimsFailure> {
  const job = await deps.loadJob(jobId);
  if (!job) return fail(404, "job_not_found", "Job not found.");
  const loaded = await loadParsedDoc(deps, jobId);
  if (!loaded.ok) return loaded;
  const currentRevision = claimsRevisionOf(loaded.doc);
  if (expectedRevision !== currentRevision) {
    return fail(409, "stale_revision", "The claims register changed since you read it — reload and retry.", {
      currentRevision,
    });
  }
  return { ok: true, doc: loaded.doc, job };
}

function findDraft(
  doc: ProgressClaimsDoc,
  claimId: string,
): { ok: true; claim: ProgressClaim } | ClaimsFailure {
  const claim = doc.claims.find((c) => c.id === claimId);
  if (!claim) return fail(404, "claim_not_found", "Claim not found.");
  if (isImmutable(claim)) {
    return fail(409, "immutable_claim", "A submitted claim is immutable — raise the correction on the next claim.");
  }
  return { ok: true, claim };
}

// ── Create (seeded) ──────────────────────────────────────────────────────────

export async function createClaim(
  deps: ClaimsStoreDeps,
  input: {
    jobId: string;
    expectedRevision: string;
    periodLabel?: string | null;
    at: string;
    by: string | null;
  },
): Promise<ClaimsResult> {
  const begin = await beginMutation(deps, input.jobId, input.expectedRevision);
  if (!begin.ok) return begin;
  const { doc, job } = begin;

  if (doc.claims.some((c) => c.status === "draft")) {
    return fail(409, "draft_exists", "There is already an open draft claim — submit or delete it first.");
  }

  const seedDeps = { mintLineId: deps.mintLineId, priorClaims: doc.claims };

  // Priced source first: the linked quote (imported BOQ lines live there after
  // #365/#828 materialises them). Fallback: compiled work packages. Else blank.
  let lines: ProgressClaimLine[] = [];
  let seedSource: ProgressClaim["seedSource"] = "blank";
  let quoteId: string | null = null;

  const spineRaw = input.jobId ? await deps.loadSpine(input.jobId) : null;
  const spine = SpineSchema.safeParse(spineRaw ?? {});
  const workPackages: SeedWorkPackage[] = spine.success ? spine.data.workPackages : [];

  const fromQuoteId = typeof job.fromQuoteId === "string" ? job.fromQuoteId : null;
  if (fromQuoteId) {
    const quoteRaw = await deps.loadQuote(fromQuoteId);
    const quote = QuoteDocSchema.safeParse(quoteRaw);
    if (quote.success && quote.data.sections.some((s) => s.lines.length > 0)) {
      lines = seedLinesFromQuote(quote.data as SeedQuote, workPackages, seedDeps);
      seedSource = "quote";
      quoteId = fromQuoteId;
    }
  }
  if (seedSource === "blank" && workPackages.length > 0) {
    lines = seedLinesFromPackages(workPackages, seedDeps);
    seedSource = "packages";
  }
  lines = carryForwardManualLines(lines, seedDeps);

  const counted = countedClaims(doc.claims);
  const number = doc.claims.reduce((m, c) => Math.max(m, c.number), 0) + 1;
  const claim: ProgressClaim = recompute({
    id: deps.mintClaimId(),
    jobId: input.jobId,
    number,
    periodLabel: input.periodLabel ?? null,
    status: "draft",
    seedSource,
    quoteId,
    previousClaimId: counted[counted.length - 1]?.id ?? null,
    lines,
    attachments: [],
    totals: computeClaimTotals(lines, []),
    evidenceManifest: null,
    createdAt: input.at,
    createdBy: input.by,
  });
  return saveMutated(deps, doc, [...doc.claims, claim], claim);
}

// ── Draft edits ──────────────────────────────────────────────────────────────

export async function updateClaimMeta(
  deps: ClaimsStoreDeps,
  input: { jobId: string; expectedRevision: string; claimId: string; periodLabel: string | null },
): Promise<ClaimsResult> {
  const begin = await beginMutation(deps, input.jobId, input.expectedRevision);
  if (!begin.ok) return begin;
  const found = findDraft(begin.doc, input.claimId);
  if (!found.ok) return found;
  const next = recompute({ ...found.claim, periodLabel: input.periodLabel });
  return saveMutated(deps, begin.doc, begin.doc.claims.map((c) => (c.id === next.id ? next : c)), next);
}

export async function updateLine(
  deps: ClaimsStoreDeps,
  input: {
    jobId: string;
    expectedRevision: string;
    claimId: string;
    lineId: string;
    thisPctBp?: number;
    overClaimOverride?: boolean;
    description?: string;
    /** Only settable on manual-valued lines (quote lines stay source-locked). */
    contractValueCents?: number | null;
  },
): Promise<ClaimsResult> {
  const begin = await beginMutation(deps, input.jobId, input.expectedRevision);
  if (!begin.ok) return begin;
  const found = findDraft(begin.doc, input.claimId);
  if (!found.ok) return found;
  const line = found.claim.lines.find((l) => l.id === input.lineId);
  if (!line) return fail(404, "line_not_found", "Claim line not found.");

  const patched: ProgressClaimLine = { ...line };
  if (input.thisPctBp !== undefined) {
    if (!Number.isInteger(input.thisPctBp)) return fail(400, "bad_input", "thisPctBp must be integer basis points.");
    patched.thisPctBp = input.thisPctBp;
  }
  if (input.overClaimOverride !== undefined) patched.overClaimOverride = input.overClaimOverride;
  if (input.description !== undefined) {
    const d = input.description.trim();
    if (!d) return fail(400, "bad_input", "description cannot be empty.");
    patched.description = d.slice(0, 500);
  }
  if (input.contractValueCents !== undefined) {
    if (patched.contractValueSource !== "manual") {
      return fail(422, "bad_input", "This line's contract value comes from the quote — it can't be edited here.");
    }
    if (input.contractValueCents != null && (!Number.isInteger(input.contractValueCents) || input.contractValueCents < 0)) {
      return fail(400, "bad_input", "contractValueCents must be a non-negative integer or null.");
    }
    patched.contractValueCents = input.contractValueCents;
  }

  const err = validateLine(withComputedValues(patched));
  if (err) {
    return err.code === "over_claim"
      ? fail(422, "over_claim", "This claim would push the line past 100% claimed — tick the over-claim override to proceed.")
      : fail(422, "negative_to_date", "This credit would take the line's claimed-to-date below zero.");
  }

  const next = recompute({
    ...found.claim,
    lines: found.claim.lines.map((l) => (l.id === patched.id ? patched : l)),
  });
  return saveMutated(deps, begin.doc, begin.doc.claims.map((c) => (c.id === next.id ? next : c)), next);
}

export async function addManualLine(
  deps: ClaimsStoreDeps,
  input: {
    jobId: string;
    expectedRevision: string;
    claimId: string;
    description: string;
    contractValueCents: number | null;
  },
): Promise<ClaimsResult> {
  const begin = await beginMutation(deps, input.jobId, input.expectedRevision);
  if (!begin.ok) return begin;
  const found = findDraft(begin.doc, input.claimId);
  if (!found.ok) return found;
  const description = input.description.trim();
  if (!description) return fail(400, "bad_input", "description is required.");
  if (input.contractValueCents != null && (!Number.isInteger(input.contractValueCents) || input.contractValueCents < 0)) {
    return fail(400, "bad_input", "contractValueCents must be a non-negative integer or null.");
  }
  const id = deps.mintLineId();
  const manualCount = found.claim.lines.filter((l) => l.sourceKey.startsWith("manual:")).length;
  const line: ProgressClaimLine = withComputedValues({
    id,
    sourceKey: manualSourceKey(id),
    lineRef: `M${manualCount + 1}`,
    sectionLabel: null,
    description: description.slice(0, 500),
    boqLineRef: null,
    workPackageId: null,
    contractValueCents: input.contractValueCents,
    contractValueSource: "manual",
    previousPctBp: 0,
    previousValueCents: 0,
    thisPctBp: 0,
    overClaimOverride: false,
    evidenceRefs: [],
    toDatePctBp: 0,
    toDateValueCents: null,
    thisValueCents: null,
    order: found.claim.lines.length,
  });
  const next = recompute({ ...found.claim, lines: [...found.claim.lines, line] });
  return saveMutated(deps, begin.doc, begin.doc.claims.map((c) => (c.id === next.id ? next : c)), next);
}

export async function removeLine(
  deps: ClaimsStoreDeps,
  input: { jobId: string; expectedRevision: string; claimId: string; lineId: string },
): Promise<ClaimsResult> {
  const begin = await beginMutation(deps, input.jobId, input.expectedRevision);
  if (!begin.ok) return begin;
  const found = findDraft(begin.doc, input.claimId);
  if (!found.ok) return found;
  if (!found.claim.lines.some((l) => l.id === input.lineId)) {
    return fail(404, "line_not_found", "Claim line not found.");
  }
  const next = recompute({
    ...found.claim,
    lines: found.claim.lines.filter((l) => l.id !== input.lineId),
  });
  return saveMutated(deps, begin.doc, begin.doc.claims.map((c) => (c.id === next.id ? next : c)), next);
}

// ── Evidence linking (real records only) ─────────────────────────────────────

export async function linkEvidence(
  deps: ClaimsStoreDeps,
  input: {
    jobId: string;
    expectedRevision: string;
    claimId: string;
    lineId: string;
    add?: ReadonlyArray<{ kind: "evidence" | "itp"; id: string }>;
    removeIds?: ReadonlyArray<string>;
  },
): Promise<ClaimsResult> {
  const begin = await beginMutation(deps, input.jobId, input.expectedRevision);
  if (!begin.ok) return begin;
  const found = findDraft(begin.doc, input.claimId);
  if (!found.ok) return found;
  const line = found.claim.lines.find((l) => l.id === input.lineId);
  if (!line) return fail(404, "line_not_found", "Claim line not found.");

  let refs: ClaimEvidenceRef[] = line.evidenceRefs.filter(
    (r) => !(input.removeIds ?? []).includes(r.id),
  );

  if (input.add && input.add.length > 0) {
    // Validate every added ref against the job's LIVE records — a claim line
    // only ever cites proof that exists (AC2: real links only).
    const [dataRaw, itpsRaw] = await Promise.all([
      deps.loadJobData(input.jobId),
      deps.loadItps(input.jobId),
    ]);
    const data = JobDataSchema.safeParse(dataRaw ?? {});
    const itps = ItpsDocSchema.safeParse(itpsRaw ?? {});
    const evidenceById = new Map(
      (data.success ? data.data.evidence : []).map((e) => [e.id, e] as const),
    );
    const itpById = new Map(
      (itps.success ? itps.data.instances : []).map((i) => [i.id, i] as const),
    );
    for (const add of input.add) {
      if (refs.some((r) => r.id === add.id)) continue;
      if (add.kind === "evidence") {
        const rec = evidenceById.get(add.id);
        if (!rec) return fail(422, "record_not_found", `Evidence ${add.id} does not exist on this job.`);
        const note = typeof rec.note === "string" && rec.note.trim() ? rec.note.trim() : null;
        const kind = typeof rec.kind === "string" ? rec.kind : "evidence";
        refs = [...refs, { kind: "evidence", id: add.id, label: note ?? (kind === "photo" ? "Photo" : "Note") }];
      } else {
        const rec = itpById.get(add.id);
        if (!rec) return fail(422, "record_not_found", `ITP instance ${add.id} does not exist on this job.`);
        const snap = rec.templateSnapshot as { name?: unknown } | undefined;
        const name = snap && typeof snap.name === "string" ? snap.name : "ITP";
        const status = typeof rec.status === "string" ? rec.status : "unknown";
        refs = [...refs, { kind: "itp", id: add.id, label: `${name} (${status})` }];
      }
    }
  }

  const next = recompute({
    ...found.claim,
    lines: found.claim.lines.map((l) => (l.id === line.id ? { ...l, evidenceRefs: refs } : l)),
  });
  return saveMutated(deps, begin.doc, begin.doc.claims.map((c) => (c.id === next.id ? next : c)), next);
}

// ── Attachments (variations / dayworks — AC7, by link) ───────────────────────

const ATTACHABLE_VARIATION_STATUSES = new Set(["approved", "invoiced"]);
const ATTACHABLE_DAYWORK_STATUSES = new Set(["signed", "invoiced"]);

async function resolveAttachment(
  deps: ClaimsStoreDeps,
  jobId: string,
  kind: "variation" | "daywork",
  id: string,
): Promise<{ ok: true; attachment: ClaimAttachment } | ClaimsFailure> {
  if (kind === "variation") {
    const raw = await deps.loadVariations(jobId);
    const parsed = VariationsDocSchema.safeParse(raw ?? {});
    const rec = (parsed.success ? parsed.data.claims : []).find((v) => v.id === id);
    if (!rec) return fail(422, "record_not_found", "Variation not found on this job.");
    const status = typeof rec.status === "string" ? rec.status : "";
    if (!ATTACHABLE_VARIATION_STATUSES.has(status)) {
      return fail(422, "not_attachable", "Only an APPROVED variation can attach to a claim.");
    }
    const valueCents = typeof rec.valueCents === "number" && Number.isInteger(rec.valueCents) ? rec.valueCents : null;
    if (valueCents == null) {
      return fail(422, "not_attachable", "This variation has no recorded value yet — set its value first.");
    }
    return {
      ok: true,
      attachment: {
        kind: "variation",
        id,
        ref: typeof rec.ref === "string" ? rec.ref : null,
        label: typeof rec.scope === "string" ? rec.scope : "Variation",
        valueCents,
      },
    };
  }
  const raw = await deps.loadDayworks(jobId);
  const parsed = DayworksDocSchema.safeParse(raw ?? {});
  const rec = (parsed.success ? parsed.data.dockets : []).find((d) => d.id === id);
  if (!rec) return fail(422, "record_not_found", "Daywork docket not found on this job.");
  const status = typeof rec.status === "string" ? rec.status : "";
  if (!ATTACHABLE_DAYWORK_STATUSES.has(status)) {
    return fail(422, "not_attachable", "Only a SIGNED daywork docket can attach to a claim.");
  }
  return {
    ok: true,
    attachment: {
      kind: "daywork",
      id,
      ref: typeof rec.ref === "string" ? rec.ref : null,
      label: typeof rec.description === "string" ? rec.description : "Daywork docket",
      // Dockets are labour records with no priced value — attached as support,
      // never an invented amount (P7).
      valueCents: null,
    },
  };
}

export async function attachRecord(
  deps: ClaimsStoreDeps,
  input: {
    jobId: string;
    expectedRevision: string;
    claimId: string;
    kind: "variation" | "daywork";
    recordId: string;
  },
): Promise<ClaimsResult> {
  const begin = await beginMutation(deps, input.jobId, input.expectedRevision);
  if (!begin.ok) return begin;
  const found = findDraft(begin.doc, input.claimId);
  if (!found.ok) return found;
  // A money record attaches to at most ONE claim (any status) — attaching the
  // same variation to two claims would double-claim it.
  const clash = begin.doc.claims.find((c) =>
    c.attachments.some((a) => a.kind === input.kind && a.id === input.recordId),
  );
  if (clash) {
    return fail(409, "already_attached", `Already attached to Claim ${clash.number}.`);
  }
  const resolved = await resolveAttachment(deps, input.jobId, input.kind, input.recordId);
  if (!resolved.ok) return resolved;
  const next = recompute({
    ...found.claim,
    attachments: [...found.claim.attachments, resolved.attachment],
  });
  return saveMutated(deps, begin.doc, begin.doc.claims.map((c) => (c.id === next.id ? next : c)), next);
}

export async function detachRecord(
  deps: ClaimsStoreDeps,
  input: {
    jobId: string;
    expectedRevision: string;
    claimId: string;
    kind: "variation" | "daywork";
    recordId: string;
  },
): Promise<ClaimsResult> {
  const begin = await beginMutation(deps, input.jobId, input.expectedRevision);
  if (!begin.ok) return begin;
  const found = findDraft(begin.doc, input.claimId);
  if (!found.ok) return found;
  const next = recompute({
    ...found.claim,
    attachments: found.claim.attachments.filter(
      (a) => !(a.kind === input.kind && a.id === input.recordId),
    ),
  });
  return saveMutated(deps, begin.doc, begin.doc.claims.map((c) => (c.id === next.id ? next : c)), next);
}

// ── Submit (freeze) ──────────────────────────────────────────────────────────

export async function submitClaim(
  deps: ClaimsStoreDeps,
  input: { jobId: string; expectedRevision: string; claimId: string; at: string; by: string | null },
): Promise<ClaimsResult> {
  const begin = await beginMutation(deps, input.jobId, input.expectedRevision);
  if (!begin.ok) return begin;
  const found = findDraft(begin.doc, input.claimId);
  if (!found.ok) return found;

  const fresh = recompute(found.claim);
  const blockers = validateForSubmit(fresh);
  if (blockers.length > 0) {
    return fail(422, "submit_blocked", "This claim can't be submitted yet.", { blockers });
  }

  // Re-verify attachments against the LIVE source records at freeze time — a
  // variation that lost its approval since attach must not freeze into money.
  const attachments: ClaimAttachment[] = [];
  for (const a of fresh.attachments) {
    const resolved = await resolveAttachment(deps, input.jobId, a.kind, a.id);
    if (!resolved.ok) {
      return fail(
        422,
        "not_attachable",
        `${a.kind === "variation" ? "Variation" : "Daywork"} ${a.ref ?? a.id} is no longer attachable — detach it or fix the source record.`,
      );
    }
    attachments.push(resolved.attachment);
  }

  const withAtt = recompute({ ...fresh, attachments });
  const submitted: ProgressClaim = {
    ...withAtt,
    status: "submitted",
    submittedAt: input.at,
    submittedBy: input.by,
    evidenceManifest: {
      generatedAt: input.at,
      entries: withAtt.lines.map((l) => ({
        lineId: l.id,
        sourceKey: l.sourceKey,
        refs: l.evidenceRefs,
      })),
    },
  };
  return saveMutated(
    deps,
    begin.doc,
    begin.doc.claims.map((c) => (c.id === submitted.id ? submitted : c)),
    submitted,
  );
}

// ── Manual status (certified / paid) ─────────────────────────────────────────

export async function setClaimStatus(
  deps: ClaimsStoreDeps,
  input: {
    jobId: string;
    expectedRevision: string;
    claimId: string;
    to: ProgressClaimStatus;
    certifiedValueCents?: number | null;
    certifiedRef?: string | null;
    paidRef?: string | null;
    at: string;
  },
): Promise<ClaimsResult> {
  const begin = await beginMutation(deps, input.jobId, input.expectedRevision);
  if (!begin.ok) return begin;
  const claim = begin.doc.claims.find((c) => c.id === input.claimId);
  if (!claim) return fail(404, "claim_not_found", "Claim not found.");
  if (!canTransition(claim.status, input.to)) {
    return fail(409, "invalid_transition", `Cannot move a ${claim.status} claim to ${input.to}.`);
  }
  let next: ProgressClaim = { ...claim, status: input.to };
  if (input.to === "certified") {
    if (
      input.certifiedValueCents == null ||
      !Number.isInteger(input.certifiedValueCents) ||
      input.certifiedValueCents < 0
    ) {
      return fail(400, "bad_input", "certifiedValueCents (non-negative integer cents) is required to certify.");
    }
    next = {
      ...next,
      certifiedValueCents: input.certifiedValueCents,
      certifiedRef: input.certifiedRef?.trim() || null,
      certifiedAt: input.at,
    };
  }
  if (input.to === "paid") {
    next = { ...next, paidRef: input.paidRef?.trim() || null, paidAt: input.at };
  }
  return saveMutated(deps, begin.doc, begin.doc.claims.map((c) => (c.id === next.id ? next : c)), next);
}

export async function deleteDraftClaim(
  deps: ClaimsStoreDeps,
  input: { jobId: string; expectedRevision: string; claimId: string },
): Promise<ClaimsResult> {
  const begin = await beginMutation(deps, input.jobId, input.expectedRevision);
  if (!begin.ok) return begin;
  const found = findDraft(begin.doc, input.claimId);
  if (!found.ok) return found;
  return saveMutated(
    deps,
    begin.doc,
    begin.doc.claims.filter((c) => c.id !== input.claimId),
    null,
  );
}

// ── Read view ────────────────────────────────────────────────────────────────

export interface ClaimLineReference {
  workPackageId: string;
  tasksComplete: number;
  tasksTotal: number;
}

export interface LinkableRecord {
  kind: "evidence" | "itp";
  id: string;
  label: string;
}

export interface AttachableRecord {
  kind: "variation" | "daywork";
  id: string;
  ref: string | null;
  label: string;
  valueCents: number | null;
  attachedToClaimNumber: number | null;
}

export interface ClaimsView {
  ok: true;
  jobId: string;
  jobName: string | null;
  revision: string;
  claims: ProgressClaim[];
  derived: {
    claimedToDateCents: number;
    oldestUnpaidDays: number | null;
    /** The hand-set jobs.json scalar (dollars → cents) for drift visibility;
     *  null when unset. */
    scalarClaimedToDateCents: number | null;
    contractValueCents: number | null;
    certifiedVarianceByClaimId: Record<string, number | null>;
  };
  seed: {
    /** What a NEW claim would seed from right now. */
    source: "quote" | "packages" | "blank";
    quoteId: string | null;
  };
  /** Reference completion per work package (#198-consistent single reference —
   *  shown ALONGSIDE the admin-entered percent, never a competing auto-%). */
  references: ClaimLineReference[];
  linkable: LinkableRecord[];
  attachable: AttachableRecord[];
}

export type ClaimsViewResult = ClaimsView | ClaimsFailure;

/** Dwellings task-state truthiness: `dwellings[areaId][stage].tasks[taskId] ===
 *  'complete'` (the api/_lib/ai-tools.js convention). */
function packageCompletion(
  dwellings: Record<string, unknown>,
  taskRefs: ReadonlyArray<{ areaId: string; stage: string; taskId: string }>,
): { tasksComplete: number; tasksTotal: number } {
  let done = 0;
  for (const ref of taskRefs) {
    const area = dwellings[ref.areaId];
    if (!area || typeof area !== "object") continue;
    const stage = (area as Record<string, unknown>)[ref.stage];
    if (!stage || typeof stage !== "object") continue;
    const tasks = (stage as Record<string, unknown>).tasks;
    if (!tasks || typeof tasks !== "object") continue;
    if ((tasks as Record<string, unknown>)[ref.taskId] === "complete") done++;
  }
  return { tasksComplete: done, tasksTotal: taskRefs.length };
}

export async function readClaimsView(
  deps: ClaimsStoreDeps,
  jobId: string,
  nowIso: string,
): Promise<ClaimsViewResult> {
  const job = await deps.loadJob(jobId);
  if (!job) return fail(404, "job_not_found", "Job not found.");
  const loaded = await loadParsedDoc(deps, jobId);
  if (!loaded.ok) return loaded;

  const [spineRaw, dataRaw, itpsRaw, variationsRaw, dayworksRaw] = await Promise.all([
    deps.loadSpine(jobId),
    deps.loadJobData(jobId),
    deps.loadItps(jobId),
    deps.loadVariations(jobId),
    deps.loadDayworks(jobId),
  ]);
  const spine = SpineSchema.safeParse(spineRaw ?? {});
  const data = JobDataSchema.safeParse(dataRaw ?? {});
  const itps = ItpsDocSchema.safeParse(itpsRaw ?? {});
  const variations = VariationsDocSchema.safeParse(variationsRaw ?? {});
  const dayworks = DayworksDocSchema.safeParse(dayworksRaw ?? {});

  // Drafts render with freshly recomputed values (the source stays whatever
  // was stored; submitted claims render their frozen snapshot untouched).
  const claims = loaded.doc.claims.map((c) => (c.status === "draft" ? recompute(c) : c));

  const workPackages = spine.success ? spine.data.workPackages : [];
  const dwellings = data.success ? (data.data.dwellings as Record<string, unknown>) : {};
  const references: ClaimLineReference[] = workPackages
    .filter((wp) => wp.taskRefs.length > 0)
    .map((wp) => ({ workPackageId: wp.id, ...packageCompletion(dwellings, wp.taskRefs) }));

  const linkable: LinkableRecord[] = [
    ...(data.success ? data.data.evidence : []).map((e) => {
      const note = typeof e.note === "string" && e.note.trim() ? e.note.trim() : null;
      const kind = typeof e.kind === "string" ? e.kind : "evidence";
      return { kind: "evidence" as const, id: e.id, label: note ?? (kind === "photo" ? "Photo" : "Note") };
    }),
    ...(itps.success ? itps.data.instances : []).map((i) => {
      const snap = i.templateSnapshot as { name?: unknown } | undefined;
      const name = snap && typeof snap.name === "string" ? snap.name : "ITP";
      const status = typeof i.status === "string" ? i.status : "unknown";
      return { kind: "itp" as const, id: i.id, label: `${name} (${status})` };
    }),
  ];

  const attachedTo = new Map<string, number>();
  for (const c of claims) {
    for (const a of c.attachments) attachedTo.set(`${a.kind}:${a.id}`, c.number);
  }
  const attachable: AttachableRecord[] = [
    ...(variations.success ? variations.data.claims : [])
      .filter(
        (v) =>
          ATTACHABLE_VARIATION_STATUSES.has(typeof v.status === "string" ? v.status : "") &&
          // Attach validation demands a recorded value — don't offer what
          // would be rejected (an unpriced variation is fixed at its source).
          typeof v.valueCents === "number" &&
          Number.isInteger(v.valueCents),
      )
      .map((v) => ({
        kind: "variation" as const,
        id: v.id,
        ref: typeof v.ref === "string" ? v.ref : null,
        label: typeof v.scope === "string" ? v.scope : "Variation",
        valueCents: typeof v.valueCents === "number" && Number.isInteger(v.valueCents) ? v.valueCents : null,
        attachedToClaimNumber: attachedTo.get(`variation:${v.id}`) ?? null,
      })),
    ...(dayworks.success ? dayworks.data.dockets : [])
      .filter((d) => ATTACHABLE_DAYWORK_STATUSES.has(typeof d.status === "string" ? d.status : ""))
      .map((d) => ({
        kind: "daywork" as const,
        id: d.id,
        ref: typeof d.ref === "string" ? d.ref : null,
        label: typeof d.description === "string" ? d.description : "Daywork docket",
        valueCents: null,
        attachedToClaimNumber: attachedTo.get(`daywork:${d.id}`) ?? null,
      })),
  ];

  const fromQuoteId = typeof job.fromQuoteId === "string" ? job.fromQuoteId : null;
  let seedSource: ClaimsView["seed"]["source"] = "blank";
  if (fromQuoteId) seedSource = "quote";
  else if (workPackages.length > 0) seedSource = "packages";

  const scalarClaimed = typeof job.claimedToDate === "number" && Number.isFinite(job.claimedToDate)
    ? Math.round(job.claimedToDate * 100)
    : null;
  const contractValueCents = typeof job.contractValue === "number" && Number.isFinite(job.contractValue)
    ? Math.round(job.contractValue * 100)
    : null;

  return {
    ok: true,
    jobId,
    jobName: typeof job.name === "string" ? job.name : null,
    revision: claimsRevisionOf(loaded.doc),
    claims,
    derived: {
      claimedToDateCents: deriveClaimedToDateCents(claims),
      oldestUnpaidDays: oldestUnpaidClaimDays(claims, nowIso),
      scalarClaimedToDateCents: scalarClaimed,
      contractValueCents,
      certifiedVarianceByClaimId: Object.fromEntries(
        claims.map((c) => [c.id, certifiedVarianceCents(c)]),
      ),
    },
    seed: { source: seedSource, quoteId: fromQuoteId },
    references,
    linkable,
    attachable,
  };
}
