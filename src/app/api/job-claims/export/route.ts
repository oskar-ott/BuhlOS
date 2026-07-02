import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { blobClaimsDeps, readClaimsView } from "@/server/progress-claims/store";
import { claimCsvFilename, claimToCsv } from "@/domains/progress-claims/csv";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";

/**
 * GET /api/job-claims/export?jobId=<id>&claimId=<id> — the Payapps-ready CSV
 * (#372 AC5): line ref, description, contract value, prev %, this %, this
 * value, to-date value. Deterministic (built from the stored claim snapshot),
 * downloaded for KEYING INTO Payapps — no Payapps API here and the file never
 * claims it was uploaded. A draft exports with a DRAFT marker in the filename
 * and totals row.
 *
 * Admin-tier + `progress_claims` flag-dark, matching the register route.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const store = await cookies();
  const session = decodeSessionCookie(store.get(SESSION_COOKIE)?.value);
  if (!session?.role) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  if (!canAccessSurface(session.role, "admin")) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }
  if (!(await isFlagEnabled("progress_claims", session))) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  const params = new URL(req.url).searchParams;
  const jobId = params.get("jobId") ?? "";
  const claimId = params.get("claimId") ?? "";
  if (!jobId || !claimId) {
    return NextResponse.json({ ok: false, error: "jobId and claimId are required" }, { status: 400 });
  }

  const view = await readClaimsView(blobClaimsDeps(), jobId, new Date().toISOString());
  if (!view.ok) return NextResponse.json(view, { status: view.status });
  const claim = view.claims.find((c) => c.id === claimId);
  if (!claim) return NextResponse.json({ ok: false, error: "claim not found" }, { status: 404 });

  const csv = claimToCsv(claim);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${claimCsvFilename(jobId, claim)}"`,
      "cache-control": "no-store",
      "x-row-count": String(claim.lines.length + claim.attachments.length),
    },
  });
}
