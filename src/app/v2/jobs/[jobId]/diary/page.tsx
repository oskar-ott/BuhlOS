import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { JobDiary } from "@/components/admin/JobDiary";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { DiaryListResponseSchema } from "@/domains/diary/schema";
import type { Job } from "@/domains/jobs/types";
import type { DiaryEntry } from "@/domains/diary/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/diary &mdash; the job's site diary (#210).
 *
 * Modelled on history/page.tsx: AdminShell, force-dynamic, session +
 * canAccessSurface('lh') gate, a Promise.allSettled fan-in for the job (via
 * /api/jobs?id=) and the diary range (via /api/diary). The diary is the office's
 * contemporaneous daily record &mdash; admin writes, LH reads (the API enforces
 * the same canManageJob/isAdminRole rule independently). Clients never reach it.
 *
 * If the diary read fails we render a NAMED error on the surface rather than a
 * silent empty list (P7); the attendance pre-fill warning lives inside the
 * editor (it pre-fetches /api/site-visits client-side).
 *
 * Cross-ref:
 *   api/diary.js &mdash; per-job diary store + integrity rules
 *   src/components/admin/JobDiary.tsx &mdash; the client editor + list
 */
export default async function JobDiaryPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/diary`)}`);
  }
  // Defence-in-depth — middleware gates /v2/jobs/* to the lh-or-admin surface;
  // api/diary.js enforces canManageJob (read) / isAdminRole (write) independently.
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("diary", session))) notFound();

  const { job, jobError, entries, entriesError } = await loadJobAndDiary(raw, jobId);

  if (jobError === "not_found" || jobError === "forbidden") {
    return (
      <AdminShell title="Site diary" breadcrumb={<JobsBreadcrumb />}>
        <div className="mx-auto max-w-4xl space-y-4">
          <Card>
            <CardTitle>This job isn&rsquo;t available</CardTitle>
            <CardDescription className="mt-2">
              {jobError === "forbidden"
                ? "You don't have access to this job. If you should, ask the office to add you."
                : "We couldn't find that job. It may have been archived or the link is stale."}
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  const readOnly = job?.status === "archived" || job?.archived === true;

  return (
    <AdminShell
      title={job ? `${job.name} · Site diary` : "Site diary"}
      breadcrumb={
        job ? (
          <Link
            href={`/v2/jobs/${jobId}` as Route}
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← {job.name}
          </Link>
        ) : (
          <JobsBreadcrumb />
        )
      }
    >
      <div className="mx-auto max-w-4xl">
        <JobDiary
          jobId={jobId}
          jobName={job?.name ?? jobId}
          initialEntries={[...entries]}
          fetchError={entriesError}
          readOnly={readOnly}
        />
      </div>
    </AdminShell>
  );
}

function JobsBreadcrumb() {
  return (
    <Link
      href="/v2/jobs"
      className="underline decoration-accent-yellow decoration-2 underline-offset-2"
    >
      ← Jobs
    </Link>
  );
}

async function loadJobAndDiary(
  cookieValue: string | undefined,
  jobId: string,
): Promise<{
  job: Job | null;
  jobError: "not_found" | "forbidden" | "error" | null;
  entries: ReadonlyArray<DiaryEntry>;
  entriesError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const init = cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined;

  const [jobRes, diaryRes] = await Promise.allSettled([
    fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, { cache: "no-store", headers: init }),
    fetch(`${base}/api/diary?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: init,
    }),
  ]);

  let job: Job | null = null;
  let jobError: "not_found" | "forbidden" | "error" | null = null;
  if (jobRes.status === "fulfilled") {
    const r = jobRes.value;
    if (r.status === 404) jobError = "not_found";
    else if (r.status === 403) jobError = "forbidden";
    else if (!r.ok) jobError = "error";
    else {
      const body = await r.json().catch(() => null);
      const parsed = JobDetailResponseSchema.safeParse(body);
      if (parsed.success) job = parsed.data.job;
      else jobError = "error";
    }
  } else {
    jobError = "error";
  }

  let entries: ReadonlyArray<DiaryEntry> = [];
  let entriesError: string | null = null;
  if (diaryRes.status === "fulfilled") {
    const r = diaryRes.value;
    if (!r.ok) entriesError = `Diary API returned ${r.status}`;
    else {
      const body = await r.json().catch(() => null);
      const parsed = DiaryListResponseSchema.safeParse(body);
      if (parsed.success) entries = parsed.data.entries;
      else entriesError = "Unexpected diary response shape";
    }
  } else {
    entriesError = diaryRes.reason instanceof Error ? diaryRes.reason.message : "Network error";
  }

  return { job, jobError, entries, entriesError };
}
