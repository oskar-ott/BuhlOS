import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PhilJobDetail } from "@/components/phil/PhilJobDetail";
import {
  MyInductionResponseSchema,
  type InductionRecord,
} from "@/domains/jobs/induction";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { TagListResponseSchema, type TagItem } from "@/domains/tags/schema";
import { JobContactsResponseSchema, type JobContact } from "@/domains/contacts/schema";
import { parseJobTaskState, type JobTaskState } from "@/domains/jobs/taskState";
import { EvidenceListResponseSchema } from "@/domains/evidence/schema";
import { SnagListResponseSchema } from "@/domains/snags/schema";
import { ObservationListResponseSchema } from "@/domains/observations/schema";
import { ITPListResponseSchema } from "@/domains/itp/schema";
import { DocumentListResponseSchema } from "@/domains/documents/schema";
import { blobJobControlReadDeps, readJobControlForField } from "@/server/job-control/read";
import type { Job } from "@/domains/jobs/types";
import type { EvidenceLink, WorkPackage } from "@/domains/job-control/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { SnagItem } from "@/domains/snags/types";
import type { ObservationItem } from "@/domains/observations/types";
import type { ITPInstance } from "@/domains/itp/types";
import type { Document } from "@/domains/documents/types";

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

  const result = await loadJob(raw, jobId);
  // Initial evidence + snags + ITPs + documents load happens
  // server-side so the panels render with content already present on
  // first paint — no client-side spinner for the empty case. Failure
  // is non-blocking: an empty list just shows the empty state, the
  // worker can still create new items, and the server will return
  // real data on the next refresh.
  const [initialEvidence, initialSnags, initialObservations, initialItps, documentsResult, taskStateResult, tagsResult, initialContacts, initialMyInduction, jobControlResult] =
    result.kind === "ok"
      ? await Promise.all([
          loadInitialEvidence(raw, jobId),
          loadInitialSnags(raw, jobId),
          loadInitialObservations(raw, jobId),
          loadInitialItps(raw, jobId),
          loadInitialDocuments(raw, jobId),
          loadInitialTaskState(raw, jobId),
          loadInitialTags(raw, jobId),
          loadInitialContacts(raw, jobId),
          loadInitialMyInduction(raw, jobId),
          loadInitialJobControl(jobId),
        ])
      : [
          [],
          [],
          [],
          [],
          { documents: [] as Document[], error: null as string | null },
          { state: {} as JobTaskState, error: null as string | null },
          { tags: [] as TagItem[], error: false },
          [] as JobContact[],
          null as InductionRecord | null,
          {
            workPackages: [] as WorkPackage[],
            evidenceLinks: [] as EvidenceLink[],
            revision: undefined as string | undefined,
          },
        ];

  if (result.kind === "not_found" || result.kind === "forbidden") {
    return (
      <PhilShell title="Job">
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
      </PhilShell>
    );
  }

  if (result.kind === "error") {
    return (
      <PhilShell title="Job">
        <div className="space-y-4">
          <PhilBackLink href="/phil/jobs">All jobs</PhilBackLink>
          <PhilNotice tone="warning" title="Couldn’t load this job" role="alert">
            <p>{result.message}.</p>
            <div className="mt-3">
              <RefreshButton />
            </div>
          </PhilNotice>
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
        initialObservations={initialObservations}
        initialItps={initialItps}
        initialDocuments={documentsResult.documents}
        documentsError={documentsResult.error}
        initialTags={tagsResult.tags}
        tagsError={tagsResult.error}
        initialContacts={initialContacts}
        initialMyInduction={initialMyInduction}
        initialTaskState={taskStateResult.state}
        taskStateError={taskStateResult.error}
        viewer={{
          id: session.userId ?? session.sub ?? "",
          role: String(session.role ?? ""),
        }}
        workPackages={jobControlResult.workPackages}
        evidenceLinks={jobControlResult.evidenceLinks}
        jobControlRevision={jobControlResult.revision}
        autoCaptureToken={captureToken}
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
): Promise<{ workPackages: WorkPackage[]; evidenceLinks: EvidenceLink[]; revision?: string }> {
  try {
    const r = await readJobControlForField(blobJobControlReadDeps(), jobId);
    if (r.ok && r.ready) {
      return { workPackages: r.workPackages, evidenceLinks: r.evidenceLinks, revision: r.meta.revision };
    }
    return { workPackages: [], evidenceLinks: [] };
  } catch {
    return { workPackages: [], evidenceLinks: [] };
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
