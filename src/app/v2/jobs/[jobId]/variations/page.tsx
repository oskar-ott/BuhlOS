import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { VariationsRegister } from "@/components/admin/VariationsRegister";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { VariationClaimsResponseSchema } from "@/domains/variations/claim-schema";
import type { VariationClaimRecord } from "@/domains/variations/claim-types";
import type { Job } from "@/domains/jobs/types";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/variations — the per-job variation-claims register (#280).
 *
 * The billable record of extra work: raise → quote → submit → approve (with
 * evidence) → invoice. ADMIN-tier only — claims are billing, stricter than the
 * LH+ gate the RFI register uses (api/variations.js 403s non-admin the same
 * way). Gated DARK behind `variations_register` (404s when off).
 */
export default async function AdminVariationsPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/variations`)}`);
  }
  // Billing surface — admin tier only (the API enforces the same).
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("variations_register", session))) {
    notFound();
  }

  const [jobResult, claimsResult] = await Promise.all([
    loadJob(raw, jobId),
    loadClaims(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <AdminShell title="Variations" breadcrumb={<BackToJobs />}>
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
    <AdminShell title={`Variations · ${jobName}`} breadcrumb={<BackToJob jobId={jobId} />}>
      <div className="mx-auto max-w-4xl">
        <VariationsRegister
          jobId={jobId}
          initialClaims={claimsResult.kind === "ok" ? claimsResult.claims : []}
          fetchError={claimsResult.kind === "error" ? claimsResult.message : null}
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

type ClaimsLoad =
  | { kind: "ok"; claims: VariationClaimRecord[] }
  | { kind: "error"; message: string };

async function loadClaims(cookieValue: string | undefined, jobId: string): Promise<ClaimsLoad> {
  const h = await headers();
  const base = apiBase(
    h.get("x-forwarded-host") ?? h.get("host"),
    h.get("x-forwarded-proto") ?? "http"
  );
  try {
    const res = await fetch(`${base}/api/variations?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return { kind: "error", message: `Variations API ${res.status}` };
    const parsed = VariationClaimsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { kind: "error", message: "Unexpected variations response" };
    return { kind: "ok", claims: parsed.data.claims };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Network error" };
  }
}
