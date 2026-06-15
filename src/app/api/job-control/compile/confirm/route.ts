import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyViaApi } from "@/lib/auth/session";
import { blobCompileDeps, confirmCompileAuthorized } from "@/server/job-control/compile-producer";

/**
 * POST /api/job-control/compile/confirm — L1 compile producer
 * (ADR: docs/architecture/job-control-runtime-adr.md).
 *
 * Admin-only WRITE. Persists the compiled artifact to
 * `jobs/<jobId>/job-control.json` (work packages + provenance; preserves any
 * claim/closeout/evidence arrays already there). When a `sourceHash` is supplied
 * it is checked against the current reconciliation+structure and a stale confirm
 * is rejected (409). Mutates no job tasks; does not touch Phil.
 *
 * AUTH: because this route mutates, it uses the ADR-required AUTHORITATIVE
 * HMAC-verified check (`verifyViaApi` → /api/auth?action=me), NOT the unverified
 * cookie decode. A forged/unsigned cookie cannot reach the write. (The read-only
 * preview route keeps the lighter cookie-decode gate.)
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  jobId: z.string().min(1),
  sourceHash: z.string().min(1).optional(),
  /** Optional artifact-revision precondition — reject if job-control.json moved
   *  since it was read (e.g. an evidence-link append). Optional for now. */
  expectedJobControlRevision: z.string().min(1).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const body = BodySchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json({ ok: false, error: "jobId is required" }, { status: 400 });
  }

  const cookieHeader = (await headers()).get("cookie") ?? "";
  const baseUrl = new URL(req.url).origin;

  const result = await confirmCompileAuthorized(
    blobCompileDeps(),
    { cookieHeader, baseUrl, verify: verifyViaApi },
    {
      jobId: body.data.jobId,
      expectedSourceHash: body.data.sourceHash ?? null,
      expectedRevision: body.data.expectedJobControlRevision ?? null,
      at: new Date().toISOString(),
    },
  );
  if (!result.ok) return NextResponse.json(result, { status: result.status });
  return NextResponse.json(result, { status: 200 });
}
