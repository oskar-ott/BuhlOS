import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { DayworkRegister } from "@/components/admin/DayworkRegister";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isClientRole } from "@/lib/auth/roles";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import type { Job } from "@/domains/jobs/types";
import { blobDayworkDeps, loadJobDayworkRegister } from "@/server/dayworks/register";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/dayworks — the per-job daywork register (#370). Read-only:
 * dockets are raised + signed through Phil / api/dayworks.js; this office surface
 * shows them exception-first with the unsigned-aging payment-risk count.
 *
 * Server component mirroring the other job sub-routes (job-control/snags/itps):
 * gate auth, fetch /api/jobs?id= for access + the job name, read the register
 * server-side, render AdminShell + the presenter. Admin/LH (the jobs API 403s a
 * caller with no access to this job); clients never reach it.
 */
export default async function AdminJobDayworksPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role || isClientRole(session.role)) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/dayworks`)}`);
  }
  // #760: dayworks kill-switch — when the owner turns dayworks off, the surface 404s.
  if (!(await isFlagEnabled("dayworks", session))) {
    notFound();
  }

  const jobResult = await loadJob(raw, jobId);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <AdminShell title="Dayworks" breadcrumb={<BackToJobs />}>
        <div className="mx-auto max-w-3xl space-y-4">
          <Card>
            <CardTitle>This job isn&rsquo;t available</CardTitle>
            <CardDescription className="mt-2">
              {jobResult.kind === "forbidden"
                ? "You don't have access to this job."
                : "We couldn't find that job. It may have been archived or the link is stale."}
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  if (jobResult.kind === "error") {
    return (
      <AdminShell title="Dayworks" breadcrumb={<BackToJob jobId={jobId} />}>
        <div className="mx-auto max-w-3xl space-y-4">
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load this job</CardTitle>
            <CardDescription className="text-amber-900">
              {jobResult.message}. Try again in a moment.
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  const nowMs = Date.now();
  const register = await loadJobDayworkRegister(blobDayworkDeps(), jobId, nowMs);

  return (
    <AdminShell
      title={`Dayworks · ${jobResult.job.name}`}
      breadcrumb={<BackToJob jobId={jobId} />}
    >
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-600">
            Day-labour dockets for this job. Unsigned dockets older than 24h are payment risk.
          </p>
          <Link
            href="/v2/dayworks"
            className="text-sm underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            All jobs →
          </Link>
        </div>
        <DayworkRegister dockets={register.dockets} summary={register.summary} nowMs={nowMs} />
      </div>
    </AdminShell>
  );
}

function BackToJobs() {
  return (
    <Link
      href="/v2/jobs"
      className="underline decoration-accent-yellow decoration-2 underline-offset-2"
    >
      ← Jobs
    </Link>
  );
}

function BackToJob({ jobId }: { jobId: string }) {
  return (
    <Link
      href={`/v2/jobs/${encodeURIComponent(jobId)}`}
      className="underline decoration-accent-yellow decoration-2 underline-offset-2"
    >
      ← Back to job
    </Link>
  );
}

type JobLoad =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

async function loadJob(cookieValue: string | undefined, jobId: string): Promise<JobLoad> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (res.status === 404) return { kind: "not_found" };
    if (res.status === 403) return { kind: "forbidden" };
    if (!res.ok) return { kind: "error", message: `Jobs API ${res.status}` };
    const body = await res.json();
    const parsed = JobDetailResponseSchema.safeParse(body);
    if (!parsed.success) return { kind: "error", message: "Unexpected jobs response" };
    return { kind: "ok", job: parsed.data.job };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Network error" };
  }
}
