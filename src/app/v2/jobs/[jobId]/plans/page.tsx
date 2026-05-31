import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PlansClient } from "@/components/plans/PlansClient";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { DocumentListResponseSchema } from "@/domains/documents/schema";
import type { Job } from "@/domains/jobs/types";
import type { Document } from "@/domains/documents/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/plans — Phase 1 admin Plan Viewer (read-only).
 *
 * Server component:
 *   1. Gates auth + admin/LH surface access (middleware also gates
 *      /v2/jobs/* — defence-in-depth).
 *   2. Fetches /api/jobs?id=<jobId> + /api/plans?jobId=<jobId> in
 *      parallel, forwarding the session cookie. No includeArchived: the
 *      viewer shows current + superseded only (PlansClient drops any
 *      archived row defensively).
 *   3. Renders the AdminShell with <PlansClient mode="admin" /> — the
 *      in-app raster viewer with the loud superseded guard.
 *
 * Phase 1 is READ-ONLY: no markup, no measurement, no uploads (those
 * stay on the legacy /admin/plans SPA). The tested coords + scale math
 * is the foundation for the Phase 2 markup layer on a later branch.
 *
 * Cross-ref:
 *   src/app/v2/jobs/[jobId]/documents/page.tsx — E2 RSC precedent
 */
export default async function AdminPlansPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/plans`)}`);
  }
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }

  const [jobResult, plansResult] = await Promise.all([
    loadJob(raw, jobId),
    loadPlans(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <AdminShell
        title="Plans"
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
        title="Plans"
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
      title={`Plans · ${jobResult.job.name}`}
      breadcrumb={
        <Link
          href={`/v2/jobs/${encodeURIComponent(jobId)}`}
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Back to job
        </Link>
      }
    >
      <div className="mx-auto max-w-6xl">
        <PlansClient
          mode="admin"
          initialDocuments={plansResult.kind === "ok" ? plansResult.documents : []}
          fetchError={plansResult.kind === "error" ? plansResult.message : null}
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
    const res = await fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue
        ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
        : undefined,
    });
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

type PlansLoad =
  | { kind: "ok"; documents: Document[] }
  | { kind: "error"; message: string };

async function loadPlans(
  cookieValue: string | undefined,
  jobId: string,
): Promise<PlansLoad> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/plans?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      },
    );
    if (!res.ok) {
      return { kind: "error", message: `Plans API ${res.status}` };
    }
    const body = await res.json();
    const parsed = DocumentListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { kind: "error", message: "Unexpected plans response" };
    }
    return { kind: "ok", documents: [...parsed.data.plans] };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }
}
