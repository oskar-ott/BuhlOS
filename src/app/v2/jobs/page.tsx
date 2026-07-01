import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { Plus } from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { JobsList } from "@/components/admin/JobsList";
import { TestJobsCleanup } from "@/components/admin/TestJobsCleanup";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface, canCreateJob } from "@/lib/auth/permissions";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import { isDeletableTestJob } from "@/domains/jobs/test-data";
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
  // #760: Jobs is a CORE kill-switch — the owner can hide the whole admin Jobs
  // surface. Default ON, so this is a no-op until turned off from /owner. (The
  // shared /api/jobs stays live — it's infrastructure the field + hub rely on;
  // the board warns before disabling a core feature.)
  if (!(await isFlagEnabled("jobs", session))) notFound();
  // CREATE (POST /api/jobs) is literal-admin only; EDIT/build (PUT) is the
  // admin tier. The "New job" button uses canCreateJob (literal admin); the
  // per-row "Build" uses admin-tier access. A leading hand sees the list but
  // no create/build entry point (the builder is admin-only by design).
  const canBuild = canAccessSurface(session.role, "admin");
  const canCreate = canCreateJob(session.role);

  // Perf: render the list from the fast statsOnly read (base + snag/evidence/ITP
  // chips + health — all correct; only the areaGroups-derived "X/Y tasks" progress
  // is absent) and STREAM the task-progress in behind it. When the flag is off the
  // statsOnly URL falls through to the full withStats read, so the jobs already
  // carry task counts and no stream is needed (byte-identical to before).
  const summaryOn = /^(1|true|on)$/.test((process.env.FLAG_PHIL_JOBS_SUMMARY_READ ?? "").toLowerCase());
  const { jobs, fetchError } = await loadJobs(raw);
  const taskCountsPromise = summaryOn ? loadTaskCounts(raw) : null;

  // Hide archived rows from the admin index — admins can still reach
  // archived jobs through legacy /admin/jobs.html when they need to.
  // Matches the Phil-side filter for behavioural consistency.
  const visible = jobs.filter((j) => j.status !== "archived");

  // Parked automated-test jobs (QA-prefixed, not active) accumulate one
  // per smoke run with no other removal path — offer literal admins the
  // one-shot cleanup. Computed from the UNFILTERED list so archived test
  // junk gets purged too, not just the drafts cluttering the index.
  const deletableTestJobs = canCreate
    ? jobs.filter(isDeletableTestJob).map((j) => ({ id: j.id, name: j.name }))
    : [];

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
            <div className="flex items-center gap-3">
              <p className="text-sm text-text-muted">
                {visible.length === 0
                  ? "No active jobs"
                  : `${visible.length} ${visible.length === 1 ? "job" : "jobs"}`}
              </p>
              {canCreate ? (
                <Link
                  data-testid="jobs-new-job"
                  href="/v2/jobs/new"
                  className="inline-flex items-center gap-1.5 rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-ink focus:outline-none focus:ring-2 focus:ring-brand-navy"
                >
                  <Plus aria-hidden="true" className="h-4 w-4" /> New job
                </Link>
              ) : null}
            </div>
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

        <TestJobsCleanup jobs={deletableTestJobs} />

        <JobsList jobs={visible} canBuild={canBuild} taskCountsPromise={taskCountsPromise ?? undefined} />
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
    // statsOnly: base + snag/evidence/ITP counts + health inputs, skipping the
    // ~8s jobs.json monolith. The "X/Y tasks" progress (areaGroups-derived) is
    // absent here and streamed in via loadTaskCounts. Flag-off → full read.
    const res = await fetch(`${base}/api/jobs?withStats=1&statsOnly=1`, {
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

/**
 * Streamed task-progress for the list rows: the full ?withStats=1 read carries the
 * areaGroups-derived statsTasksTotal/Complete that statsOnly omits. Resolves to a
 * { [jobId]: { tasksTotal, tasksComplete } } map (only jobs with numeric counts);
 * JobsList hydrates it in behind the already-painted rows. Fails soft to {} → the
 * progress line just doesn't show (no fabricated count).
 */
async function loadTaskCounts(
  cookieValue: string | undefined
): Promise<Record<string, { tasksTotal: number; tasksComplete: number }>> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/jobs?withStats=1`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return {};
    const parsed = JobListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return {};
    const out: Record<string, { tasksTotal: number; tasksComplete: number }> = {};
    for (const j of parsed.data.jobs) {
      if (typeof j.statsTasksTotal === "number" && typeof j.statsTasksComplete === "number") {
        out[j.id] = { tasksTotal: j.statsTasksTotal, tasksComplete: j.statsTasksComplete };
      }
    }
    return out;
  } catch {
    return {};
  }
}
