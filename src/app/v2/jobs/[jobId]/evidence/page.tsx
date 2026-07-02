import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EvidenceQueue } from "@/components/admin/EvidenceQueue";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole, isLeadingHandRole } from "@/lib/auth/roles";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { EvidenceListResponseSchema } from "@/domains/evidence/schema";
import { SnagListResponseSchema } from "@/domains/snags/schema";
import type { Job } from "@/domains/jobs/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { SnagItem } from "@/domains/snags/types";

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
  // #760: Evidence is a CORE kill-switch the owner can turn off. Default ON.
  if (!(await isFlagEnabled("evidence", session))) notFound();
  const isAdmin = isAdminRole(session.role);

  // #262 / #267 — both AI features are admin-only and dark-flagged. When a
  // flag is off (or the viewer is LH) the corresponding controls don't
  // render at all — the API 404s anyway, so no dead buttons.
  const [aiLabelsFlag, snagSuggestionsFlag] = await Promise.all([
    isFlagEnabled("ai_photo_labels", session),
    isFlagEnabled("ai_snag_suggestions", session),
  ]);
  const aiLabelsEnabled = isAdmin && aiLabelsFlag;
  let snagSuggestionsEnabled = isAdmin && snagSuggestionsFlag;

  const [jobResult, evidenceResult, snagsResult] = await Promise.all([
    loadJob(raw, jobId),
    loadEvidence(raw, jobId),
    // #267 — the suggested/linked projection needs the job's snags.
    snagSuggestionsEnabled
      ? loadSnags(raw, jobId)
      : Promise.resolve({ snags: [] as SnagItem[], error: null }),
  ]);

  // Without the snag list we can't tell 'suggested' from 'linked' — degrade
  // the whole suggestion surface dark rather than risk suggesting a snag
  // that already exists (honest failure over a wrong suggestion).
  if (snagsResult.error) snagSuggestionsEnabled = false;

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
          viewerId={session.userId}
          /* #233 — admins manage any job; a leading hand who can reach this
             page is, by the single-job GET gate, assigned to it (i.e.
             server-side canManageJob passes). So admin OR LH here == can
             manage this job for the as-built FLAG permission. */
          viewerCanManageJob={isAdmin || isLeadingHandRole(session.role)}
          aiLabelsEnabled={aiLabelsEnabled}
          snagSuggestionsEnabled={snagSuggestionsEnabled}
          initialSnags={snagsResult.snags}
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

/**
 * #267 — fetch the job's snagsV2 rows for the defect-suggestion
 * projection ('linked' state = a snag already carries the photo). Only
 * called when the ai_snag_suggestions flag is on; a failure degrades the
 * suggestion surface dark (see the caller) rather than blocking the page.
 */
async function loadSnags(
  cookieValue: string | undefined,
  jobId: string
): Promise<{ snags: SnagItem[]; error: string | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/snags?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      }
    );
    if (!res.ok) {
      return { snags: [], error: `Snags API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = SnagListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { snags: [], error: "Unexpected snags response shape" };
    }
    return { snags: parsed.data.snags, error: null };
  } catch (err) {
    return {
      snags: [],
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}
