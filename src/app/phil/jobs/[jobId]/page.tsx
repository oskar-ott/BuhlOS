import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
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
import { parseJobTaskState, type JobTaskState } from "@/domains/jobs/taskState";
import { EvidenceListResponseSchema } from "@/domains/evidence/schema";
import { SnagListResponseSchema } from "@/domains/snags/schema";
import { ObservationListResponseSchema } from "@/domains/observations/schema";
import { ITPListResponseSchema } from "@/domains/itp/schema";
import { DocumentListResponseSchema } from "@/domains/documents/schema";
import { ServiceLocationListResponseSchema } from "@/domains/services-locations/schema";
import { blobJobControlReadDeps, readJobControlForField } from "@/server/job-control/read";
import type { Job } from "@/domains/jobs/types";
import type { EvidenceLink, ProofReview, WorkPackage } from "@/domains/job-control/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { SnagItem } from "@/domains/snags/types";
import type { ObservationItem } from "@/domains/observations/types";
import type { ITPInstance } from "@/domains/itp/types";
import type { Document } from "@/domains/documents/types";
import type { ServiceLocationRecord } from "@/domains/services-locations/types";

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
  const sharpenedFlags = await philSharpenedFlags(session);
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
      >
        {/* #145: remember this open so the jobs list can surface it in Recent. */}
        <PhilJobViewRecorder userId={viewerId} jobId={jobId} />
        {await PhilJobDetailFull({
          raw,
          jobId,
          captureToken,
          viewerId,
          viewerRole,
          streamTaskState: false,
          jobRooms: sharpenedFlags.jobRooms,
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
          streamTaskState
          jobRooms={sharpenedFlags.jobRooms}
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
  streamTaskState,
  jobRooms,
}: {
  raw: string | undefined;
  jobId: string;
  captureToken: string | null;
  viewerId: string;
  viewerRole: string;
  /** When true (flag-on), the slow taskState read (/api/data, ~3-5s — its
   *  task+evidence status overlays are the new long pole after the job-detail
   *  projection) is LIFTED out of the blocking Promise.all and streamed into
   *  PhilJobDetail as a promise, so the job structure (the LCP element) paints
   *  ~3s sooner. Flag-off keeps the original 11-read blocking load verbatim. */
  streamTaskState: boolean;
  /** phil_job_rooms (dark, #133): render the four-rooms takeover. Resolved by
   *  the page via philSharpenedFlags (jobRooms ⇒ sharpened enforced there). */
  jobRooms: boolean;
}) {
  // Start the streamed taskState read in parallel with the wave-one reads, but
  // DON'T await it here — it resolves into PhilJobDetail behind a nested Suspense.
  // The `.catch` is belt-and-braces: loadInitialTaskState already never rejects
  // (it try/catches into {state,error}), but the consumer reads this with use()
  // and has no error boundary — so we guarantee a resolved value even if that
  // invariant ever changes; a failure surfaces as the honest "couldn't load
  // progress" notice, never an uncaught throw.
  const taskStatePromise = streamTaskState
    ? loadInitialTaskState(raw, jobId).catch(() => ({
        state: {} as JobTaskState,
        error: "Couldn't load task progress",
      }))
    : null;

  const [
    result,
    initialEvidence,
    initialSnags,
    initialObservations,
    initialItps,
    documentsResult,
    taskStateResult,
    tagsResult,
    initialContacts,
    initialMyInduction,
    jobControlResult,
    serviceLocationsResult,
  ] = await Promise.all([
    loadJob(raw, jobId),
    loadInitialEvidence(raw, jobId),
    loadInitialSnags(raw, jobId),
    loadInitialObservations(raw, jobId),
    loadInitialItps(raw, jobId),
    loadInitialDocuments(raw, jobId),
    // Streamed → keep the slot a cheap no-op (taskState arrives via the promise);
    // otherwise the original blocking read (byte-identical to pre-change).
    streamTaskState ? Promise.resolve(null) : loadInitialTaskState(raw, jobId),
    loadInitialTags(raw, jobId),
    loadInitialContacts(raw, jobId),
    loadInitialMyInduction(raw, jobId),
    loadInitialJobControl(jobId),
    loadInitialServiceLocations(raw, jobId),
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

  // #219: env-only flag read (no blob, off the LCP path) — mount the Safety
  // home section only when the flag is on; otherwise it isn't even mounted, so
  // a dark prod fires zero extra requests on the field home.
  const safetyDocsRaw = (process.env.FLAG_SAFETY_DOCS ?? "").toLowerCase();
  const safetyEnabled =
    safetyDocsRaw === "1" || safetyDocsRaw === "true" || safetyDocsRaw === "on";
  const certsRaw = (process.env.FLAG_CERTIFICATES_REGISTER ?? "").toLowerCase();
  const certificatesEnabled = certsRaw === "1" || certsRaw === "true" || certsRaw === "on";

  return (
    <PhilJobDetail
      job={result.job}
      initialEvidence={initialEvidence}
      initialSnags={initialSnags}
      initialObservations={initialObservations}
      initialItps={initialItps}
      initialDocuments={documentsResult.documents}
      documentsError={documentsResult.error}
      initialTags={tagsResult.tags}
      tagsError={tagsResult.error}
      initialContacts={initialContacts}
      initialServiceLocations={serviceLocationsResult.locations}
      serviceLocationsError={serviceLocationsResult.error}
      initialMyInduction={initialMyInduction}
      initialTaskState={taskStateResult ? taskStateResult.state : undefined}
      taskStateError={taskStateResult ? taskStateResult.error : null}
      taskStatePromise={taskStatePromise ?? undefined}
      viewer={{ id: viewerId, role: viewerRole }}
      workPackages={jobControlResult.workPackages}
      evidenceLinks={jobControlResult.evidenceLinks}
      proofReviews={jobControlResult.proofReviews}
      jobControlRevision={jobControlResult.revision}
      autoCaptureToken={captureToken}
      safetyEnabled={safetyEnabled}
      certificatesEnabled={certificatesEnabled}
      rooms={jobRooms}
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

/**
 * Fetch the observations for this job (#504 — the real blocker source). Server
 * returns the job's observations the viewer may see. Non-blocking: a failure
 * returns [] and nothing is treated as blocked. Mirrors loadInitialSnags.
 */
async function loadInitialObservations(
  cookieValue: string | undefined,
  jobId: string
): Promise<ObservationItem[]> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/observations?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      }
    );
    if (!res.ok) return [];
    const body = await res.json();
    const parsed = ObservationListResponseSchema.safeParse(body);
    if (!parsed.success) return [];
    return [...parsed.data.observations];
  } catch {
    return [];
  }
}

/**
 * Fetch the ITP instances for this job (Phase E1b). Server returns
 * every attached instance the viewer is allowed to see — admin/LH see
 * all; tradies see the ones on their assigned jobs. Non-blocking: a
 * failure returns [] and the JobItpPanel shows its empty state.
 *
 * Mirrors loadInitialEvidence / loadInitialSnags so the panel renders
 * server-rendered content on first paint without a client-side spinner.
 */
async function loadInitialItps(
  cookieValue: string | undefined,
  jobId: string
): Promise<ITPInstance[]> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/job-itps?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      }
    );
    if (!res.ok) return [];
    const body = await res.json();
    const parsed = ITPListResponseSchema.safeParse(body);
    if (!parsed.success) return [];
    return [...parsed.data.instances];
  } catch {
    return [];
  }
}

/**
 * Fetch the documents (plans + specs) for this job (Phase E2). Server
 * already strips `status === 'archived'` for non-admin callers; the
 * panel further filters to `status === 'current'` for safety.
 *
 * Returns a `{ documents, error }` shape rather than a bare array so
 * the panel can surface a non-blocking info bar when the fetch failed
 * but the page can still render. Matches the EvidenceQueue + ITPsQueue
 * pattern of "fall back to empty + show an info banner."
 */
async function loadInitialDocuments(
  cookieValue: string | undefined,
  jobId: string
): Promise<{ documents: Document[]; error: string | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/plans?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      }
    );
    if (!res.ok) {
      // 403 means the worker isn't assigned to this job — the page
      // render above already 403'd them out, so we just degrade.
      // Other statuses surface as a non-blocking banner.
      return {
        documents: [],
        error: res.status === 403 ? null : `Plans API returned ${res.status}`,
      };
    }
    const body = await res.json();
    const parsed = DocumentListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { documents: [], error: "Unexpected plans response shape" };
    }
    return { documents: [...parsed.data.plans], error: null };
  } catch (err) {
    return {
      documents: [],
      error: err instanceof Error ? err.message : "Plans network error",
    };
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
 * #230: services-locations register for this job (where the pit/board/meter/
 * temp-supply are). Server returns every record to any reader on the job (no
 * own-captures filter) — the photos are denormalised so worker B sees worker A's
 * board photo. Returns a `{ locations, error }` shape so the card can surface a
 * quiet notice on a fetch failure while still rendering. Fail-soft to empty +
 * error=false on a 403 (the page-level gate already handles a non-assigned open).
 */
async function loadInitialServiceLocations(
  cookieValue: string | undefined,
  jobId: string
): Promise<{ locations: ServiceLocationRecord[]; error: string | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/services-locations?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
      }
    );
    if (!res.ok) {
      return { locations: [], error: res.status === 403 ? null : `Services API returned ${res.status}` };
    }
    const parsed = ServiceLocationListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { locations: [], error: "Unexpected services response shape" };
    return { locations: [...parsed.data.locations], error: null };
  } catch (err) {
    return {
      locations: [],
      error: err instanceof Error ? err.message : "Services network error",
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

/**
 * L2/L3: the compiled job-control read for this job — the field-safe
 * `{ workPackages, evidenceLinks }` subset that drives per-task scope context
 * (#368) in PhilJobDetail. Read DIRECTLY server-side (no new public endpoint);
 * it runs only after the job-access gate above (`result.kind === "ok"`), so it
 * is no more exposed than the rest of this page's job fetch.
 *
 * FAILS SOFT to empty for BOTH a missing artifact (the normal case — most jobs
 * aren't compiled yet) and an unreadable one, so a worker is never blocked: Phil
 * then renders exactly as it does today (zero regression).
 */
async function loadInitialJobControl(
  jobId: string
): Promise<{ workPackages: WorkPackage[]; evidenceLinks: EvidenceLink[]; proofReviews: ProofReview[]; revision?: string }> {
  try {
    const r = await readJobControlForField(blobJobControlReadDeps(), jobId);
    if (r.ok && r.ready) {
      return { workPackages: r.workPackages, evidenceLinks: r.evidenceLinks, proofReviews: r.proofReviews, revision: r.meta.revision };
    }
    return { workPackages: [], evidenceLinks: [], proofReviews: [] };
  } catch {
    return { workPackages: [], evidenceLinks: [], proofReviews: [] };
  }
}

async function loadInitialTaskState(
  cookieValue: string | undefined,
  jobId: string
): Promise<{ state: JobTaskState; error: string | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/data?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      }
    );
    if (!res.ok) return { state: {}, error: `Task state API returned ${res.status}` };
    const body = await res.json();
    return { state: parseJobTaskState(body), error: null };
  } catch (err) {
    return {
      state: {},
      error: err instanceof Error ? err.message : "Task state network error",
    };
  }
}
