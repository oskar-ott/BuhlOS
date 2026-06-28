import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, decodeSessionCookie, verifyViaApi } from "@/lib/auth/session";
import { authorizeAdminViaVerify } from "@/server/job-control/reconciliation-producer";
import {
  CloseoutOpSchema,
  blobCloseoutDeps,
  writeCloseout,
} from "@/server/job-control/closeout-producer";

/**
 * POST /api/job-control/closeout/confirm — closeout matrix WRITE (#374).
 *
 * Admin-only. Applies one add / remove / link / confirm / waive op to a job's
 * `closeoutRequirements[]` on `jobs/<jobId>/job-control.json` (the SPINE — never
 * `jobs/<jobId>/closeout.json`, which is #349). After the op the affected
 * requirement's status is RE-DERIVED from its links + admin confirmation + the
 * live record ids, so `satisfied` always means "a real record resolves AND an
 * admin confirmed" — a dangling link reverts it (the producer enforces this).
 *
 * This route is READ-ONLY with respect to job completion: it never gates or
 * triggers the job's close-out (#349 stays the authority on freezing numbers).
 *
 * AUTH: because this route mutates, it uses the ADR-required AUTHORITATIVE
 * HMAC-verified check (`verifyViaApi` → /api/auth?action=me), NOT the unverified
 * cookie decode. A forged/unsigned cookie cannot reach the write.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  jobId: z.string().min(1),
  /** The artifact revision the caller read — the stale-write precondition. */
  expectedJobControlRevision: z.string().min(1),
  op: CloseoutOpSchema,
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
      { ok: false, error: "jobId, expectedJobControlRevision and a valid op are required" },
      { status: 400 },
    );
  }

  // Admin-only WRITE — HMAC-verified (parity with the reconciliation/compile
  // confirm routes). The unverified cookie decode is not sufficient to authorize
  // a mutation: verifyViaApi re-checks the cookie server-side so a forged/
  // unsigned cookie can't pass. The verified username is the confirm actor.
  const h = await headers();
  const cookieHeader = h.get("cookie") ?? "";
  const baseUrl = new URL(req.url).origin;
  const auth = await authorizeAdminViaVerify({ cookieHeader, baseUrl, verify: verifyViaApi });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const result = await writeCloseout(blobCloseoutDeps(), {
    jobId: body.data.jobId,
    op: body.data.op,
    expectedRevision: body.data.expectedJobControlRevision,
    at: new Date().toISOString(),
    actor: auth.confirmedBy,
  });

  return NextResponse.json(result, { status: result.status });
}
