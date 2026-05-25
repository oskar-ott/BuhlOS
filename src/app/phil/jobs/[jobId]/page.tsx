import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PhilJobDetail } from "@/components/phil/PhilJobDetail";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
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
 * /phil/jobs/[jobId] — Phil single-job context view (Phase D1, read-only).
 *
 * Server component:
 *   1. Gates auth + Phil-surface access (middleware also gates).
 *   2. Fetches /api/jobs?id=<jobId>, forwarding the session cookie.
 *   3. Branches on the response code:
 *        - 200 → render <PhilJobDetail job={...} />
 *        - 403 / 404 → render a "not yours" card with a link back to /phil/jobs
 *        - other → render a non-blocking error card
 *
 * Server-side permission enforcement at api/jobs.js:174-178 means a worker
 * trying to open a job they're not assigned to will get a 403; we surface
 * that as a friendly "not assigned to you" rather than the 403 page so the
 * worker can recover by tapping back without a logout flow.
 *
 * Cross-ref:
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §6 Phil
 *   docs/rebuild-audit/27-interface-usability-pass.md §8.5
 *   api/jobs.js GET single
 */
export default async function PhilJobDetailPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/phil/jobs/${jobId}`)}`);
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }

  const result = await loadJob(raw, jobId);
  // Initial evidence + snags load happens server-side so the panels
  // render with content already present on first paint — no client-side
  // spinner for the empty case. Failure is non-blocking: an empty list
  // just shows the empty state, the worker can still create new items,
  // and the server will return real data on the next refresh.
  const [initialEvidence, initialSnags] =
    result.kind === "ok"
      ? await Promise.all([
          loadInitialEvidence(raw, jobId),
          loadInitialSnags(raw, jobId),
        ])
      : [[], []];

  if (result.kind === "not_found" || result.kind === "forbidden") {
    return (
      <PhilShell title="Job">
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
              {result.kind === "forbidden"
                ? "You don't have access to this job. If you should, ask your PM to add you."
                : "We couldn't find that job. It may have been archived or the link is out of date."}
            </CardDescription>
          </Card>
        </div>
      </PhilShell>
    );
  }

  if (result.kind === "error") {
    return (
      <PhilShell title="Job">
        <div className="space-y-4">
          <Link
            href="/phil/jobs"
            className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← All jobs
          </Link>
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load this job</CardTitle>
            <CardDescription className="text-amber-900">
              {result.message}. Try again in a moment.
            </CardDescription>
          </Card>
        </div>
      </PhilShell>
    );
  }

  return (
    <PhilShell title={result.job.name}>
      <PhilJobDetail
        job={result.job}
        initialEvidence={initialEvidence}
        initialSnags={initialSnags}
        viewer={{
          id: session.userId ?? session.sub ?? "",
          role: String(session.role ?? ""),
        }}
      />
    </PhilShell>
  );
}

type LoadResult =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

async function loadJob(
  cookieValue: string | undefined,
  jobId: string
): Promise<LoadResult> {
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
 * Fetch the worker's own evidence for this job (server already filters
 * to capturedById === me.id for tradie; admin/LH see all).
 *
 * Non-blocking by design: any failure returns [] and the strip shows
 * its empty state — capture is still possible, and a subsequent capture
 * append + post-capture refetch will populate the strip without needing
 * a full page reload.
 */
async function loadInitialEvidence(
  cookieValue: string | undefined,
  jobId: string
): Promise<EvidenceItem[]> {
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
    if (!res.ok) return [];
    const body = await res.json();
    const parsed = EvidenceListResponseSchema.safeParse(body);
    if (!parsed.success) return [];
    return parsed.data.evidence;
  } catch {
    return [];
  }
}

/**
 * Fetch the snags for this job. Server returns every snag on the job
 * for every field user assigned to it (same visibility as the admin
 * queue). Non-blocking: a failure returns [] and the panel shows its
 * empty state.
 */
async function loadInitialSnags(
  cookieValue: string | undefined,
  jobId: string
): Promise<SnagItem[]> {
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
    if (!res.ok) return [];
    const body = await res.json();
    const parsed = SnagListResponseSchema.safeParse(body);
    if (!parsed.success) return [];
    return parsed.data.snags;
  } catch {
    return [];
  }
}
