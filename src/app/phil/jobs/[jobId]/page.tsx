import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PhilJobBasicView } from "@/components/phil/PhilJobBasicView";
import { PhilJobViewRecorder } from "@/components/phil/PhilJobViewRecorder";
import { PhilJobDetailShell, type JobShellHeader } from "@/components/phil/PhilJobDetailShell";
import {
  MyInductionResponseSchema,
  type InductionRecord,
} from "@/domains/jobs/induction";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { philInitials, philSharpenedFlags } from "@/lib/phil/sharpened";
import { JobDetailResponseSchema, JobListResponseSchema } from "@/domains/jobs/schema";
import type { Job } from "@/domains/jobs/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /phil/jobs/[jobId] — the basic job view (the "start afresh" reset).
 *
 * Tapping a job shows its basic information only: hero, dates, site details
 * (with the #332 induction confirm). The bottom rooms bar keeps Work · Proof ·
 * Site as labelled coming-soon placeholders. The former work/capture/tags/ITP
 * machinery was deleted to be rebuilt — see PhilJobBasicView's header note.
 *
 * Server component:
 *   1. Gates auth + Phil-surface access (middleware also gates).
 *   2. Fetches /api/jobs?id=<jobId> (+ the worker's induction record),
 *      forwarding the session cookie.
 *   3. Branches on the response code:
 *        - 200 → render <PhilJobBasicView job={...} />
 *        - 403 / 404 → render a "not yours" card with a link back to /phil/jobs
 *        - other → render a non-blocking error card
 *
 * Cross-ref:
 *   src/components/phil/PhilJobBasicView.tsx — the view
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

  const viewerId = session.userId ?? session.sub ?? "";

  // Sharpened chrome + the in-job rooms bar. Resolved ONCE server-side
  // (cached flags.json); philSharpenedFlags enforces jobRooms ⇒ sharpened.
  const sharpenedFlags = await philSharpenedFlags(session);
  const accountInitials = philInitials(session.name ?? session.username);

  // Fast shell gate — same flag + reasoning as before the reset: the shell's
  // header read is only summary-fast when FLAG_PHIL_JOBS_SUMMARY_READ is on;
  // with it off, shell-then-stream would be two full reads.
  const flagRaw = (process.env.FLAG_PHIL_JOBS_SUMMARY_READ ?? "").toLowerCase();
  const summaryShellOn = flagRaw === "1" || flagRaw === "true" || flagRaw === "on";

  if (!summaryShellOn) {
    return (
      <PhilShell
        title="Job"
        userId={viewerId}
        sharpened={sharpenedFlags.sharpened}
        accountInitials={accountInitials}
        roomsActive={sharpenedFlags.jobRooms}
        jobRoomsEnabled={sharpenedFlags.jobRooms}
      >
        {/* #145: remember this open so the jobs list can surface it in Recent. */}
        <PhilJobViewRecorder userId={viewerId} jobId={jobId} />
        {await PhilJobBasicFull({ raw, jobId })}
      </PhilShell>
    );
  }

  const shellHeader = await loadJobShell(raw, jobId);

  return (
    <PhilShell
      title={shellHeader?.name ?? "Job"}
      userId={viewerId}
      sharpened={sharpenedFlags.sharpened}
      accountInitials={accountInitials}
      roomsActive={sharpenedFlags.jobRooms}
      jobRoomsEnabled={sharpenedFlags.jobRooms}
    >
      {/* #145: remember this open so the jobs list can surface it in Recent. */}
      <PhilJobViewRecorder userId={viewerId} jobId={jobId} />
      <Suspense fallback={<PhilJobDetailShell header={shellHeader} />}>
        <PhilJobBasicFull raw={raw} jobId={jobId} />
      </Suspense>
    </PhilShell>
  );
}

/**
 * The authoritative job read (visibility: not_found/forbidden) + the worker's
 * induction record, streamed behind the summary-backed shell when the fast
 * shell is on. Induction fails soft to null — the site card then shows the
 * static "required" warning (never a phantom "done").
 */
async function PhilJobBasicFull({
  raw,
  jobId,
}: {
  raw: string | undefined;
  jobId: string;
}) {
  const [result, initialMyInduction] = await Promise.all([
    loadJob(raw, jobId),
    loadInitialMyInduction(raw, jobId),
  ]);

  if (result.kind === "not_found" || result.kind === "forbidden") {
    return (
      <div className="space-y-4">
        <PhilBackLink href="/phil/jobs">All jobs</PhilBackLink>
        <Card>
          <CardTitle>This job isn&rsquo;t assigned to you</CardTitle>
          <CardDescription className="mt-2">
            {result.kind === "forbidden"
              ? "You don't have access to this job. If you should, ask your PM to add you."
              : "We couldn't find that job. It may have been archived or the link is out of date."}
          </CardDescription>
        </Card>
      </div>
    );
  }

  if (result.kind === "error") {
    return (
      <div className="space-y-4">
        <PhilBackLink href="/phil/jobs">All jobs</PhilBackLink>
        <PhilNotice tone="warning" title="Couldn’t load this job" role="alert">
          <p>{result.message}.</p>
          <div className="mt-3">
            <RefreshButton />
          </div>
        </PhilNotice>
      </div>
    );
  }

  return (
    <PhilJobBasicView job={result.job} initialMyInduction={initialMyInduction} />
  );
}

/**
 * Lightweight job header for the fast shell, sourced from the field jobs list
 * (the jobs-summary projection): visibility-scoped and money-redacted by
 * construction. Fails soft to null.
 */
async function loadJobShell(
  cookieValue: string | undefined,
  jobId: string
): Promise<JobShellHeader | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/jobs`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return null;
    const parsed = JobListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const job = parsed.data.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    return {
      id: job.id,
      name: job.name,
      status: job.status as JobShellHeader["status"],
      ref: job.ref ?? null,
      siteAddress: job.siteAddress ?? null,
      typeName: (job as { typeName?: string | null }).typeName ?? null,
    };
  } catch {
    return null;
  }
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
 * #332: this worker's latest induction record on this job. Fail-soft to
 * null — the site card then shows the static "required" warning, which is
 * the safe direction for a compliance prompt (never a phantom "done").
 */
async function loadInitialMyInduction(
  cookieValue: string | undefined,
  jobId: string
): Promise<InductionRecord | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/job-inductions?jobId=${encodeURIComponent(jobId)}&mine=1`,
      {
        cache: "no-store",
        headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
      }
    );
    if (!res.ok) return null;
    const parsed = MyInductionResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.record;
  } catch {
    return null;
  }
}
