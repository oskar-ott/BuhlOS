import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { RefreshButton } from "@/components/ui/RefreshButton";
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
 * /phil/jobs/[jobId]/plans — Phase 1 Phil Plan Viewer (read-only, field).
 *
 * Server component:
 *   1. Gates auth + Phil-surface access (middleware also gates
 *      /phil/jobs/* — defence-in-depth).
 *   2. Fetches /api/jobs?id=<jobId> + /api/plans?jobId=<jobId> in
 *      parallel, forwarding the session cookie. The server already
 *      strips archived for non-admin callers.
 *   3. Renders the PhilShell with <PlansClient mode="phil" /> — workers
 *      see CURRENT revisions only; superseded never reaches the field.
 *
 * Architecture rule (doc 24 D-26): SERVER component only. No
 * `"use client"` here — the interactive viewer lives in
 * src/components/plans/.
 *
 * Cross-ref:
 *   src/app/phil/jobs/[jobId]/page.tsx — D1 Phil RSC precedent
 *   src/app/phil/jobs/[jobId]/itps/[instanceId]/page.tsx — sub-route precedent
 */
export default async function PhilPlansPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/phil/jobs/${jobId}/plans`)}`);
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }

  const [jobResult, plansResult] = await Promise.all([
    loadJob(raw, jobId),
    loadPlans(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <PhilShell title="Plans">
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
                ? "You don't have access to this job. If you should, ask your PM to add you."
                : "We couldn't find that job. It may have been archived or the link is out of date."}
            </CardDescription>
          </Card>
        </div>
      </PhilShell>
    );
  }

  if (jobResult.kind === "error") {
    return (
      <PhilShell title="Plans">
        <div className="space-y-4">
          <Link
            href={`/phil/jobs/${encodeURIComponent(jobId)}`}
            className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← Back to job
          </Link>
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load this job</CardTitle>
            <CardDescription className="text-amber-900">
              {jobResult.message}.
            </CardDescription>
            <div className="mt-3">
              <RefreshButton />
            </div>
          </Card>
        </div>
      </PhilShell>
    );
  }

  return (
    <PhilShell title={`Plans · ${jobResult.job.name}`}>
      <div className="space-y-4">
        <Link
          href={`/phil/jobs/${encodeURIComponent(jobId)}`}
          className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Back to job
        </Link>
        <PlansClient
          mode="phil"
          jobId={jobId}
          initialDocuments={plansResult.documents}
          fetchError={plansResult.error}
        />
      </div>
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
    const res = await fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue
        ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
        : undefined,
    });
    if (res.status === 404) return { kind: "not_found" };
    if (res.status === 403) return { kind: "forbidden" };
    if (!res.ok) return { kind: "error", message: `API returned ${res.status}` };
    const body = await res.json();
    const parsed = JobDetailResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { kind: "error", message: "Unexpected response shape" };
    }
    return { kind: "ok", job: parsed.data.job };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }
}

/**
 * Fetch the plans for this job. Server strips archived for non-admin
 * callers; PlansClient (mode="phil") further filters to current only, so
 * the field never sees a superseded drawing. Non-blocking: a 403 (worker
 * not assigned — already 403'd above) degrades to empty; other failures
 * surface as a banner in PlansClient.
 */
async function loadPlans(
  cookieValue: string | undefined,
  jobId: string,
): Promise<{ documents: Document[]; error: string | null }> {
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
      return {
        documents: [],
        error: res.status === 403 ? null : `Plans API returned ${res.status}`,
      };
    }
    const body = await res.json();
    const parsed = DocumentListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { documents: [], error: "Unexpected plans response shape" };
    }
    return { documents: [...parsed.data.plans], error: null };
  } catch (err) {
    return {
      documents: [],
      error: err instanceof Error ? err.message : "Plans network error",
    };
  }
}
