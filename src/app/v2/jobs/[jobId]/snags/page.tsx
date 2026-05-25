import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { SnagsQueue } from "@/components/admin/SnagsQueue";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { SnagListResponseSchema } from "@/domains/snags/schema";
import type { Job } from "@/domains/jobs/types";
import type { SnagItem } from "@/domains/snags/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/snags — Phase D.5 admin snags / defects surface.
 *
 * Server component:
 *   1. Gates auth + admin/LH surface access (middleware also gates).
 *   2. Fetches /api/jobs?id=<jobId> + /api/snags?jobId=<jobId> in
 *      parallel, forwarding the session cookie.
 *   3. Renders the AdminShell with <SnagsQueue /> client component
 *      that owns filter / drawer / transition mutations.
 *
 * Admin gets every action; LH gets read-only (transition buttons
 * hidden — same pattern as the D4 evidence review page). Tradies /
 * clients are middleware-redirected before this page runs.
 *
 * Route lives at /v2/jobs/[jobId]/snags so no vercel.json change is
 * needed. Cutover to /jobs/[jobId]/snags is a later admin-shell
 * rebuild slice.
 *
 * Cross-ref:
 *   src/app/v2/jobs/[jobId]/evidence/page.tsx — D4 precedent
 *   docs/rebuild-audit/phase-d55-snags-runbook.md
 */
export default async function AdminSnagsPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/snags`)}`);
  }
  if (!canAccessSurface(session.role, "lh")) {
    // Defence-in-depth — middleware already gates this prefix.
    redirect("/v2/login");
  }
  const isAdmin = isAdminRole(session.role);

  const [jobResult, snagsResult] = await Promise.all([
    loadJob(raw, jobId),
    loadSnags(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <AdminShell title="Snags">
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
      <AdminShell title="Snags">
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
      title={`Snags · ${jobResult.job.name}`}
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
        <SnagsQueue
          job={jobResult.job}
          initialSnags={snagsResult.snags}
          fetchError={snagsResult.error}
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
    if (!res.ok) return { kind: "error", message: `API returned ${res.status}` };
    const body = await res.json();
    const parsed = JobDetailResponseSchema.safeParse(body);
    if (!parsed.success) return { kind: "error", message: "Unexpected response shape" };
    return { kind: "ok", job: parsed.data.job };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }
}

async function loadSnags(
  cookieValue: string | undefined,
  jobId: string
): Promise<{ snags: SnagItem[]; error: string | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/snags?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue
        ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
        : undefined,
    });
    if (!res.ok) return { snags: [], error: `Snags API returned ${res.status}` };
    const body = await res.json();
    const parsed = SnagListResponseSchema.safeParse(body);
    if (!parsed.success) return { snags: [], error: "Unexpected snags response shape" };
    return { snags: parsed.data.snags, error: null };
  } catch (err) {
    return {
      snags: [],
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}
