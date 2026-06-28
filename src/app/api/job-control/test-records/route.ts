import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import { TestRecordInputSchema, type TestRecord } from "@/domains/test-records/schema";
import {
  blobTestRecordDeps,
  readTestRecords,
  writeTestRecord,
} from "@/server/test-records/store";
import { mintTestResultEvidence } from "@/server/test-records/evidence-bridge";

/**
 * /api/job-control/test-records — structured electrical TestRecords (#517).
 *
 *   POST → create a TestRecord: derive pass/fail SERVER-SIDE, append to
 *          `jobs/<jobId>/test-records.json`, then mint a companion `test_result`
 *          EvidenceItem (via api/evidence.js) so the EXISTING evidence-link
 *          writer + `isRequiredEvidenceMet` flip a `test_result` required-evidence
 *          item to met — UNCHANGED. Returns `{ record, evidenceId }`.
 *   GET  ?jobId= → list a job's records for admin review (AC2).
 *
 * EXTEND, NEVER FORK (the key #517 decision): a TestRecord satisfies its
 * required-evidence item by minting a REAL EvidenceItem (kind `test_result`), so
 * the proof loop's single source of truth (`validateEvidenceLink` /
 * `isRequiredEvidenceMet` / `loadJobProofIds`) is touched in ZERO places. No
 * `testRecordId` arm was added to EvidenceLink.
 *
 * FIELD-gated POST exactly like the evidence-link route: 401 with no session, 403
 * for a non-Phil surface, then the existing `/api/jobs?id=` assignment gate (403s
 * a worker not assigned to the job). GET additionally allows the admin tier
 * (cross-checked review). force-dynamic + nodejs runtime.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resolve the internal base URL from the forwarded host headers (mirrors the
 *  evidence-link route — lets server→server fetches reuse the cookie gate). */
async function internalBase(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

/** Reuse the existing job-assignment gate: `/api/jobs?id=` 403s/404s a worker not
 *  assigned to the job. Returns null when access is OK, or a NextResponse to
 *  return otherwise. */
async function assertJobAccess(
  jobId: string,
  cookieValue: string | undefined,
): Promise<NextResponse | null> {
  const base = await internalBase();
  try {
    const jobRes = await fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, {
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
  return null;
}

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
  const parsed = TestRecordInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "jobId, tester, testedAt and at least one circuit row are required" },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // Job-access: reuse the existing assignment gate (api/jobs 403s the unassigned).
  const denied = await assertJobAccess(input.jobId, cookieValue);
  if (denied) return denied;

  const result = await writeTestRecord(blobTestRecordDeps(), {
    jobId: input.jobId,
    record: input,
    at: new Date().toISOString(),
    createdBy: session.userId ?? session.sub ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.warning, reason: result.reason }, { status: result.status });
  }

  // Mint the companion `test_result` EvidenceItem so the EXISTING proof loop can
  // mark the requirement met (extend, never fork). The record itself is already
  // saved; a failed mint returns the record without an evidenceId so the worker
  // can retry the link rather than re-enter the numbers.
  const base = await internalBase();
  const minted = await mintTestResultEvidence({
    base,
    cookieValue,
    record: result.record,
  });

  return NextResponse.json(
    {
      ok: true,
      record: result.record,
      evidenceId: minted.evidenceId,
      ...(minted.evidenceId ? {} : { evidenceWarning: minted.warning }),
    },
    { status: 200 },
  );
}

export async function GET(req: Request): Promise<NextResponse> {
  const store = await cookies();
  const cookieValue = store.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(cookieValue);
  if (!session?.role) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });

  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ ok: false, error: "jobId is required" }, { status: 400 });

  // Admin tier reviews any job's records (AC2); a field worker reads only a job
  // they're assigned to (same assignment gate as the write). A non-admin, non-Phil
  // role (e.g. client) is rejected.
  if (!isAdminRole(session.role)) {
    if (!canAccessSurface(session.role, "phil")) {
      return NextResponse.json({ ok: false, error: "Not allowed" }, { status: 403 });
    }
    const denied = await assertJobAccess(jobId, cookieValue);
    if (denied) return denied;
  }

  const { records }: { records: TestRecord[] } = await readTestRecords(blobTestRecordDeps(), jobId);
  return NextResponse.json({ ok: true, records }, { status: 200 });
}
