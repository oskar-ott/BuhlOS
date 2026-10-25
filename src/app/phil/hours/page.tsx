import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  loadWorkerEntriesInProcess,
  loadFieldJobsInProcess,
  loadFieldJobsByIdInProcess,
  loadIsApprenticeInProcess,
} from "../../../../api/_lib/phil-page-data.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilHoursView } from "@/components/phil/hours/PhilHoursView";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { parseTimeEntryListLenient } from "@/domains/timesheets/parse-entries";
import type { TimeEntry } from "@/domains/timesheets/types";
import type { HoursJob } from "@/domains/timesheets/hours-view";
import { BUSINESS_TIMEZONE, localDateString, parseFixDate } from "@/domains/timesheets/service";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import { isVisibleToField } from "@/domains/jobs/builder";
import { philInitials, philSharpenedFlags } from "@/lib/phil/sharpened";

export const dynamic = "force-dynamic";

/**
 * /phil/hours — the worker's Hours screen (docs/phil-hours.md): this week as
 * rows, one bottom panel that names the whole decision, sheets for everything
 * else. Logging, changing a sent day and fixing a sent-back day all live here.
 *
 * Data: the worker's full entry history and their assigned jobs, read
 * in-process (api/_lib/phil-page-data.js), plus the apprentice flag for the
 * TAFE option. A failed hours read renders the FAILED state — never an empty
 * week, never a zero. The phil_sharpened flag only picks the shell chrome.
 *
 * Arrival params: `?log=1` (My Day's "Log hours now" — today is picked),
 * `?job=` (a job screen's "Log hours" — that job picked for today),
 * `?fix=YYYY-MM-DD` (a sent-back day — its Fix sheet opens).
 */
export default async function PhilHoursPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; log?: string; fix?: string }>;
}) {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/phil/hours");
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }

  const sp = await searchParams;
  const todayISO = localDateString(new Date(), BUSINESS_TIMEZONE);
  const launchJobId = typeof sp.job === "string" && sp.job ? sp.job : null;
  const launchLog = sp.log === "1";
  const launchFixDate = parseFixDate(sp.fix);

  const [{ entries, loadFailed }, loadedJobs, sharpenedFlags, canLogTafe] = await Promise.all([
    loadHistory(raw),
    loadAssignedJobs(raw),
    philSharpenedFlags(session),
    // Apprentice (employee-record role) → the TAFE-day option. Fail-closed.
    loadIsApprenticeInProcess(raw),
  ]);

  // Jobs this screen must NAME that are no longer in the default set
  // (docs/job-lifecycle.md): the `?job=` the worker came from and any closed
  // job their own hours reference, so a past row reads the job's name, not
  // "a job you're no longer on". Loaded by id; only openable jobs come back.
  const listed = new Set(loadedJobs.jobs.map((j) => j.id));
  const referenced = new Set<string>();
  if (launchJobId && !listed.has(launchJobId)) referenced.add(launchJobId);
  for (const e of entries) {
    for (const a of e.allocations ?? []) {
      if (a.jobId && !listed.has(a.jobId)) referenced.add(a.jobId);
    }
  }
  const extraRecords =
    referenced.size > 0 ? await loadFieldJobsByIdInProcess(raw, [...referenced]) : [];
  const jobs = withExtraJobs(loadedJobs, extraRecords);

  return (
    <PhilShell
      title="Hours"
      userId={session.userId ?? ""}
      sharpened={sharpenedFlags.sharpened}
      jobRoomsEnabled={sharpenedFlags.jobRooms}
      accountInitials={philInitials(session.name ?? session.username)}
    >
      <PhilHoursView
        entries={entries}
        loadFailed={loadFailed}
        todayISO={todayISO}
        jobs={jobs.jobs}
        jobsError={jobs.error}
        viewerId={session.userId ?? null}
        canLogTafe={canLogTafe}
        launchLog={launchLog}
        launchJobId={launchJobId}
        launchFixDate={launchFixDate}
      />
    </PhilShell>
  );
}

async function loadHistory(cookieValue: string | undefined): Promise<{
  entries: ReadonlyArray<TimeEntry>;
  loadFailed: boolean;
}> {
  // In-process read (2026-08-03): same auth + read path as GET
  // /api/time-entries, without a second serverless function's cold start.
  try {
    const res = await loadWorkerEntriesInProcess(cookieValue);
    if (!res.ok) return { entries: [], loadFailed: true };
    const parsed = parseTimeEntryListLenient({ entries: res.entries });
    if (!parsed.ok) return { entries: [], loadFailed: true };
    if (parsed.dropped > 0) {
      console.warn(
        `phil/hours: skipped ${parsed.dropped} malformed time entr${parsed.dropped === 1 ? "y" : "ies"}`
      );
    }
    return { entries: parsed.entries, loadFailed: false };
  } catch (err) {
    console.error("phil/hours: hours read failed", err instanceof Error ? err.message : err);
    return { entries: [], loadFailed: true };
  }
}

/** Append openable jobs the screen must name that aren't in the default set. */
function withExtraJobs(
  loaded: { jobs: ReadonlyArray<HoursJob>; error: boolean },
  records: ReadonlyArray<Record<string, unknown>>
): { jobs: ReadonlyArray<HoursJob>; error: boolean } {
  if (records.length === 0) return loaded;
  const parsed = JobListResponseSchema.safeParse({ jobs: records });
  if (!parsed.success) return loaded;
  const have = new Set(loaded.jobs.map((j) => j.id));
  const extra: HoursJob[] = parsed.data.jobs
    .filter((job) => !have.has(job.id))
    .map((job) => ({
      id: job.id,
      name: job.name,
      ref: job.code ?? job.ref ?? null,
      address: job.siteAddress ?? null,
      completedAt: job.completedAt ?? null,
      status: job.status ?? null,
    }));
  return extra.length === 0 ? loaded : { ...loaded, jobs: [...loaded.jobs, ...extra] };
}

/**
 * The worker's assigned jobs (source of truth: users.json.assignedJobIds; the
 * in-process read already scopes a field caller and strips draft/archived;
 * isVisibleToField is defence-in-depth). `error: true` on any failure so the
 * screen blocks logging honestly rather than sending an unattributed day.
 */
async function loadAssignedJobs(cookieValue: string | undefined): Promise<{
  jobs: ReadonlyArray<HoursJob>;
  error: boolean;
}> {
  try {
    const res = await loadFieldJobsInProcess(cookieValue);
    if (!res.ok) return { jobs: [], error: true };
    const parsed = JobListResponseSchema.safeParse({ jobs: res.jobs });
    if (!parsed.success) return { jobs: [], error: true };
    const jobs = parsed.data.jobs
      .filter((j) => isVisibleToField(j))
      .map((j) => ({
        id: j.id,
        name: j.name,
        ref: j.code ?? j.ref ?? null,
        address: j.siteAddress ?? null,
        completedAt: j.completedAt ?? null,
        status: j.status ?? null,
      }));
    return { jobs, error: false };
  } catch {
    return { jobs: [], error: true };
  }
}
