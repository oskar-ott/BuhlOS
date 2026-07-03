import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { JobBuilderClient } from "@/components/admin/JobBuilderClient";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import type { Job } from "@/domains/jobs/types";
import {
  blobReconciliationReadDeps,
  runScopeReconciliationView,
  type ScopeReconciliationView,
} from "@/server/job-control/reconciliation-read";
import { UsersListResponseSchema } from "@/domains/users/schema";
import { filterAssignableWorkers } from "@/domains/users/assignment";
import type { AssignableWorker } from "@/domains/users/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/builder — the Job Builder / Editor workspace (admin only).
 *
 * Loads the job with ?includeArchived=1 (admin-editor read) so the client
 * can render archived rooms/tasks as honest read-only rows alongside the
 * editable live structure (#377). Structure stays fully editable: the save
 * sends only live rows and api/jobs.js PUT re-appends the archived items it
 * omits (the server is the retention authority), so editing can't disturb
 * archived history.
 *
 * Admin-only: POST /api/jobs (create) and the structure/status/name PUT
 * fields are admin-gated server-side; a leading hand who landed here would
 * 403 on save. We send a non-admin back to the job hub (which they can see)
 * rather than show a form whose every action would fail.
 *
 * Cross-ref:
 *   src/components/admin/JobBuilderClient.tsx — the workspace itself
 *   src/app/v2/jobs/[jobId]/page.tsx — the job hub this links back to
 *   src/app/v2/jobs/new/page.tsx — create flow that routes in here
 *   src/domains/jobs/client.ts getJobForEdit — same includeArchived read
 */
export default async function JobBuilderPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/builder`)}`);
  }
  // The builder writes admin-only fields. A leading hand can view the job
  // hub but can't build — send them there instead of a dead form.
  if (!canAccessSurface(session.role, "admin")) {
    redirect(`/v2/jobs/${jobId}`);
  }

  const result = await loadJob(raw, jobId);

  if (result.kind === "not_found" || result.kind === "forbidden") {
    return (
      <BuilderShell jobId={jobId}>
        <Card>
          <CardTitle>This job isn&rsquo;t available</CardTitle>
          <CardDescription className="mt-2">
            {result.kind === "forbidden"
              ? "You don't have access to this job."
              : "We couldn't find that job. It may have been deleted or the link is stale."}
          </CardDescription>
        </Card>
      </BuilderShell>
    );
  }

  if (result.kind === "error") {
    return (
      <BuilderShell jobId={jobId}>
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardTitle>Couldn&rsquo;t load this job</CardTitle>
          <CardDescription className="text-amber-900">
            {result.message}. Try again in a moment.
          </CardDescription>
        </Card>
      </BuilderShell>
    );
  }

  const workers = await loadAssignableWorkers(raw);
  // Confirmed scope reconciliation (#366) — the real source of per-clause
  // certainty for the cockpit Inspector. Read-only blob read; degrades to a
  // `missing` view when the job hasn't been reconciled, so the builder never
  // fakes certainty. This page is already admin-gated, which the reader requires.
  const reconciliation = await loadReconciliation(jobId);
  // Plan Studio (#206 rooms→areas) is dark behind ai_drawings (admin-tier). This
  // page is already admin-gated, so the check just resolves the flag's state.
  const planStudioEnabled = await isFlagEnabled("ai_drawings", session);

  return (
    <BuilderShell jobId={jobId} title={result.job.name}>
      {/* Crew now lives inside the cockpit's Crew section (assignableWorkers),
          not as a sibling panel. */}
      <JobBuilderClient
        job={result.job}
        reconciliation={reconciliation}
        assignableWorkers={workers.workers}
        workersLoadError={workers.error}
        planStudioEnabled={planStudioEnabled}
      />
    </BuilderShell>
  );
}

function BuilderShell({
  jobId,
  title,
  children,
}: {
  jobId: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <AdminShell
      title={title ? `Builder · ${title}` : "Job builder"}
      breadcrumb={
        <Link
          href={`/v2/jobs/${jobId}`}
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Job
        </Link>
      }
    >
      {/* Wider than the legacy single-column builder: the §4 cockpit is a
          three-column rail · canvas · inspector layout that needs the room. */}
      <div className="mx-auto max-w-7xl">{children}</div>
    </AdminShell>
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
    // includeArchived=1 — the admin-editor read. Lets the builder render
    // archived structure as read-only rows next to the editable live structure (#377).
    const res = await fetch(
      `${base}/api/jobs?id=${encodeURIComponent(jobId)}&includeArchived=1`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      }
    );
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
 * Load the assignable field/LH workers for the "Assigned field workers" panel.
 *
 * GET /api/users is admin-tier-gated; this page is already admin-only, so the
 * forwarded session cookie passes. We filter to active field/LH accounts
 * server-side (filterAssignableWorkers) so the client only ever receives the
 * four secret-free worker fields — never hashes or non-field accounts. A failure
 * is non-blocking: the panel shows an error banner, the builder still renders.
 */
async function loadAssignableWorkers(cookieValue: string | undefined): Promise<{
  workers: AssignableWorker[];
  error: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/users`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return { workers: [], error: `API returned ${res.status}` };
    const body = await res.json();
    const parsed = UsersListResponseSchema.safeParse(body);
    if (!parsed.success) return { workers: [], error: "Unexpected response shape" };
    return { workers: filterAssignableWorkers(parsed.data.users), error: null };
  } catch (err) {
    return {
      workers: [],
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

/**
 * Read the confirmed scope reconciliation for this job. The reader never throws
 * on a missing/invalid artifact (returns a typed missing/unreadable view); this
 * wrapper additionally swallows an unexpected blob-store error to null so the
 * builder always renders — certainty chips simply don't appear when there's no
 * reconciliation, which is the honest "not tracked yet" state.
 */
async function loadReconciliation(jobId: string): Promise<ScopeReconciliationView | null> {
  try {
    return await runScopeReconciliationView(blobReconciliationReadDeps(), jobId);
  } catch {
    return null;
  }
}
