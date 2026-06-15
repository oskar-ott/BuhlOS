import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isBlobConfigured } from "@/server/job-control/blob";
import { buildRuntimeCheckResult } from "@/server/job-control/runtime-check";

/**
 * GET /api/job-control/runtime-check — the repo's first TypeScript App Router
 * route handler (ADR: docs/architecture/job-control-runtime-adr.md).
 *
 * Foundation only: it proves the TS runtime boundary works — a route handler
 * importing job-control domain code (via the pure core) and the TS blob helper,
 * running in the Node runtime. It compiles no job and writes NO data; storage
 * is reported from the token's presence, never a mutation. Admin-only.
 *
 * The L0/L1 producer endpoints will live alongside this under
 * `src/app/api/job-control/**` and reuse the same session + blob helpers.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const store = await cookies();
  const session = decodeSessionCookie(store.get(SESSION_COOKIE)?.value);
  const result = buildRuntimeCheckResult({
    role: session?.role ?? null,
    storageConfigured: isBlobConfigured(),
  });
  return NextResponse.json(result.body, { status: result.status });
}
