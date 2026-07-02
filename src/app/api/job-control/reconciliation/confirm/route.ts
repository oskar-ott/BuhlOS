import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, decodeSessionCookie, verifyViaApi } from "@/lib/auth/session";
import {
  ClassificationsInputSchema,
  REASON_REQUIRED_MESSAGE,
  ResolutionsInputSchema,
  blobReconciliationDeps,
  confirmReconciliationAuthorized,
} from "@/server/job-control/reconciliation-producer";
import { append as appendAuditLog } from "../../../../../../api/_lib/audit-log.js";

/**
 * POST /api/job-control/reconciliation/confirm — L0 reconciliation producer
 * (ADR: docs/architecture/job-control-runtime-adr.md).
 *
 * Admin-only WRITE. Persists the confirmed `ScopeReconciliation` to
 * `jobs/<jobId>/scope-reconciliation.json`. When a `sourceHash` is supplied it
 * is checked against the current scope and a stale confirm is rejected (409).
 * It compiles NOTHING and writes NO `jobs/<jobId>/job-control.json` (that is L1).
 *
 * Body (both optional, either or both):
 *   - `classifications` — clauseId → classification (the authoring/triage path)
 *   - `resolutions` — resolve-or-accept decisions on engine-named findings
 *     (#366 AC2). `accepted` REQUIRES a reason (400 without one). The actor +
 *     timestamp are stamped server-side from the verified session, never taken
 *     from the client. Each applied resolution is audited best-effort
 *     (scope.finding_resolved / scope.finding_accepted) — a journal failure
 *     never blocks the confirm.
 *
 * AUTH: because this route mutates, it uses the ADR-required AUTHORITATIVE
 * HMAC-verified check (`verifyViaApi` → /api/auth?action=me), NOT the unverified
 * cookie decode. A forged/unsigned cookie cannot reach the write. (The
 * read-only preview route keeps the lighter cookie-decode gate. The decoded
 * cookie is used ONLY for audit attribution, after the same cookie has
 * verified — the proof-review route's pattern.)
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  jobId: z.string().min(1),
  sourceHash: z.string().min(1).optional(),
  classifications: ClassificationsInputSchema.optional(),
  resolutions: ResolutionsInputSchema.optional(),
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
    // Name the accept-without-reason failure precisely — it's a user-fixable
    // validation, not a malformed request.
    const reasonMissing = body.error.issues.some((i) => i.message === REASON_REQUIRED_MESSAGE);
    return NextResponse.json(
      {
        ok: false,
        error: reasonMissing
          ? REASON_REQUIRED_MESSAGE
          : "jobId is required; classifications must use known scope classifications; resolutions need a findingKey and a resolved/accepted action",
      },
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
      resolutions: body.data.resolutions,
      expectedSourceHash: body.data.sourceHash ?? null,
      at: new Date().toISOString(),
    },
  );
  if (!result.ok) return NextResponse.json(result, { status: result.status });

  // Best-effort audit of each APPLIED resolution (#366 AC5 — who/when/what in
  // the audit feed). Unknown finding keys were ignored by the producer and are
  // not audited (nothing was recorded). A journal failure never blocks the
  // confirm — the write already succeeded.
  const resolutions = body.data.resolutions ?? [];
  if (resolutions.length > 0) {
    const unknown = new Set(result.unknownFindingKeys);
    const session = decodeSessionCookie((await cookies()).get(SESSION_COOKIE)?.value);
    for (const r of resolutions) {
      if (unknown.has(r.findingKey)) continue;
      try {
        await appendAuditLog({
          action: r.action === "accepted" ? "scope.finding_accepted" : "scope.finding_resolved",
          actorId: session?.userId ?? session?.sub ?? "",
          actorName: session?.name ?? "",
          actorRole: session?.role ?? null,
          jobId: body.data.jobId,
          targetType: "scope_reconciliation",
          targetId: r.findingKey,
          summary:
            r.action === "accepted"
              ? "Accepted a scope conflict with a reason"
              : "Marked a scope conflict resolved",
          metadata: {
            findingKey: r.findingKey,
            ...(r.reason?.trim() ? { reason: r.reason.trim() } : {}),
          },
        });
      } catch {
        /* best-effort — never block the confirm */
      }
    }
  }

  return NextResponse.json(result, { status: 200 });
}
