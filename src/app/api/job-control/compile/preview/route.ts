import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { authorizeAdmin } from "@/server/job-control/reconciliation-producer";
import { blobCompileDeps, runCompilePreview } from "@/server/job-control/compile-producer";

/**
 * POST /api/job-control/compile/preview — L1 compile producer
 * (ADR: docs/architecture/job-control-runtime-adr.md).
 *
 * Admin-only, read-only. Reads the confirmed `ScopeReconciliation` + job
 * structure, runs the pure compiler, diffs against any existing
 * `job-control.json`, and returns a DRAFT compile result with gaps. Persists
 * NOTHING and mutates no job tasks. The confirm route does the write.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ jobId: z.string().min(1) });

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
    return NextResponse.json({ ok: false, error: "jobId is required" }, { status: 400 });
  }

  const result = await runCompilePreview(blobCompileDeps(), { jobId: body.data.jobId });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, code: result.code }, { status: result.status });
  }
  return NextResponse.json(result, { status: 200 });
}
