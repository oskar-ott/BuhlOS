import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { JobActivityFeed } from "@/components/admin/JobActivityFeed";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { AuditLogListResponseSchema } from "@/domains/audit-log/schema";
import type { Job } from "@/domains/jobs/types";
import type { AuditLogEntry } from "@/domains/audit-log/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/history &mdash; per-job activity feed (PR 9).
 *
 * Replaces the old "History" UC row on the SectionNav. Reads the audit-log
 * monthly buckets via `GET /api/audit-log?jobId=&lt;id&gt;&scope=job` (PR 9's
 * new endpoint mode — admin/LH only). Renders a chronological timeline of
 * every captured/reviewed/raised/transitioned/signed-off/converted event the
 * job has accumulated.
 *
 * Cross-ref:
 *   api/audit-log.js &mdash; scope=job branch
 *   src/components/admin/JobActivityFeed.tsx &mdash; the client surface
 *   docs/architecture/job-bible.md &mdash; Job Bible foundation
 */
export default async function JobHistoryPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/history`)}`);
  }
  // Defence-in-depth — middleware also gates /v2/jobs/* to the lh-or-admin
  // surface. The API enforces the same admin/LH-only rule independently.
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }

  const { job, jobError, entries, entriesError } = await loadJobAndActivity(raw, jobId);

  if (jobError === "not_found" || jobError === "forbidden") {
    return (
      <AdminShell title="Activity" breadcrumb={<JobsBreadcrumb />}>
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
      title={job ? `${job.name} · Activity` : "Activity"}
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
      <div className="mx-auto max-w-4xl">
        <JobActivityFeed
          initialEntries={entries}
          fetchError={entriesError}
          jobName={job?.name ?? jobId}
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

async function loadJobAndActivity(
  cookieValue: string | undefined,
  jobId: string
): Promise<{
  job: Job | null;
  jobError: "not_found" | "forbidden" | "error" | null;
  entries: ReadonlyArray<AuditLogEntry>;
  entriesError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const init = cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined;

  const [jobRes, actRes] = await Promise.allSettled([
    fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, { cache: "no-store", headers: init }),
    fetch(`${base}/api/audit-log?jobId=${encodeURIComponent(jobId)}&scope=job&months=4`, {
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

  let entries: ReadonlyArray<AuditLogEntry> = [];
  let entriesError: string | null = null;
  if (actRes.status === "fulfilled") {
    const r = actRes.value;
    if (!r.ok) entriesError = `Activity API returned ${r.status}`;
    else {
      const body = await r.json().catch(() => null);
      const parsed = AuditLogListResponseSchema.safeParse(body);
      if (parsed.success) entries = parsed.data.entries;
      else entriesError = "Unexpected activity response shape";
    }
  } else {
    entriesError = actRes.reason instanceof Error ? actRes.reason.message : "Network error";
  }

  return { job, jobError, entries, entriesError };
}
