import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import {
  ClassificationsInputSchema,
  authorizeAdmin,
  blobReconciliationDeps,
  runReconciliationPreview,
} from "@/server/job-control/reconciliation-producer";

/**
 * POST /api/job-control/reconciliation/preview — L0 reconciliation producer
 * (ADR: docs/architecture/job-control-runtime-adr.md).
 *
 * Admin-only. Reads the job's real scope clauses, applies any admin
 * classifications, and returns a DRAFT `ScopeReconciliation` with warnings. It
 * persists NOTHING and compiles NOTHING. The confirm route does the write.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  jobId: z.string().min(1),
  classifications: ClassificationsInputSchema.optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  const store = await cookies();
  const session = decodeSessionCookie(store.get(SESSION_COOKIE)?.value);
  const auth = authorizeAdmin(session?.role ?? null);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const body = BodySchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { ok: false, error: "jobId is required; classifications must use known scope classifications" },
      { status: 400 },
    );
  }

  const result = await runReconciliationPreview(blobReconciliationDeps(), {
    jobId: body.data.jobId,
    classifications: body.data.classifications,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json(result, { status: 200 });
}
