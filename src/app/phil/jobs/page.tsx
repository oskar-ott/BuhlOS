import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilJobsList } from "@/components/phil/PhilJobsList";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
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

  // The signed-in worker's id — keys the per-worker recent + pinned jobs (#145).
  // Falls back to "" so the list degrades to the plain name-first list if a
  // session ever lacks an id (no prefs read, no Recent group).
  const viewerId = session.userId ?? session.sub ?? "";

  const { jobs, fetchError } = await loadJobs(raw);

  // Hide archived + draft rows on the Phil surface even if a future admin
  // opens /phil/jobs directly. The server already withholds these from
  // non-admin callers (api/jobs.js GET); defence-in-depth here. Mirrors
  // isVisibleToField() in src/domains/jobs/builder.ts.
  const visible = jobs.filter(
    (j) => j.status !== "archived" && j.status !== "draft"
  );

  return (
    <PhilShell title="Jobs">
      <div className="space-y-4">
        <PhilPageIntro
          title="Jobs"
          description="Sites you’re currently assigned to. Tap one for site details, plans and capture."
          meta={
            visible.length > 0 ? (
              <span className="whitespace-nowrap text-xs uppercase tracking-wider text-text-muted">
                {visible.length} {visible.length === 1 ? "job" : "jobs"}
              </span>
            ) : undefined
          }
        />

        {fetchError ? (
          <PhilNotice tone="warning" title="Couldn’t load your jobs" role="alert">
            <p>{fetchError}. If it keeps failing, ask the office to check the API.</p>
            <div className="mt-3">
              <RefreshButton />
            </div>
          </PhilNotice>
        ) : null}

        <PhilJobsList initialJobs={visible} userId={viewerId} />
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
    // `?withStats=1` enriches each job with real, opt-in site stats
    // (open snags + active ITPs etc.) so the list can show "open work on this
    // site" chips. The enrichment fails soft server-side (api/jobs.js): on a
    // bad read the core job still returns with zeroed stats, so the list keeps
    // working and the chips just don't render.
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
