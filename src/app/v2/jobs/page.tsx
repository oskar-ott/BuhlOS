import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { JobsList } from "@/components/admin/JobsList";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import type { Job } from "@/domains/jobs/types";

export const dynamic = "force-dynamic";

/**
 * /v2/jobs — Phase D6 admin jobs index (rebuild surface).
 *
 * Discoverability landing for D4 evidence review + D.5 snags. Each row
 * deep-links into /v2/jobs/[jobId]/evidence and /v2/jobs/[jobId]/snags,
 * with pending counts so the admin can scan what needs attention without
 * drilling in.
 *
 * Server component:
 *   1. Gate auth via session cookie (middleware also gates this prefix).
 *   2. Require admin or LH surface access. Tradies / clients are
 *      middleware-redirected before this page runs; we defence-in-depth.
 *   3. Fetch /api/jobs?withStats=1 server-side with the session cookie.
 *      `withStats=1` returns the V2 evidence / snag counts the rebuild
 *      surfaces actually care about, alongside the legacy stats.
 *   4. Hand the parsed list + admin flag to <JobsList /> (client).
 *
 * Route lives at /v2/jobs so no vercel.json change is needed. Cutover to
 * the canonical /admin/jobs URL is a later admin-shell rebuild slice;
 * legacy /admin/jobs.html continues to serve through vercel.json
 * rewrites unchanged.
 *
 * Cross-ref:
 *   src/app/phil/jobs/page.tsx — D1 precedent (same shape, different gate)
 *   src/app/v2/jobs/[jobId]/evidence/page.tsx — D4 precedent
 *   src/app/v2/jobs/[jobId]/snags/page.tsx — D.5 precedent
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §6.2 Admin
 */
export default async function AdminJobsPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/v2/jobs");
  }
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }

  const { jobs, fetchError } = await loadJobs(raw);

  // Hide archived rows from the admin index — admins can still reach
  // archived jobs through legacy /admin/jobs.html when they need to.
  // Matches the Phil-side filter for behavioural consistency.
  const visible = jobs.filter((j) => j.status !== "archived");

  return (
    <AdminShell title="Jobs">
      <div className="mx-auto max-w-5xl space-y-4">
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <CardTitle>Jobs</CardTitle>
              <CardDescription className="mt-1">
                Open a job to review captured evidence or work the snags queue.
              </CardDescription>
            </div>
            <p className="text-sm text-text-muted">
              {visible.length === 0
                ? "No active jobs"
                : `${visible.length} ${visible.length === 1 ? "job" : "jobs"}`}
            </p>
          </div>
        </Card>

        {fetchError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load jobs</CardTitle>
            <CardDescription className="text-amber-900">
              {fetchError}. Try refreshing in a moment.
            </CardDescription>
          </Card>
        ) : null}

        <JobsList jobs={visible} />
      </div>
    </AdminShell>
  );
}

async function loadJobs(cookieValue: string | undefined): Promise<{
  jobs: ReadonlyArray<Job>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/jobs?withStats=1`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return { jobs: [], fetchError: `API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = JobListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { jobs: [], fetchError: "Unexpected response shape" };
    }
    return { jobs: parsed.data.jobs, fetchError: null };
  } catch (err) {
    return {
      jobs: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
