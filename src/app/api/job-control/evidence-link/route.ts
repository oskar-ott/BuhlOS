import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import {
  EvidenceLinkRequestSchema,
  blobEvidenceLinkDeps,
  evidenceLinkRequestHasProof,
  writeEvidenceLink,
} from "@/server/job-control/evidence-link";

/**
 * POST /api/job-control/evidence-link — L4 evidence writer
 * (ADR: docs/architecture/job-control-runtime-adr.md).
 *
 * Appends an `EvidenceLink` into `jobs/<jobId>/job-control.json` linking a
 * just-saved proof (evidence/observation) to a compiled required-evidence
 * requirement, so Phil flips that requirement from needed → met. The normal
 * evidence save (`api/evidence.js`) is unchanged and runs first; this is the
 * additive link step.
 *
 * FIELD write (not admin): a worker links their own captured proof. Gated by
 * `canAccessSurface(role,'phil')` + the existing job-assignment gate (re-using
 * `/api/jobs?id=`, which 403s a worker not assigned to the job) — so it is no
 * more exposed than the worker's existing evidence write. It touches ONLY the
 * artifact's `evidenceLinks`; it mutates no job tasks, compiles nothing.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = EvidenceLinkRequestSchema.extend({
  jobId: z.string().min(1),
  /** Required: the artifact revision the caller read (stale-write guard). No UI
   *  caller exists yet, so this is mandatory now to foreclose silent stale writes. */
  expectedJobControlRevision: z.string().min(1),
});

export async function POST(req: Request): Promise<NextResponse> {
  const store = await cookies();
  const cookieValue = store.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(cookieValue);
  if (!session?.role) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  if (!canAccessSurface(session.role, "phil")) {
    return NextResponse.json({ ok: false, error: "Not a field surface" }, { status: 403 });
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
      { ok: false, error: "jobId, workPackageId, requiredEvidenceId and expectedJobControlRevision are required" },
      { status: 400 },
    );
  }
  if (!evidenceLinkRequestHasProof(body.data)) {
    return NextResponse.json({ ok: false, error: "A saved evidenceId or observationId is required" }, { status: 400 });
  }

  // Job-access: reuse the existing assignment gate (api/jobs 403s the unassigned).
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

  const result = await writeEvidenceLink(blobEvidenceLinkDeps(), {
    jobId: body.data.jobId,
    request: {
      workPackageId: body.data.workPackageId,
      requiredEvidenceId: body.data.requiredEvidenceId,
      evidenceId: body.data.evidenceId ?? null,
      observationId: body.data.observationId ?? null,
      role: body.data.role,
    },
    expectedRevision: body.data.expectedJobControlRevision,
    at: new Date().toISOString(),
    createdBy: session.userId ?? session.sub ?? null,
  });
  return NextResponse.json(result, { status: result.status });
}
