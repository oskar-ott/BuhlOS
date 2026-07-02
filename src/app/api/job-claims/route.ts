import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, decodeSessionCookie, verifyViaApi } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { authorizeAdminViaVerify } from "@/server/job-control/reconciliation-producer";
import {
  addManualLine,
  attachRecord,
  blobClaimsDeps,
  createClaim,
  deleteDraftClaim,
  detachRecord,
  linkEvidence,
  readClaimsView,
  removeLine,
  setClaimStatus,
  submitClaim,
  updateClaimMeta,
  updateLine,
  type ClaimsResult,
} from "@/server/progress-claims/store";
import {
  deriveClaimedToDateCents,
  oldestUnpaidClaimDays,
} from "@/domains/progress-claims/math";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { append as appendAuditLog } from "../../../../api/_lib/audit-log.js";

/**
 * /api/job-claims — per-job progress claims (#372). ADMIN-TIER, flag-dark
 * behind `progress_claims` (a dark flag 404s, never 403s — the surface stays
 * invisible until proven on a preview deploy).
 *
 *   GET  ?jobId=<id>          → the claims register view (claims + derived
 *                               rollups + seed/linkable/attachable records)
 *   POST { action, jobId, expectedRevision, … }
 *        create | update-claim | update-line | add-line | remove-line |
 *        link-evidence | attach | detach | submit | set-status | delete-draft
 *
 * AUTH (job-control runtime ADR): the GET uses the cookie decode + admin-tier
 * surface gate; every MUTATION uses the authoritative HMAC-verified check
 * (`verifyViaApi` → /api/auth?action=me) — a forged cookie cannot reach a
 * write. Every mutation carries `expectedRevision` (stale-write 409).
 *
 * After a submit / status change, the job's `claimedToDate` +
 * `oldestClaimDays` scalars become DERIVED: this route forwards ONE batched
 * PUT through the guarded legacy jobs writer (api/jobs.js — validation, #157
 * write guards, job audit) rather than raw-writing the monolith. Best-effort:
 * the claim record is the source of truth; a failed rollup is reported as a
 * warning, never a lost claim.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EvidenceAddSchema = z.object({ kind: z.enum(["evidence", "itp"]), id: z.string().min(1) });

const BodySchema = z.object({
  action: z.enum([
    "create",
    "update-claim",
    "update-line",
    "add-line",
    "remove-line",
    "link-evidence",
    "attach",
    "detach",
    "submit",
    "set-status",
    "delete-draft",
  ]),
  jobId: z.string().min(1),
  expectedRevision: z.string().min(1),
  claimId: z.string().min(1).optional(),
  lineId: z.string().min(1).optional(),
  periodLabel: z.string().max(80).nullable().optional(),
  thisPctBp: z.number().int().optional(),
  overClaimOverride: z.boolean().optional(),
  description: z.string().max(500).optional(),
  contractValueCents: z.number().int().nullable().optional(),
  add: z.array(EvidenceAddSchema).max(50).optional(),
  removeIds: z.array(z.string()).max(50).optional(),
  kind: z.enum(["variation", "daywork"]).optional(),
  recordId: z.string().min(1).optional(),
  to: z.enum(["certified", "paid"]).optional(),
  certifiedValueCents: z.number().int().nullable().optional(),
  certifiedRef: z.string().max(120).nullable().optional(),
  paidRef: z.string().max(120).nullable().optional(),
});

export async function GET(req: Request): Promise<NextResponse> {
  const store = await cookies();
  const session = decodeSessionCookie(store.get(SESSION_COOKIE)?.value);
  if (!session?.role) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  if (!canAccessSurface(session.role, "admin")) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }
  if (!(await isFlagEnabled("progress_claims", session))) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  const jobId = new URL(req.url).searchParams.get("jobId") ?? "";
  if (!jobId) return NextResponse.json({ ok: false, error: "jobId required" }, { status: 400 });

  const view = await readClaimsView(blobClaimsDeps(), jobId, new Date().toISOString());
  if (!view.ok) return NextResponse.json(view, { status: view.status });
  return NextResponse.json(view, { status: 200 });
}

export async function POST(req: Request): Promise<NextResponse> {
  const store = await cookies();
  const cookieValue = store.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(cookieValue);
  // Dark-flag check first (unverified decode is fine for a 404-vs-404 decision).
  if (!session?.role || !(await isFlagEnabled("progress_claims", session))) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const body = BodySchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { ok: false, error: "action, jobId and expectedRevision are required" },
      { status: 400 },
    );
  }
  const b = body.data;

  // Authoritative admin gate for the WRITE (ADR: mutations use the
  // HMAC-verified check, never the unverified cookie decode).
  const h = await headers();
  const baseUrl = new URL(req.url).origin;
  const auth = await authorizeAdminViaVerify({
    cookieHeader: h.get("cookie") ?? "",
    baseUrl,
    verify: verifyViaApi,
  });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const deps = blobClaimsDeps();
  const at = new Date().toISOString();
  const by = auth.confirmedBy;
  const need = (field: "claimId" | "lineId" | "kind" | "recordId" | "to"): NextResponse =>
    NextResponse.json({ ok: false, error: `${field} is required for ${b.action}` }, { status: 400 });

  let result: ClaimsResult;
  switch (b.action) {
    case "create":
      result = await createClaim(deps, {
        jobId: b.jobId,
        expectedRevision: b.expectedRevision,
        periodLabel: b.periodLabel ?? null,
        at,
        by,
      });
      break;
    case "update-claim":
      if (!b.claimId) return need("claimId");
      result = await updateClaimMeta(deps, {
        jobId: b.jobId,
        expectedRevision: b.expectedRevision,
        claimId: b.claimId,
        periodLabel: b.periodLabel ?? null,
      });
      break;
    case "update-line":
      if (!b.claimId) return need("claimId");
      if (!b.lineId) return need("lineId");
      result = await updateLine(deps, {
        jobId: b.jobId,
        expectedRevision: b.expectedRevision,
        claimId: b.claimId,
        lineId: b.lineId,
        thisPctBp: b.thisPctBp,
        overClaimOverride: b.overClaimOverride,
        description: b.description,
        contractValueCents: b.contractValueCents,
      });
      break;
    case "add-line":
      if (!b.claimId) return need("claimId");
      result = await addManualLine(deps, {
        jobId: b.jobId,
        expectedRevision: b.expectedRevision,
        claimId: b.claimId,
        description: b.description ?? "",
        contractValueCents: b.contractValueCents ?? null,
      });
      break;
    case "remove-line":
      if (!b.claimId) return need("claimId");
      if (!b.lineId) return need("lineId");
      result = await removeLine(deps, {
        jobId: b.jobId,
        expectedRevision: b.expectedRevision,
        claimId: b.claimId,
        lineId: b.lineId,
      });
      break;
    case "link-evidence":
      if (!b.claimId) return need("claimId");
      if (!b.lineId) return need("lineId");
      result = await linkEvidence(deps, {
        jobId: b.jobId,
        expectedRevision: b.expectedRevision,
        claimId: b.claimId,
        lineId: b.lineId,
        add: b.add,
        removeIds: b.removeIds,
      });
      break;
    case "attach":
      if (!b.claimId) return need("claimId");
      if (!b.kind) return need("kind");
      if (!b.recordId) return need("recordId");
      result = await attachRecord(deps, {
        jobId: b.jobId,
        expectedRevision: b.expectedRevision,
        claimId: b.claimId,
        kind: b.kind,
        recordId: b.recordId,
      });
      break;
    case "detach":
      if (!b.claimId) return need("claimId");
      if (!b.kind) return need("kind");
      if (!b.recordId) return need("recordId");
      result = await detachRecord(deps, {
        jobId: b.jobId,
        expectedRevision: b.expectedRevision,
        claimId: b.claimId,
        kind: b.kind,
        recordId: b.recordId,
      });
      break;
    case "submit":
      if (!b.claimId) return need("claimId");
      result = await submitClaim(deps, {
        jobId: b.jobId,
        expectedRevision: b.expectedRevision,
        claimId: b.claimId,
        at,
        by,
      });
      break;
    case "set-status":
      if (!b.claimId) return need("claimId");
      if (!b.to) return need("to");
      result = await setClaimStatus(deps, {
        jobId: b.jobId,
        expectedRevision: b.expectedRevision,
        claimId: b.claimId,
        to: b.to,
        certifiedValueCents: b.certifiedValueCents,
        certifiedRef: b.certifiedRef,
        paidRef: b.paidRef,
        at,
      });
      break;
    case "delete-draft":
      if (!b.claimId) return need("claimId");
      result = await deleteDraftClaim(deps, {
        jobId: b.jobId,
        expectedRevision: b.expectedRevision,
        claimId: b.claimId,
      });
      break;
  }

  if (!result.ok) return NextResponse.json(result, { status: result.status });

  // Best-effort cross-surface audit journal (submit + money-status changes are
  // the money-facing events; a journal failure never blocks the claim write).
  if ((b.action === "create" || b.action === "submit" || b.action === "set-status") && result.claim) {
    const summary =
      b.action === "create"
        ? `Created draft progress claim ${result.claim.number}`
        : b.action === "submit"
          ? `Submitted progress claim ${result.claim.number}`
          : `Progress claim ${result.claim.number} marked ${b.to}`;
    try {
      await appendAuditLog({
        action:
          b.action === "create"
            ? "claim.created"
            : b.action === "submit"
              ? "claim.submitted"
              : "claim.status_changed",
        actorId: session.userId ?? session.sub ?? "",
        actorName: session.name ?? by ?? "",
        actorRole: session.role ?? null,
        jobId: b.jobId,
        targetType: "claim",
        targetId: result.claim.id,
        summary,
        metadata: {
          claimNumber: result.claim.number,
          thisClaimValueCents: result.claim.totals.thisClaimValueCents,
          toDateValueCents: result.claim.totals.toDateValueCents,
          ...(b.to ? { to: b.to } : {}),
        },
      });
    } catch {
      /* best-effort */
    }
  }

  // Derived rollup (AC4): after a submit or a money-status change, the job's
  // claimedToDate / oldestClaimDays scalars are derived from claim records via
  // ONE batched PUT through the guarded legacy jobs writer.
  let rollupWarning: string | null = null;
  if (b.action === "submit" || b.action === "set-status") {
    const claimedToDateCents = deriveClaimedToDateCents(result.doc.claims);
    const oldestDays = oldestUnpaidClaimDays(result.doc.claims, at);
    try {
      const res = await fetch(`${baseUrl}/api/jobs`, {
        method: "PUT",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          cookie: h.get("cookie") ?? "",
        },
        body: JSON.stringify({
          id: b.jobId,
          claimedToDate: claimedToDateCents / 100,
          oldestClaimDays: oldestDays ?? null,
        }),
      });
      if (!res.ok) rollupWarning = `Claim saved, but the job's claimed-to-date rollup failed (jobs API ${res.status}).`;
    } catch {
      rollupWarning = "Claim saved, but the job's claimed-to-date rollup could not be written.";
    }
  }

  return NextResponse.json(
    { ok: true, revision: result.revision, claim: result.claim, ...(rollupWarning ? { rollupWarning } : {}) },
    { status: 200 },
  );
}
