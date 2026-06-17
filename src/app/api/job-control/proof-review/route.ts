import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import {
  ProofReviewRequestSchema,
  blobProofReviewDeps,
  writeProofReview,
} from "@/server/job-control/proof-review";

/**
 * POST /api/job-control/proof-review — the proof review lifecycle writer.
 *
 * Writes a `ProofReview` into `jobs/<jobId>/job-control.json`'s `proofReviews`:
 *   - action=submit  → a worker sends a work package's captured proof for review
 *     (server re-verifies every required item is met). FIELD-gated:
 *     canAccessSurface(role,'phil') + the existing job-assignment gate.
 *   - action=approve|reject → an admin signs off / sends back (with a reason).
 *     ADMIN-gated: canAccessSurface(role,'admin').
 *
 * Mirrors the evidence-link route: same auth shape, same job-access reuse of
 * `/api/jobs?id=`, same mandatory `expectedJobControlRevision` stale-write guard.
 * It touches ONLY the artifact's `proofReviews`; it changes no task state, no ITP
 * sign-off, no captured proof.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = ProofReviewRequestSchema.extend({
  jobId: z.string().min(1),
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
      { ok: false, error: "jobId, action, workPackageId and expectedJobControlRevision are required" },
      { status: 400 },
    );
  }

  // Submit is a field action; approve/reject are admin actions.
  if (body.data.action === "submit") {
    if (!canAccessSurface(session.role, "phil")) {
      return NextResponse.json({ ok: false, error: "Not a field surface" }, { status: 403 });
    }
  } else if (!canAccessSurface(session.role, "admin")) {
    return NextResponse.json({ ok: false, error: "Approve/reject is admin-only" }, { status: 403 });
  }

  // Job-access: reuse the existing assignment gate (api/jobs 403s the unassigned;
  // admins/office pass it for any job they can manage).
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
      return NextResponse.json({ ok: false, error: "No access to this job" }, { status: 403 });
    }
    if (!jobRes.ok) {
      return NextResponse.json({ ok: false, error: "Could not verify job access" }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ ok: false, error: "Could not verify job access" }, { status: 502 });
  }

  const result = await writeProofReview(blobProofReviewDeps(), {
    jobId: body.data.jobId,
    request: {
      action: body.data.action,
      workPackageId: body.data.workPackageId,
      reason: body.data.reason ?? null,
    },
    expectedRevision: body.data.expectedJobControlRevision,
    at: new Date().toISOString(),
    actor: session.userId ?? session.sub ?? null,
  });
  return NextResponse.json(result, { status: result.status });
}
