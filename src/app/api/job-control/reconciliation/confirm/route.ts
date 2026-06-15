import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyViaApi } from "@/lib/auth/session";
import {
  ClassificationsInputSchema,
  blobReconciliationDeps,
  confirmReconciliationAuthorized,
} from "@/server/job-control/reconciliation-producer";

/**
 * POST /api/job-control/reconciliation/confirm — L0 reconciliation producer
 * (ADR: docs/architecture/job-control-runtime-adr.md).
 *
 * Admin-only WRITE. Persists the confirmed `ScopeReconciliation` to
 * `jobs/<jobId>/scope-reconciliation.json`. When a `sourceHash` is supplied it
 * is checked against the current scope and a stale confirm is rejected (409).
 * It compiles NOTHING and writes NO `jobs/<jobId>/job-control.json` (that is L1).
 *
 * AUTH: because this route mutates, it uses the ADR-required AUTHORITATIVE
 * HMAC-verified check (`verifyViaApi` → /api/auth?action=me), NOT the unverified
 * cookie decode. A forged/unsigned cookie cannot reach the write. (The
 * read-only preview route keeps the lighter cookie-decode gate.)
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  jobId: z.string().min(1),
  sourceHash: z.string().min(1).optional(),
  classifications: ClassificationsInputSchema.optional(),
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
    return NextResponse.json(
      { ok: false, error: "jobId is required; classifications must use known scope classifications" },
      { status: 400 },
    );
  }

  const cookieHeader = (await headers()).get("cookie") ?? "";
  const baseUrl = new URL(req.url).origin;

  const result = await confirmReconciliationAuthorized(
    blobReconciliationDeps(),
    { cookieHeader, baseUrl, verify: verifyViaApi },
    {
      jobId: body.data.jobId,
      classifications: body.data.classifications,
      expectedSourceHash: body.data.sourceHash ?? null,
      at: new Date().toISOString(),
    },
  );
  if (!result.ok) return NextResponse.json(result, { status: result.status });
  return NextResponse.json(result, { status: 200 });
}
