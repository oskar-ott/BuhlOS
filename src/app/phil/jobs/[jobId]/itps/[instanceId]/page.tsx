import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { ITPRecording } from "@/components/phil/ITPRecording";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { ITPListResponseSchema } from "@/domains/itp/schema";
import type { Job } from "@/domains/jobs/types";
import type { ITPInstance } from "@/domains/itp/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string; instanceId: string }>;
}

/**
 * /phil/jobs/[jobId]/itps/[instanceId] — Phil per-instance ITP recording
 * surface (Phase E1b).
 *
 * Server component:
 *   1. Gates auth + Phil-surface access (middleware also gates the
 *      /phil/jobs/* prefix).
 *   2. Fetches /api/jobs?id=<jobId> and /api/job-itps?jobId=<jobId> in
 *      parallel, forwarding the session cookie. Both must succeed +
 *      the requested instance must exist on that job.
 *   3. Branches on the response:
 *        - 200 + instance found → render <ITPRecording />
 *        - 403 / 404 → "not yours" card with a link back to /phil/jobs
 *        - other → non-blocking error card
 *
 * Cross-ref:
 *   src/app/phil/jobs/[jobId]/page.tsx — D1 precedent
 *   src/components/phil/ITPRecording.tsx — client orchestrator
 *   docs/rebuild-audit/33-phase-e-build-prompts.md §E1b
 *
 * Architecture rule (doc 24 D-26): this page is a SERVER component. No
 * `"use client"` here — client components live under
 * `src/components/phil/`.
 */
export default async function PhilItpRecordingPage({ params }: PageParams) {
  const { jobId, instanceId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(
      `/v2/login?next=${encodeURIComponent(`/phil/jobs/${jobId}/itps/${instanceId}`)}`,
    );
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }

  const [jobResult, itpsResult] = await Promise.all([
    loadJob(raw, jobId),
    loadItps(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <PhilShell title="ITP">
        <div className="space-y-4">
          <Link
            href="/phil/jobs"
            className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← All jobs
          </Link>
          <Card>
            <CardTitle>This job isn&rsquo;t assigned to you</CardTitle>
            <CardDescription className="mt-2">
              {jobResult.kind === "forbidden"
                ? "You don't have access to this job. If you should, ask your PM."
                : "We couldn't find that job. It may have been archived."}
            </CardDescription>
          </Card>
        </div>
      </PhilShell>
    );
  }

  if (jobResult.kind === "error" || itpsResult.kind === "error") {
    const message =
      jobResult.kind === "error"
        ? jobResult.message
        : itpsResult.kind === "error"
          ? itpsResult.message
          : "Network error";
    return (
      <PhilShell title="ITP">
        <div className="space-y-4">
          <Link
            href={`/phil/jobs/${encodeURIComponent(jobId)}`}
            className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← Back to job
          </Link>
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load this ITP</CardTitle>
            <CardDescription className="text-amber-900">
              {message}. Try again in a moment.
            </CardDescription>
          </Card>
        </div>
      </PhilShell>
    );
  }

  const instance = itpsResult.instances.find((i) => i.id === instanceId);
  if (!instance) {
    return (
      <PhilShell title="ITP">
        <div className="space-y-4">
          <Link
            href={`/phil/jobs/${encodeURIComponent(jobId)}`}
            className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← Back to job
          </Link>
          <Card>
            <CardTitle>ITP not found</CardTitle>
            <CardDescription className="mt-2">
              This ITP isn&rsquo;t on this job anymore. It may have been
              archived. Head back to the job to see what&rsquo;s active.
            </CardDescription>
          </Card>
        </div>
      </PhilShell>
    );
  }

  return (
    <PhilShell title={instance.templateSnapshot?.name?.trim() || "ITP"}>
      <ITPRecording
        job={jobResult.job}
        instance={instance}
        viewer={{
          id: session.userId ?? session.sub ?? "",
          role: String(session.role ?? ""),
        }}
      />
    </PhilShell>
  );
}

type JobLoad =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

async function loadJob(
  cookieValue: string | undefined,
  jobId: string,
): Promise<JobLoad> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/jobs?id=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      },
    );
    if (res.status === 404) return { kind: "not_found" };
    if (res.status === 403) return { kind: "forbidden" };
    if (!res.ok) return { kind: "error", message: `Jobs API ${res.status}` };
    const body = await res.json();
    const parsed = JobDetailResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { kind: "error", message: "Unexpected jobs response" };
    }
    return { kind: "ok", job: parsed.data.job };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }
}

type ItpsLoad =
  | { kind: "ok"; instances: ITPInstance[] }
  | { kind: "error"; message: string };

async function loadItps(
  cookieValue: string | undefined,
  jobId: string,
): Promise<ItpsLoad> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/job-itps?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      },
    );
    if (!res.ok) return { kind: "error", message: `ITPs API ${res.status}` };
    const body = await res.json();
    const parsed = ITPListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { kind: "error", message: "Unexpected ITPs response" };
    }
    return { kind: "ok", instances: [...parsed.data.instances] };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }
}
