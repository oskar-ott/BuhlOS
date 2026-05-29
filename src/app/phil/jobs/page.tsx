import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PhilJobsList } from "@/components/phil/PhilJobsList";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import type { Job } from "@/domains/jobs/types";

export const dynamic = "force-dynamic";

/**
 * /phil/jobs — Phil jobs list (Phase D1, read-only).
 *
 * Server component:
 *   1. Gates auth via session cookie (middleware also gates this prefix).
 *   2. Confirms the role can see the Phil surface.
 *   3. Fetches /api/jobs server-side, forwarding the session cookie. The
 *      legacy API already filters to assignedJobIds for non-admin roles
 *      (api/jobs.js:188-195), so the response is scoped per worker.
 *   4. Hands the parsed list to <PhilJobsList /> (client component).
 *
 * On error, falls back to an empty list + a non-blocking error card.
 *
 * Cross-ref:
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §6 Phil
 *   docs/rebuild-audit/27-interface-usability-pass.md §8.4
 *   src/app/phil/gear/page.tsx (precedent for the shell + fetch pattern)
 */
export default async function PhilJobsPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/phil/jobs");
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }

  const { jobs, fetchError } = await loadJobs(raw);

  // Hide archived rows on the Phil surface even if a future admin opens
  // /phil/jobs directly. Server already does this for non-admin via
  // projectJobStructure; defence-in-depth here.
  const visible = jobs.filter((j) => j.status !== "archived");

  return (
    <PhilShell title="Jobs">
      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm text-text-muted">
            {visible.length === 0
              ? "No jobs assigned yet"
              : `${visible.length} ${visible.length === 1 ? "job" : "jobs"} assigned to you`}
          </p>
        </div>

        {fetchError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load your jobs</CardTitle>
            <CardDescription className="text-amber-900">
              {fetchError}. If it keeps failing, ask the office to check the API.
            </CardDescription>
            <div className="mt-3">
              <RefreshButton />
            </div>
          </Card>
        ) : null}

        <PhilJobsList initialJobs={visible} />
      </div>
    </PhilShell>
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
    const res = await fetch(`${base}/api/jobs`, {
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
