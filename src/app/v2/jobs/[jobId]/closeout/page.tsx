import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { CloseoutMatrixPanel } from "@/components/admin/CloseoutMatrixPanel";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isAdminRole } from "@/lib/auth/roles";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import type { Job } from "@/domains/jobs/types";
import {
  blobCloseoutReadDeps,
  runCloseoutMatrixView,
} from "@/server/job-control/closeout-read";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/closeout — the closeout matrix (#374). The per-job handover
 * obligations: requirements seeded from the recon's closeout clauses + the
 * electrical defaults, each discharged by links to real records (certificate /
 * document / evidence / ITP / as-built) and an admin confirmation, with honest
 * N-of-M readiness.
 *
 * Read-only with respect to job completion: this tracks readiness, it does NOT
 * gate or freeze the job's close-out (#349 owns the numbers freeze).
 *
 * Admin-tier (commercial / handover), mirroring the /scope page: gate session +
 * isAdminRole, fetch /api/jobs?id= for access + the job name, read the spine
 * server-side, render AdminShell + the authoring panel. The status shown is
 * always RE-DERIVED server-side (links + confirmation + live record ids), so a
 * deleted record reverts a requirement rather than showing orphaned-green.
 */
export default async function AdminJobCloseoutPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/closeout`)}`);
  }
  if (!isAdminRole(session.role)) {
    redirect("/v2/login");
  }

  const jobResult = await loadJob(raw, jobId);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <AdminShell title="Closeout" breadcrumb={<BackToJobs />}>
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
      <AdminShell title="Closeout" breadcrumb={<BackToJob jobId={jobId} />}>
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

  const view = await runCloseoutMatrixView(blobCloseoutReadDeps(), jobId);

  return (
    <AdminShell
      title={`Closeout · ${jobResult.job.name}`}
      breadcrumb={<BackToJob jobId={jobId} />}
    >
      <div className="mx-auto max-w-4xl space-y-4">
        <p className="text-sm text-slate-600">
          Closeout obligations — test results, certificate of electrical safety,
          as-builts and the job&rsquo;s own closeout clauses. A requirement is
          closed out only when a real record resolves and an admin confirms it.
        </p>
        <CloseoutMatrixPanel jobId={jobId} view={view} />
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
