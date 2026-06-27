import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { SafetyDocsPanel } from "@/components/admin/SafetyDocsPanel";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import {
  SafetyDocsResponseSchema,
  type SafetyDoc,
  type SafetyDocRollup,
} from "@/domains/safety-docs/schema";
import type { Job } from "@/domains/jobs/types";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/safety — the office side of safety documents (#219).
 *
 * Admin/LH upload SWMS / SDS / other-safety (typed + versioned) and see who
 * across the assigned crew has and hasn't acknowledged the CURRENT version.
 * Field workers acknowledge in Phil, not here. Gated DARK behind `safety_docs`:
 * the route 404s when the flag is off, so the surface is invisible until proven.
 */
export default async function AdminSafetyPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/safety`)}`);
  }
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("safety_docs", session))) {
    notFound();
  }

  const [jobResult, safetyResult] = await Promise.all([
    loadJob(raw, jobId),
    loadSafety(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <AdminShell title="Safety" breadcrumb={<BackToJobs />}>
        <div className="mx-auto max-w-4xl space-y-4">
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

  const jobName = jobResult.kind === "ok" ? jobResult.job.name : "Job";

  return (
    <AdminShell title={`Safety · ${jobName}`} breadcrumb={<BackToJob jobId={jobId} />}>
      <div className="mx-auto max-w-4xl">
        <SafetyDocsPanel
          jobId={jobId}
          initialDocuments={safetyResult.kind === "ok" ? safetyResult.documents : []}
          initialRollup={safetyResult.kind === "ok" ? safetyResult.rollup : []}
          fetchError={safetyResult.kind === "error" ? safetyResult.message : null}
        />
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

function apiBase(host: string | null, proto: string): string {
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

type JobLoad =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

async function loadJob(cookieValue: string | undefined, jobId: string): Promise<JobLoad> {
  const h = await headers();
  const base = apiBase(
    h.get("x-forwarded-host") ?? h.get("host"),
    h.get("x-forwarded-proto") ?? "http"
  );
  try {
    const res = await fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (res.status === 404) return { kind: "not_found" };
    if (res.status === 403) return { kind: "forbidden" };
    if (!res.ok) return { kind: "error", message: `Jobs API ${res.status}` };
    const parsed = JobDetailResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { kind: "error", message: "Unexpected jobs response" };
    return { kind: "ok", job: parsed.data.job };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Network error" };
  }
}

type SafetyLoad =
  | { kind: "ok"; documents: SafetyDoc[]; rollup: SafetyDocRollup[] }
  | { kind: "error"; message: string };

async function loadSafety(cookieValue: string | undefined, jobId: string): Promise<SafetyLoad> {
  const h = await headers();
  const base = apiBase(
    h.get("x-forwarded-host") ?? h.get("host"),
    h.get("x-forwarded-proto") ?? "http"
  );
  try {
    const res = await fetch(`${base}/api/safety-docs?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return { kind: "error", message: `Safety API ${res.status}` };
    const parsed = SafetyDocsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { kind: "error", message: "Unexpected safety response" };
    return { kind: "ok", documents: parsed.data.documents, rollup: parsed.data.rollup ?? [] };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Network error" };
  }
}
