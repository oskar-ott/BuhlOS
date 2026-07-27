import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PhilJobDetail } from "@/components/phil/PhilJobDetail";
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
import { TagListResponseSchema, type TagItem } from "@/domains/tags/schema";
import { JobContactsResponseSchema, type JobContact } from "@/domains/contacts/schema";
import { parseJobTaskState } from "@/domains/jobs/taskState";
import { EvidenceListResponseSchema } from "@/domains/evidence/schema";
import type { Job } from "@/domains/jobs/types";
import type { EvidenceItem } from "@/domains/evidence/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ capture?: string | string[] }>;
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
export default async function PhilJobDetailPage({ params, searchParams }: PageParams) {
  const { jobId } = await params;
  const sp = await searchParams;
  // `?capture=<token>` deep link from the global Capture launcher — a
  // fresh token each tap so the detail view re-opens the sheet even on
  // a repeat launch of the same job.
  const captureToken = typeof sp.capture === "string" ? sp.capture : null;

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
  const viewerRole = String(session.role ?? "");

  // Sharpened chrome + the in-job four-rooms takeover (phil_job_rooms — the
  // filed #133 experiment). Resolved ONCE server-side (cached flags.json);
  // philSharpenedFlags enforces jobRooms ⇒ sharpened, so with either flag off
  // the job screen (and its chrome) renders exactly as today. Booleans only —
  // never the flags blob (docs/feature-flags.md).
  const [sharpenedFlags, itpSimpleEnabled, photosGalleryEnabled] = await Promise.all([
    philSharpenedFlags(session),
    isFlagEnabled("itp_simple", session),
    // #915: the gallery card is data-driven — without the flag it would
    // render a dead link to a flag-gated 404 route.
    isFlagEnabled("job_photos", session),
  ]);
  const accountInitials = philInitials(session.name ?? session.username);

  // Gate the fast shell behind the SAME flag as the jobs-summary read path
  // (FLAG_PHIL_JOBS_SUMMARY_READ). The shell sources its header from /api/jobs,
  // which is summary-fast ONLY when that flag is on; with the flag OFF the list
  // is a full read, so shell-then-stream would be TWO full reads (a regression).
  // So flag-off = the prior single-read behaviour exactly (no shell, no stream);
  // flag-on (prod) = summary-backed shell + streamed detail. This also makes the
  // flag a clean rollback for the whole job-detail change. Env-only check (no
  // blob read), matching api/_lib/feature-flags isFlagOnSync / parseEnv.
  const flagRaw = (process.env.FLAG_PHIL_JOBS_SUMMARY_READ ?? "").toLowerCase();
  const summaryShellOn = flagRaw === "1" || flagRaw === "true" || flagRaw === "on";

  if (!summaryShellOn) {
    // Flag off → prior behaviour: block on the full load, render directly.
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
        {await PhilJobDetailFull({
          raw,
          jobId,
          captureToken,
          viewerId,
          viewerRole,
          jobRooms: sharpenedFlags.jobRooms,
          itpSimpleEnabled,
          photosGalleryEnabled,
        })}
      </PhilShell>
    );
  }

  // Fast shell (Phil mobile LCP): the job's full structure read (/api/jobs?id=)
  // still reads the whole jobs.json monolith (~3.5s). Rather than block first
  // paint on that + its ten sub-loads, render a USEFUL header NOW from the cheap
  // jobs-summary list (name/status/ref/site/type — the same data /phil/jobs
  // shows, already visibility-scoped + redacted), then stream the heavy full
  // detail below behind <Suspense>. Mirrors the My Day streaming pattern (#673).
  // The full read in <PhilJobDetailFull> stays authoritative for visibility +
  // the complete task/stage/proof structure; PhilJobDetail itself is unchanged.
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
        <PhilJobDetailFull
          raw={raw}
          jobId={jobId}
          captureToken={captureToken}
          viewerId={viewerId}
          viewerRole={viewerRole}
          jobRooms={sharpenedFlags.jobRooms}
          itpSimpleEnabled={itpSimpleEnabled}
          photosGalleryEnabled={photosGalleryEnabled}
        />
      </Suspense>
    </PhilShell>
  );
}

/**
 * Streamed full job detail — the existing data path (the job read + its ten
 * parallel sub-resource loads, #670/#674) and the UNCHANGED <PhilJobDetail>
 * render, moved into an async server component so the summary-backed shell paints
 * first. This is the AUTHORITATIVE read for visibility (not_found/forbidden) and
 * the full task/stage/proof structure. Sub-loaders fail soft to empty and their
 * results are only read when the job itself loaded; a forbidden/not-found open
 * discards them (no side effects).
 */
async function PhilJobDetailFull({
  raw,
  jobId,
  captureToken,
  viewerId,
  viewerRole,
  jobRooms,
  itpSimpleEnabled,
  photosGalleryEnabled,
}: {
  raw: string | undefined;
  jobId: string;
  captureToken: string | null;
  viewerId: string;
  viewerRole: string;
  /** phil_job_rooms (dark, #133): render the four-rooms takeover. Resolved by
   *  the page via philSharpenedFlags (jobRooms ⇒ sharpened enforced there). */
  jobRooms: boolean;
  /** itp_simple (#912): link-out card only — the builder route/API 404 dark. */
  itpSimpleEnabled: boolean;
  /** #915: gate for the data-driven gallery card, whose route 404s dark. */
  photosGalleryEnabled: boolean;
}) {
  // Lean reset step 5 (#916): the work-to-do machinery left the job page —
  // no task-state read (blocking or streamed), no job-control spine read, no
  // documents/services reads. Restore from git if structure returns.
  const [result, initialEvidence, tagsResult, initialContacts, initialMyInduction] =
    await Promise.all([
      loadJob(raw, jobId),
      loadInitialEvidence(raw, jobId),
      loadInitialTags(raw, jobId),
      loadInitialContacts(raw, jobId),
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
    <PhilJobDetail
      job={result.job}
      initialEvidence={initialEvidence}
      initialTags={tagsResult.tags}
      tagsError={tagsResult.error}
      initialContacts={initialContacts}
      initialMyInduction={initialMyInduction}
      viewer={{ id: viewerId, role: viewerRole }}
      autoCaptureToken={captureToken}
      itpSimpleEnabled={itpSimpleEnabled}
      photosGalleryEnabled={photosGalleryEnabled}
    />
  );
}

/**
 * Lightweight job header for the fast shell, sourced from the field jobs list
 * (the jobs-summary projection): visibility-scoped (only this worker's assigned,
 * non-draft/archived jobs) and money-redacted by construction. A job not in the
 * list → null → the shell shows a header-less skeleton and the streamed full
 * read returns the authoritative not-found/forbidden view. Fails soft to null.
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
 * Fetch worker-visible task state from the per-job data blob
 * (GET /api/data → { dwellings, snags, notes }). `parseJobTaskState` keeps
 * only the rough-in / fit-off task maps and coerces each value to a real
 * three-state string; the snags in this blob are ignored here (the snag panel
 * loads its own from /api/snags). The endpoint is gated by job access, so a
 * worker only ever reads state for a job they're assigned to.
 *
 * Non-blocking by design: any failure returns an empty map plus an honest
 * warning. Every task then reads as "to do" until the next refresh, but the
 * worker is told progress could not be loaded and any toggle still reconciles
 * from the server-confirmed response.
 */
/**
 * Test & tag entries for the job-page section + command signal (#388).
 * FAILS SOFT to an error FLAG (not a message): the section card shows a
 * retry notice and the command model treats the count as unknown.
 */
async function loadInitialTags(
  cookieValue: string | undefined,
  jobId: string
): Promise<{ tags: TagItem[]; error: boolean }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/tags?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue
        ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
        : undefined,
    });
    if (!res.ok) {
      return { tags: [], error: res.status !== 403 };
    }
    const parsed = TagListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { tags: [], error: true };
    return { tags: [...parsed.data.tags], error: false };
  } catch {
    return { tags: [], error: true };
  }
}

/** Categorised job contacts (#189) — fail-soft to none; the card hides itself. */
async function loadInitialContacts(
  cookieValue: string | undefined,
  jobId: string
): Promise<JobContact[]> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/contacts?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return [];
    const parsed = JobContactsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return [];
    return [...parsed.data.contacts];
  } catch {
    return [];
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


