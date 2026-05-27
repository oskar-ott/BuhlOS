import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { ITPsQueue } from "@/components/admin/ITPsQueue";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { ITPListResponseSchema } from "@/domains/itp/schema";
import type { Job } from "@/domains/jobs/types";
import type { ITPInstance } from "@/domains/itp/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/itps — Phase E1c admin ITP queue + sign-off surface.
 *
 * Server component:
 *   1. Gates auth + admin/LH surface access (middleware also gates
 *      /v2/jobs/* — defence-in-depth).
 *   2. Fetches /api/jobs?id=<jobId> + /api/job-itps?jobId=<jobId> in
 *      parallel, forwarding the session cookie.
 *   3. Renders the AdminShell with <ITPsQueue /> client component
 *      that owns filter / drawer / sign-off / reopen / archive mutations.
 *
 * Admin gets every action; LH gets read-only (footer collapses to label
 * — same pattern as the D4 evidence and D.5 snag pages). Tradies /
 * clients are middleware-redirected before this page runs.
 *
 * Route lives at /v2/jobs/[jobId]/itps so no vercel.json change is
 * needed. Cutover of the legacy /admin/job → /v2/jobs/[jobId] section
 * is a later admin-shell rebuild slice.
 *
 * Cross-ref:
 *   src/app/v2/jobs/[jobId]/snags/page.tsx — D.5 precedent
 *   src/app/v2/jobs/[jobId]/evidence/page.tsx — D4 precedent
 *   docs/rebuild-audit/32-phase-e-plan.md §7
 *   docs/rebuild-audit/33-phase-e-build-prompts.md §E1c
 *
 * Architecture rule (doc 24 D-26): this page is a SERVER component. No
 * `"use client"` here — client components live under
 * `src/components/admin/`.
 */
export default async function AdminItpsPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(
      `/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/itps`)}`,
    );
  }
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }
  const isAdmin = isAdminRole(session.role);

  const [jobResult, itpsResult] = await Promise.all([
    loadJob(raw, jobId),
    loadItps(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <AdminShell
        title="ITPs"
        breadcrumb={
          <Link
            href="/v2/jobs"
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← Jobs
          </Link>
        }
      >
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

  if (jobResult.kind === "error") {
    return (
      <AdminShell
        title="ITPs"
        breadcrumb={
          <Link
            href={`/v2/jobs/${encodeURIComponent(jobId)}`}
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← Back to job
          </Link>
        }
      >
        <div className="mx-auto max-w-4xl space-y-4">
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

  return (
    <AdminShell
      title={`ITPs · ${jobResult.job.name}`}
      breadcrumb={
        <Link
          href={`/v2/jobs/${encodeURIComponent(jobId)}`}
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Back to job
        </Link>
      }
    >
      <div className="mx-auto max-w-5xl">
        <ITPsQueue
          job={jobResult.job}
          initialItps={itpsResult.kind === "ok" ? itpsResult.instances : []}
          fetchError={
            itpsResult.kind === "error" ? itpsResult.message : null
          }
          isAdmin={isAdmin}
          viewer={{
            id: session.userId ?? session.sub ?? "",
            role: String(session.role ?? ""),
          }}
        />
      </div>
    </AdminShell>
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
