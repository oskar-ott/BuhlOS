import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EvidenceQueue } from "@/components/admin/EvidenceQueue";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { EvidenceListResponseSchema } from "@/domains/evidence/schema";
import type { Job } from "@/domains/jobs/types";
import type { EvidenceItem } from "@/domains/evidence/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/evidence — Phase D4 admin evidence review surface.
 *
 * Server component:
 *   1. Gates auth + admin/LH surface access (middleware also gates).
 *   2. Fetches /api/jobs?id=<jobId> + /api/evidence?jobId=<jobId> in
 *      parallel, forwarding the session cookie.
 *   3. Renders the AdminShell with <EvidenceQueue /> client component
 *      that owns the review/reject mutations.
 *
 * Admin gets write actions; leading hand gets read-only (review buttons
 * hidden). Tradie/client are middleware-redirected before this page
 * runs. Per doc 30 §3.3 + §C.4 / doc 24 §15.0 #6.
 *
 * Route provision per doc 30 §3.1 — sits at /v2/jobs/[jobId]/evidence
 * so no vercel.json change. Cutover to /jobs/[jobId]/evidence is a
 * later slice (admin Jobs surface rebuild).
 *
 * Cross-ref:
 *   docs/rebuild-audit/30-phase-d4-admin-evidence-review-spec.md §3 + §4
 *   docs/rebuild-audit/27-interface-usability-pass.md §5.2 + §9.5
 *   src/app/(admin)/hours/approvals/page.tsx — Phase B admin precedent
 */
export default async function AdminEvidenceReviewPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/evidence`)}`);
  }
  if (!canAccessSurface(session.role, "lh")) {
    // Middleware also gates; this is defence-in-depth in case the gate
    // ever slips (or someone deep-links and the middleware matcher misses).
    redirect("/v2/login");
  }
  const isAdmin = isAdminRole(session.role);

  const [jobResult, evidenceResult] = await Promise.all([
    loadJob(raw, jobId),
    loadEvidence(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <AdminShell title="Evidence review">
        <div className="mx-auto max-w-4xl space-y-4">
          <Link
            href="/command-centre"
            className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← Command Centre
          </Link>
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
      <AdminShell title="Evidence review">
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
      title={`Evidence · ${jobResult.job.name}`}
      breadcrumb={
        <Link
          href="/command-centre"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Command Centre
        </Link>
      }
    >
      <div className="mx-auto max-w-5xl">
        <EvidenceQueue
          job={jobResult.job}
          initialEvidence={evidenceResult.evidence}
          fetchError={evidenceResult.error}
          isAdmin={isAdmin}
          viewerName={session.name ?? session.role ?? "you"}
        />
      </div>
    </AdminShell>
  );
}

type JobResult =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

async function loadJob(
  cookieValue: string | undefined,
  jobId: string
): Promise<JobResult> {
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
    if (!res.ok) {
      return { kind: "error", message: `API returned ${res.status}` };
    }
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
 * Fetch evidence for the admin/LH view. Returns the raw list so the
 * client component can filter without a round-trip. A failure surfaces
 * as `fetchError` rather than blocking the page — admin can still see
 * the job header and a retry CTA below.
 */
async function loadEvidence(
  cookieValue: string | undefined,
  jobId: string
): Promise<{ evidence: EvidenceItem[]; error: string | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/evidence?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      }
    );
    if (!res.ok) {
      return { evidence: [], error: `Evidence API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = EvidenceListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { evidence: [], error: "Unexpected evidence response shape" };
    }
    return { evidence: parsed.data.evidence, error: null };
  } catch (err) {
    return {
      evidence: [],
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}
