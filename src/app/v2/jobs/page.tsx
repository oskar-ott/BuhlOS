import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
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
  // #915: card chips / health legs / portfolio counts for flagged features are
  // consumer-gated — stats arrive flag-blind from api/jobs.js.
  const [snagsOn, itpsOn] = await Promise.all([
    isFlagEnabled("snags", session),
    isFlagEnabled("itp", session),
  ]);
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
  const cardExtrasPromise = summaryOn ? loadCardExtras(raw) : null;

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
      <div className="mx-auto max-w-6xl space-y-4">
        {fetchError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load jobs</CardTitle>
            <CardDescription className="text-amber-900">
              {fetchError}. Try refreshing in a moment.
            </CardDescription>
          </Card>
        ) : null}

        <TestJobsCleanup jobs={deletableTestJobs} />

        <JobsList
          jobs={visible}
          canBuild={canBuild}
          newJobHref={canCreate ? "/v2/jobs/new" : undefined}
          cardExtrasPromise={cardExtrasPromise ?? undefined}
          features={{ snags: snagsOn, itps: itpsOn }}
        />
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
    // ~8s jobs.json monolith. The "X/Y tasks" progress (areaGroups-derived) and
    // the admin-tier contractValue are absent here and streamed in via
    // loadCardExtras. Flag-off → full read.
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
 * Streamed enrichment for the list cards: the full ?withStats=1 read carries the
 * areaGroups-derived statsTasksTotal/Complete AND the admin-tier contractValue
 * that the fast statsOnly read omits (statsOnly builds from the money-stripped
 * jobs-summary base). Resolves to a per-job map of the numeric extras present;
 * JobsList hydrates them in behind the already-painted cards. Fails soft to {} →
 * the progress line + value tile just stay as the statsOnly paint left them (no
 * fabricated count, no fabricated dollar figure).
 */
async function loadCardExtras(
  cookieValue: string | undefined
): Promise<Record<string, { tasksTotal?: number; tasksComplete?: number; contractValue?: number }>> {
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
    const out: Record<
      string,
      { tasksTotal?: number; tasksComplete?: number; contractValue?: number }
    > = {};
    for (const j of parsed.data.jobs) {
      const entry: { tasksTotal?: number; tasksComplete?: number; contractValue?: number } = {};
      if (typeof j.statsTasksTotal === "number" && typeof j.statsTasksComplete === "number") {
        entry.tasksTotal = j.statsTasksTotal;
        entry.tasksComplete = j.statsTasksComplete;
      }
      // contractValue is admin-tier (redacted to undefined for an LH viewer by
      // the API), so this is a real figure or genuinely absent — never faked.
      if (typeof j.contractValue === "number" && Number.isFinite(j.contractValue)) {
        entry.contractValue = j.contractValue;
      }
      if (Object.keys(entry).length > 0) out[j.id] = entry;
    }
    return out;
  } catch {
    return {};
  }
}
