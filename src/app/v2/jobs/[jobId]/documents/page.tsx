import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { DocumentsList } from "@/components/admin/DocumentsList";
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
 * /v2/jobs/[jobId]/documents — Phase E2 admin documents queue.
 *
 * Server component:
 *   1. Gates auth + admin/LH surface access (middleware also gates
 *      /v2/jobs/* — defence-in-depth).
 *   2. Fetches /api/jobs?id=<jobId> + /api/plans?jobId=<jobId> in
 *      parallel, forwarding the session cookie.
 *   3. Renders the AdminShell with <DocumentsList /> client component
 *      that owns filter + drawer + revision-lineage expanders.
 *
 * Phase E2 is READ-ONLY end-to-end. Uploads, AI takeoff, and revision
 * curation stay on the legacy /admin/plans SPA until a later slice
 * pulls the write surface across.
 *
 * Cross-ref:
 *   src/app/v2/jobs/[jobId]/itps/page.tsx — E1c precedent
 *   src/app/v2/jobs/[jobId]/snags/page.tsx — D.5 precedent
 *   docs/rebuild-audit/36-documents-specs-readiness-note.md
 */
export default async function AdminDocumentsPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(
      `/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/documents`)}`,
    );
  }
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }

  const [jobResult, docsResult] = await Promise.all([
    loadJob(raw, jobId),
    loadDocuments(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <AdminShell
        title="Documents"
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
        title="Documents"
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
      title={`Documents · ${jobResult.job.name}`}
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
        <DocumentsList
          job={jobResult.job}
          initialDocuments={
            docsResult.kind === "ok" ? docsResult.documents : []
          }
          fetchError={docsResult.kind === "error" ? docsResult.message : null}
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

type DocsLoad =
  | { kind: "ok"; documents: Document[] }
  | { kind: "error"; message: string };

async function loadDocuments(
  cookieValue: string | undefined,
  jobId: string,
): Promise<DocsLoad> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    // includeArchived=1 is admin-only on the server; LH gets the
    // implicit non-archived set. The list component shows archived
    // rows behind a toggle anyway, so passing the flag here is the
    // simplest way to give admins the full set without a second
    // round trip when they flip the toggle.
    const res = await fetch(
      `${base}/api/plans?jobId=${encodeURIComponent(jobId)}&includeArchived=1`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      },
    );
    if (!res.ok) {
      return { kind: "error", message: `Documents API ${res.status}` };
    }
    const body = await res.json();
    const parsed = DocumentListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { kind: "error", message: "Unexpected documents response" };
    }
    return { kind: "ok", documents: [...parsed.data.plans] };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }
}
