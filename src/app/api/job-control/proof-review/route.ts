import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, decodeSessionCookie, verifyViaApi } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { authorizeAdminViaVerify } from "@/server/job-control/reconciliation-producer";
import {
  ProofReviewRequestSchema,
  blobProofReviewDeps,
  writeProofReview,
} from "@/server/job-control/proof-review";
import { append as appendAuditLog } from "../../../../../api/_lib/audit-log.js";

/**
 * POST /api/job-control/proof-review — task-instance proof review/approval (#503).
 *
 * One endpoint, gated by ACTION:
 *   - `submit` is a FIELD write — a worker submits their task's captured proof for
 *     review. Gated by `canAccessSurface(role,'phil')` + the existing
 *     job-assignment gate (reuse `/api/jobs?id=`), so it is no more exposed than
 *     the worker's evidence/evidence-link writes. The writer server-verifies the
 *     task's proof is actually met (never trusts the client).
 *   - `approve` / `reject` are ADMIN actions (sign-off), gated by `authorizeAdmin`,
 *     and the writer enforces the independence rule (the submitter can't approve
 *     their own submission).
 *
 * It touches ONLY the artifact's `proofReviews`; it compiles nothing and mutates
 * no job tasks. Revision-guarded (#469): a stale `expectedJobControlRevision`
 * yields 409.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = ProofReviewRequestSchema.extend({
  jobId: z.string().min(1),
  /** The artifact revision the caller read — the stale-write precondition. */
  expectedJobControlRevision: z.string().min(1),
});

export async function POST(req: Request): Promise<NextResponse> {
  const store = await cookies();
  const cookieValue = store.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(cookieValue);
  if (!session?.role) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const body = BodySchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { ok: false, error: "jobId, action, taskRef and expectedJobControlRevision are required" },
      { status: 400 },
    );
  }

  if (body.data.action === "submit") {
    // Field write — Phil surface + job assignment.
    if (!canAccessSurface(session.role, "phil")) {
      return NextResponse.json({ ok: false, error: "Not a field surface" }, { status: 403 });
    }
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? "http";
    const base = host ? `${proto}://${host}` : "http://localhost:3000";
    try {
      const jobRes = await fetch(`${base}/api/jobs?id=${encodeURIComponent(body.data.jobId)}`, {
        cache: "no-store",
        headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
      });
      if (jobRes.status === 403 || jobRes.status === 404) {
        return NextResponse.json({ ok: false, error: "Not assigned to this job" }, { status: 403 });
      }
      if (!jobRes.ok) {
        return NextResponse.json({ ok: false, error: "Could not verify job access" }, { status: 502 });
      }
    } catch {
      return NextResponse.json({ ok: false, error: "Could not verify job access" }, { status: 502 });
    }
  } else {
    // approve / reject — admin sign-off, HMAC-VERIFIED (parity with the
    // reconciliation/compile confirm routes). The unverified cookie decode is
    // not sufficient to authorize a write: verifyViaApi re-checks the cookie
    // server-side (/api/auth?action=me) so a forged/unsigned cookie can't pass.
    // The decoded session.userId stays the actor for the independence rule — it
    // is trustworthy once the same cookie has verified.
    const h2 = await headers();
    const cookieHeader = h2.get("cookie") ?? "";
    const baseUrl = new URL(req.url).origin;
    const auth = await authorizeAdminViaVerify({ cookieHeader, baseUrl, verify: verifyViaApi });
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const result = await writeProofReview(blobProofReviewDeps(), {
    jobId: body.data.jobId,
    request: {
      action: body.data.action,
      taskRef: body.data.taskRef,
      reason: body.data.reason ?? null,
    },
    expectedRevision: body.data.expectedJobControlRevision,
    at: new Date().toISOString(),
    actor: session.userId ?? session.sub ?? null,
  });

  // Best-effort audit of the office sign-off (#503). The field `submit` path has
  // no office actor and is not audited here. A journal failure never blocks the
  // sign-off (the parent write already succeeded).
  if (result.ok && body.data.action !== "submit" && result.review) {
    try {
      await appendAuditLog({
        action: body.data.action === "approve" ? "proof.approved" : "proof.sent_back",
        actorId: session.userId ?? session.sub ?? "",
        actorName: session.name ?? "",
        actorRole: session.role ?? null,
        jobId: body.data.jobId,
        targetType: "proof_review",
        targetId: result.review.id,
        summary:
          body.data.action === "approve"
            ? "Approved task proof"
            : "Sent task proof back for re-capture",
        metadata: {
          taskRef: body.data.taskRef,
          ...(body.data.reason ? { reason: body.data.reason } : {}),
        },
      });
    } catch {
      /* best-effort — never block the sign-off */
    }
  }

  return NextResponse.json(result, { status: result.status });
}
