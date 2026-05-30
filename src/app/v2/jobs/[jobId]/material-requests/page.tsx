import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { MaterialRequestsInbox } from "@/components/admin/MaterialRequestsInbox";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { MaterialRequestListResponseSchema } from "@/domains/material-requests/schema";
import type { Job } from "@/domains/jobs/types";
import type { MaterialRequestItem } from "@/domains/material-requests/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/material-requests — per-job slice of the procurement
 * inbox (PR 11). Mirrors /v2/jobs/[jobId]/observations: same reused inbox
 * component, pre-filtered to one job, actions gated on isAdminRole so a
 * leading hand sees what's on order without being able to mutate it.
 */
export default async function JobMaterialRequestsPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(
      `/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/material-requests`)}`
    );
  }
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }

  const { job, jobError, requests, requestsError } = await load(raw, jobId);

  if (jobError === "not_found" || jobError === "forbidden") {
    return (
      <AdminShell title="Material requests" breadcrumb={<JobsBreadcrumb />}>
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
      title={job ? `${job.name} · Material requests` : "Material requests"}
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
          <CardTitle>Material requests on this job</CardTitle>
          <CardDescription>
            Procurement requests raised against this job. The cross-job inbox
            lives at{" "}
            <Link
              href={"/material-requests" as Route}
              className="underline decoration-accent-yellow decoration-2 underline-offset-2"
            >
              /material-requests
            </Link>
            .
          </CardDescription>
        </Card>

        <MaterialRequestsInbox
          initialRequests={requests}
          fetchError={requestsError}
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

async function load(
  cookieValue: string | undefined,
  jobId: string
): Promise<{
  job: Job | null;
  jobError: "not_found" | "forbidden" | "error" | null;
  requests: ReadonlyArray<MaterialRequestItem>;
  requestsError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const init = cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined;

  const [jobRes, mrRes] = await Promise.allSettled([
    fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, { cache: "no-store", headers: init }),
    fetch(`${base}/api/material-requests?jobId=${encodeURIComponent(jobId)}`, {
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

  let requests: ReadonlyArray<MaterialRequestItem> = [];
  let requestsError: string | null = null;
  if (mrRes.status === "fulfilled") {
    const r = mrRes.value;
    if (!r.ok) requestsError = `Material requests API returned ${r.status}`;
    else {
      const body = await r.json().catch(() => null);
      const parsed = MaterialRequestListResponseSchema.safeParse(body);
      if (parsed.success) requests = parsed.data.requests;
      else requestsError = "Unexpected response shape";
    }
  } else {
    requestsError = mrRes.reason instanceof Error ? mrRes.reason.message : "Network error";
  }

  return { job, jobError, requests, requestsError };
}
