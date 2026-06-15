import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import {
  ClassificationsInputSchema,
  authorizeAdmin,
  blobReconciliationDeps,
  runReconciliationConfirm,
} from "@/server/job-control/reconciliation-producer";

/**
 * POST /api/job-control/reconciliation/confirm — L0 reconciliation producer
 * (ADR: docs/architecture/job-control-runtime-adr.md).
 *
 * Admin-only. Persists the confirmed `ScopeReconciliation` to
 * `jobs/<jobId>/scope-reconciliation.json`. When a `sourceHash` is supplied it
 * is checked against the current scope and a stale confirm is rejected (409).
 * It compiles NOTHING and writes NO `jobs/<jobId>/job-control.json` (that is L1).
 *
 * AUTH LIMITATION (see the ADR): this reuses the same unverified cookie-decode
 * gate as the runtime-check route. Because this route WRITES, it should be
 * hardened to the authoritative HMAC-verified `verifyViaApi()` check before it
 * is trusted as a production mutation. Tracked as a follow-up.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  jobId: z.string().min(1),
  sourceHash: z.string().min(1).optional(),
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

  const result = await runReconciliationConfirm(blobReconciliationDeps(), {
    jobId: body.data.jobId,
    classifications: body.data.classifications,
    expectedSourceHash: body.data.sourceHash ?? null,
    confirmedBy: session?.userId ?? session?.sub ?? session?.username ?? null,
    at: new Date().toISOString(),
  });
  if (!result.ok) return NextResponse.json(result, { status: result.status });
  return NextResponse.json(result, { status: 200 });
}
