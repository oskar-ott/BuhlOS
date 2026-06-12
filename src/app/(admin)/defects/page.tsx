import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { DefectsRegister } from "@/components/admin/DefectsRegister";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import {
  DefectsRegisterResponseSchema,
  type RegisterJobRef,
  type RegisterSnag,
} from "@/domains/snags/register";

export const dynamic = "force-dynamic";

/**
 * /defects — the cross-job defects register (#414).
 *
 * Snags live inside each job (/v2/jobs/[jobId]/snags); the office's daily
 * question is cross-job: which jobs have open defects, what's oldest, what
 * needs chasing. This page answers it in one queue — every snag across
 * every visible job, both stores (live snagsV2 + the legacy snags[] rows
 * that predate the cutover) normalised by /api/snags-all.
 *
 * Server component does the cookie-bearing fetch (?status=all — the
 * client filters locally so the status pills can show honest counts);
 * the DefectsRegister client owns filtering + bulk-close.
 *
 * Gate matches /v2/jobs ("lh" surface — admin tier + leading hands).
 * The API applies the SAME scoping server-side: admin sees all jobs, an
 * LH only their assignedJobIds — this page fetches nothing else.
 *
 * Cross-ref:
 *   api/snags-all.js — the register endpoint
 *   src/domains/snags/register.ts — normalisation contract
 *   docs/route-ownership.md §9 (nav contract) — /defects is APPROVED
 */
export default async function DefectsPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/defects");
  }
  // Same surface as /v2/jobs: admin tier + LH (defence-in-depth — the
  // middleware gates the prefix too, and api/snags-all re-checks).
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }

  const { snags, jobs, fetchError } = await loadRegister(raw);

  return (
    <AdminShell title="Defects">
      <div className="mx-auto max-w-5xl space-y-4">
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <CardTitle>Defects</CardTitle>
              <CardDescription className="mt-1">
                Every snag across your jobs in one queue — oldest first within
                priority. Open a row to work it on the job, or select and close
                the ones verified on site.
              </CardDescription>
            </div>
            <p className="text-sm text-text-muted">
              {snags.length === 0
                ? "No defects"
                : `${snags.length} ${snags.length === 1 ? "defect" : "defects"} recorded`}
            </p>
          </div>
        </Card>

        {fetchError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load defects</CardTitle>
            <CardDescription className="text-amber-900">
              {fetchError}. Try refreshing in a moment.
            </CardDescription>
          </Card>
        ) : (
          <DefectsRegister snags={snags} jobs={jobs} />
        )}
      </div>
    </AdminShell>
  );
}

async function loadRegister(cookieValue: string | undefined): Promise<{
  snags: ReadonlyArray<RegisterSnag>;
  jobs: ReadonlyArray<RegisterJobRef>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/snags-all?status=all`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return { snags: [], jobs: [], fetchError: `API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = DefectsRegisterResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { snags: [], jobs: [], fetchError: "Unexpected response shape" };
    }
    return { snags: parsed.data.snags, jobs: parsed.data.jobs, fetchError: null };
  } catch (err) {
    return {
      snags: [],
      jobs: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
