import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { ScopeReconciliationStatus } from "@/components/admin/ScopeReconciliationStatus";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isAdminRole } from "@/lib/auth/roles";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import type { Job } from "@/domains/jobs/types";
import {
  blobReconciliationReadDeps,
  runScopeReconciliationView,
} from "@/server/job-control/reconciliation-read";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/scope — the boss-facing scope-vs-quote reconciliation review
 * (#366). Read-only: the office classifies clauses in Job control (the authoring
 * surface); this surface SHOWS the confirmed RAG status, the open findings (the
 * disposal / by-others / alternate traps) and the per-clause classifications so
 * the conflicts are visible before work starts.
 *
 * Admin-tier (commercial reconciliation), mirroring the job-control page: gate
 * session + isAdminRole, fetch /api/jobs?id= for access + the job name, read the
 * confirmed reconciliation server-side, render AdminShell + the presenter.
 */
export default async function AdminJobScopePage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/scope`)}`);
  }
  if (!isAdminRole(session.role)) {
    redirect("/v2/login");
  }

  const jobResult = await loadJob(raw, jobId);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <AdminShell title="Scope reconciliation" breadcrumb={<BackToJobs />}>
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
      <AdminShell title="Scope reconciliation" breadcrumb={<BackToJob jobId={jobId} />}>
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

  const view = await runScopeReconciliationView(blobReconciliationReadDeps(), jobId);

  return (
    <AdminShell
      title={`Scope reconciliation · ${jobResult.job.name}`}
      breadcrumb={<BackToJob jobId={jobId} />}
    >
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-600">
            Scope-vs-quote reconciliation — every clause is classified before work starts so
            silent freebies and missed variations surface here, not months later.
          </p>
          <Link
            href={`/v2/jobs/${encodeURIComponent(jobId)}/job-control`}
            className="text-sm underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            Classify in Job control →
          </Link>
        </div>
        <ScopeReconciliationStatus view={view} />
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
