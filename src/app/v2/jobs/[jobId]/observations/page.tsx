import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { ObservationsInbox } from "@/components/admin/ObservationsInbox";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { ObservationListResponseSchema } from "@/domains/observations/schema";
import type { Job } from "@/domains/jobs/types";
import type { ObservationItem } from "@/domains/observations/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/observations &mdash; the per-job slice of the Observations
 * inbox (PR 8 Job Bible foundation).
 *
 * Reuses the same `ObservationsInbox` client component as `/observations` but
 * pre-filtered server-side via `GET /api/observations?jobId=&lt;id&gt;`. Leading
 * hands assigned to the job can view + filter; only admin-tier users see the
 * triage / convert actions (matches the API gate). This is the job-scoped
 * view of the same field-to-office loop.
 *
 * Cross-ref:
 *   src/app/v2/jobs/[jobId]/snags/page.tsx &mdash; per-section page precedent
 *   src/app/(admin)/observations/page.tsx &mdash; cross-job inbox
 *   docs/architecture/job-bible.md &mdash; Job Bible foundation (PR 8)
 */
export default async function JobObservationsPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/observations`)}`);
  }
  // Defence-in-depth — middleware also gates /v2/jobs/* to the lh-or-admin
  // surface. The API enforces the same job-scope rules independently.
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }

  const { job, jobError, observations, observationsError } = await loadJobAndObservations(raw, jobId);

  // 404 / 403 surfaces from the job fetch — handle the same way the snags
  // sub-route does (admin-shell card, link back to the job hub).
  if (jobError === "not_found" || jobError === "forbidden") {
    return (
      <AdminShell title="Observations" breadcrumb={<JobsBreadcrumb />}>
        <div className="mx-auto max-w-4xl space-y-4">
          <Card>
            <CardTitle>This job isn&rsquo;t available</CardTitle>
            <CardDescription className="mt-2">
              {jobError === "forbidden"
                ? "You don't have access to this job. If you should, ask the office to add you."
                : "We couldn't find that job. It may have been archived or the link is stale."}
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      title={job ? `${job.name} · Observations` : "Observations"}
      breadcrumb={
        job ? (
          <Link
            href={`/v2/jobs/${jobId}` as Route}
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← {job.name}
          </Link>
        ) : (
          <JobsBreadcrumb />
        )
      }
    >
      <div className="mx-auto max-w-5xl space-y-5">
        <Card>
          <CardTitle>Observations on this job</CardTitle>
          <CardDescription>
            Field notes, blockers, plan mismatches, material needs, questions
            (RFIs), variations, defects and site instructions raised against
            this job. The cross-job inbox lives at{" "}
            <Link
              href={"/observations" as Route}
              className="underline decoration-accent-yellow decoration-2 underline-offset-2"
            >
              /observations
            </Link>
            .
          </CardDescription>
        </Card>

        <ObservationsInbox
          initialObservations={observations}
          fetchError={observationsError}
          viewer={{
            id: session.userId ?? session.sub ?? "",
            name: session.name ?? "You",
            role: String(session.role ?? ""),
          }}
          actionsEnabled={isAdminRole(session.role)}
          showJobFilter={false}
        />
      </div>
    </AdminShell>
  );
}

function JobsBreadcrumb() {
  return (
    <Link
      href="/v2/jobs"
      className="underline decoration-accent-yellow decoration-2 underline-offset-2"
    >
      ← Jobs
    </Link>
  );
}

async function loadJobAndObservations(
  cookieValue: string | undefined,
  jobId: string
): Promise<{
  job: Job | null;
  jobError: "not_found" | "forbidden" | "error" | null;
  observations: ReadonlyArray<ObservationItem>;
  observationsError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const init = cookieValue
    ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
    : undefined;

  const [jobRes, obsRes] = await Promise.allSettled([
    fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, { cache: "no-store", headers: init }),
    fetch(`${base}/api/observations?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: init,
    }),
  ]);

  let job: Job | null = null;
  let jobError: "not_found" | "forbidden" | "error" | null = null;
  if (jobRes.status === "fulfilled") {
    const r = jobRes.value;
    if (r.status === 404) jobError = "not_found";
    else if (r.status === 403) jobError = "forbidden";
    else if (!r.ok) jobError = "error";
    else {
      const body = await r.json().catch(() => null);
      const parsed = JobDetailResponseSchema.safeParse(body);
      if (parsed.success) job = parsed.data.job;
      else jobError = "error";
    }
  } else {
    jobError = "error";
  }

  let observations: ReadonlyArray<ObservationItem> = [];
  let observationsError: string | null = null;
  if (obsRes.status === "fulfilled") {
    const r = obsRes.value;
    if (!r.ok) observationsError = `Observations API returned ${r.status}`;
    else {
      const body = await r.json().catch(() => null);
      const parsed = ObservationListResponseSchema.safeParse(body);
      if (parsed.success) observations = parsed.data.observations;
      else observationsError = "Unexpected observations response shape";
    }
  } else {
    observationsError = obsRes.reason instanceof Error ? obsRes.reason.message : "Network error";
  }

  return { job, jobError, observations, observationsError };
}
