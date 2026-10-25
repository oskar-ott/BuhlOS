import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  loadWorkerEntriesInProcess,
  loadFieldJobsInProcess,
  loadIsApprenticeInProcess,
} from "../../../../api/_lib/phil-page-data.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilHoursView } from "@/components/phil/hours/PhilHoursView";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { parseTimeEntryListLenient } from "@/domains/timesheets/parse-entries";
import type { TimeEntry } from "@/domains/timesheets/types";
import { EARLIER_WEEKS_SHOWN, type HoursJob } from "@/domains/timesheets/hours-view";
import {
  BUSINESS_TIMEZONE,
  addDays,
  localDateString,
  parseFixDate,
  weekStartOf,
} from "@/domains/timesheets/service";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import { isVisibleToField } from "@/domains/jobs/builder";
import { philInitials, philSharpenedFlags } from "@/lib/phil/sharpened";

export const dynamic = "force-dynamic";

/**
 * /phil/hours — the worker's Hours screen (docs/phil-hours.md): this week as
 * rows, one bottom panel that names the whole decision, sheets for everything
 * else. Logging, changing a sent day and fixing a sent-back day all live here.
 *
 * Data: the worker's entries back to the oldest week the screen can show
 * (this week + the 12 folded Earlier weeks — the office keeps the rest) and
 * their jobs, read in-process (api/_lib/phil-page-data.js) in ONE wave, plus
 * the apprentice flag for the TAFE option. The finished jobs an old day was
 * logged on are named from the same jobs read (`openable`) — no second trip
 * to the store once the entries are known (2026-10-26: on a ~1.5s store that
 * second wave doubled the load). A failed hours read renders the FAILED
 * state — never an empty week, never a zero. The phil_sharpened flag only
 * picks the shell chrome.
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

  const started = Date.now();
  const [{ entries, loadFailed }, loadedJobs, sharpenedFlags, canLogTafe] = await Promise.all([
    loadHistory(raw, todayISO),
    loadAssignedJobs(raw),
    philSharpenedFlags(session),
    // Apprentice (employee-record role) → the TAFE-day option. Fail-closed.
    loadIsApprenticeInProcess(raw),
  ]);
  // One line per load so production logs show what this screen costs.
  console.log(`[perf] phil/hours data ${Date.now() - started}ms entries=${entries.length}`);

  // Jobs this screen must NAME that are no longer in the default set
  // (docs/job-lifecycle.md): the `?job=` the worker came from and any closed
  // job their own hours reference, so a past row reads the job's name, not
  // "a job you're no longer on". Resolved from the jobs read above — only
  // openable jobs are there, so draft/archived never leak in.
  const listed = new Set(loadedJobs.jobs.map((j) => j.id));
  const referenced = new Set<string>();
  if (launchJobId && !listed.has(launchJobId)) referenced.add(launchJobId);
  for (const e of entries) {
    for (const a of e.allocations ?? []) {
      if (a.jobId && !listed.has(a.jobId)) referenced.add(a.jobId);
    }
  }
  const jobs = withExtraJobs(
    loadedJobs,
    loadedJobs.openable.filter((j) => referenced.has(j.id))
  );

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

async function loadHistory(
  cookieValue: string | undefined,
  todayISO: string
): Promise<{
  entries: ReadonlyArray<TimeEntry>;
  loadFailed: boolean;
}> {
  // In-process read (2026-08-03): same auth + read path as GET
  // /api/time-entries, without a second serverless function's cold start.
  // Bounded to the weeks the screen can show: older days are the office's.
  const fromDate = addDays(weekStartOf(todayISO), -7 * EARLIER_WEEKS_SHOWN);
  try {
    const res = await loadWorkerEntriesInProcess(cookieValue, { fromDate });
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
  extra: ReadonlyArray<HoursJob>
): { jobs: ReadonlyArray<HoursJob>; error: boolean } {
  const have = new Set(loaded.jobs.map((j) => j.id));
  const add = extra.filter((job) => !have.has(job.id));
  return add.length === 0 ? loaded : { ...loaded, jobs: [...loaded.jobs, ...add] };
}

/** The few fields a job record needs on this screen. */
function toHoursJob(j: {
  id: string;
  name: string;
  code?: string | null;
  ref?: string | null;
  siteAddress?: string | null;
  completedAt?: string | null;
  status?: string | null;
}): HoursJob {
  return {
    id: j.id,
    name: j.name,
    ref: j.code ?? j.ref ?? null,
    address: j.siteAddress ?? null,
    completedAt: j.completedAt ?? null,
    status: j.status ?? null,
  };
}

/**
 * The worker's assigned jobs (source of truth: users.json.assignedJobIds; the
 * in-process read already scopes a field caller and strips draft/archived;
 * isVisibleToField is defence-in-depth). `error: true` on any failure so the
 * screen blocks logging honestly rather than sending an unattributed day.
 */
async function loadAssignedJobs(cookieValue: string | undefined): Promise<{
  jobs: ReadonlyArray<HoursJob>;
  /** Every job the crew may still open (closed ones too) — from the same read. */
  openable: ReadonlyArray<HoursJob>;
  error: boolean;
}> {
  try {
    const res = await loadFieldJobsInProcess(cookieValue);
    if (!res.ok) return { jobs: [], openable: [], error: true };
    const parsed = JobListResponseSchema.safeParse({ jobs: res.jobs });
    if (!parsed.success) return { jobs: [], openable: [], error: true };
    const jobs = parsed.data.jobs.filter((j) => isVisibleToField(j)).map(toHoursJob);
    const openableParsed = JobListResponseSchema.safeParse({ jobs: res.openable ?? [] });
    const openable = openableParsed.success ? openableParsed.data.jobs.map(toHoursJob) : [];
    return { jobs, openable, error: false };
  } catch {
    return { jobs: [], openable: [], error: true };
  }
}
