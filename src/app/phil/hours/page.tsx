import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { RejectedHoursResubmitSheet } from "@/components/phil/RejectedHoursResubmitSheet";
import { PhilWeekSummary } from "@/components/phil/PhilWeekSummary";
import { PhilHoursSharpened } from "@/components/phil/PhilHoursSharpened";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { parseTimeEntryListLenient } from "@/domains/timesheets/parse-entries";
import type { TimeEntry } from "@/domains/timesheets/types";
import { canResubmitInPhil, type AssignableJob } from "@/domains/timesheets/resubmit";
import { BUSINESS_TIMEZONE, localDateString } from "@/domains/timesheets/service";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import { isVisibleToField } from "@/domains/jobs/builder";
import { philInitials, philSharpenedFlags } from "@/lib/phil/sharpened";
import {
  formatDateLabel,
  formatHoursLabel,
  formatTimestamp,
  statusLabel,
  statusTone,
} from "@/domains/timesheets/format";

// Bridge the timesheets-domain tone vocabulary into the shared StatusChip
// palette. statusTone() returns a narrower union (neutral/info/success/
// danger) for hours; the explicit record keeps both sides honest if
// either side widens.
const HOURS_CHIP_TONE: Record<ReturnType<typeof statusTone>, StatusTone> = {
  neutral: "neutral",
  info: "info",
  success: "success",
  danger: "danger",
};

export const dynamic = "force-dynamic";

/**
 * /phil/hours — the worker's own history of submissions.
 *
 * Mostly read-only: the write actions are fixing a REJECTED entry and —
 * 2026-07-26 owner-directed — changing a SUBMITTED (undecided) one. Each
 * such entry gets an in-place <RejectedHoursResubmitSheet/> that edits the
 * hours / job / note and PATCHes the entry with `status: "submitted"` via
 * the existing /api/time-entries endpoint (the rejected→submitted transition
 * `main` already supports; a submitted entry's status simply doesn't move).
 * Draft rows on the week summary get a real Send (draft→submitted).
 *
 * The worker's active assigned jobs are loaded alongside the history so the
 * resubmit form can preserve the original job attribution (or require a real
 * assigned job) — a worker with active jobs can never resubmit jobId:null.
 *
 * Cross-ref: docs/buhlos-hours-safe-foundation.md (#92 deferred this slice here)
 *            docs/rebuild-audit/19-phase-b-hours-implementation-brief.md
 */
export default async function PhilHoursPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
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

  // `?week=` is any date inside the week to show (nav links pass a Monday);
  // default to the current Sydney week. Same convention as /hours/weekly.
  const sp = await searchParams;
  const todayISO = localDateString(new Date(), BUSINESS_TIMEZONE);
  const weekAnchorISO =
    sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : todayISO;

  // History + the worker's active assigned jobs in parallel — the jobs feed
  // the resubmit form's attribution guard so a fix can't land jobId:null.
  const [{ entries, fetchError }, assignedJobs, sharpenedFlags] =
    await Promise.all([
      loadHistory(raw),
      loadAssignedJobs(raw),
      // Sharpened-chrome flag (cached flags.json read) — server-resolved boolean.
      philSharpenedFlags(session),
    ]);

  // ── Sharpened Hours (phil_sharpened, dark — Wave 2c) ─────────────────────
  // Same data (the full /api/time-entries history + the worker's assigned
  // jobs), re-projected as collapsible week cards with the EXISTING log /
  // fix-and-resubmit flows mounted here (in sharpened mode the Hours tab is
  // the worker's logging home). Flag off falls through below, byte-identical.
  if (sharpenedFlags.sharpened) {
    return (
      <PhilShell
        title="Hours"
        userId={session.userId ?? ""}
        sharpened
        jobRoomsEnabled={sharpenedFlags.jobRooms}
        accountInitials={philInitials(session.name ?? session.username)}
      >
        <div className="space-y-4">
          {fetchError ? (
            <PhilNotice tone="warning" title="Couldn’t load your hours" role="alert">
              {fetchError}. Pull to refresh, or ask the office if it keeps happening.
            </PhilNotice>
          ) : (
            <PhilHoursSharpened
              entries={entries}
              todayISO={todayISO}
              assignedJobs={assignedJobs.jobs}
              jobsError={assignedJobs.error}
            />
          )}
        </div>
      </PhilShell>
    );
  }

  return (
    <PhilShell
      title="Hours history"
      userId={session.userId ?? ""}
      sharpened={sharpenedFlags.sharpened}
      jobRoomsEnabled={sharpenedFlags.jobRooms}
      accountInitials={philInitials(session.name ?? session.username)}
    >
      <div className="space-y-4">
        <PhilBackLink href="/phil/my-day">My day</PhilBackLink>

        <PhilPageIntro
          title="Hours history"
          description="Your recent submissions and where they’re up to. Read-only."
        />

        {fetchError ? (
          <PhilNotice tone="warning" title="Couldn’t load history" role="alert">
            {fetchError}
          </PhilNotice>
        ) : (
          // The week at a glance — what's approved / waiting / needs fixing /
          // not logged, with one-tap Fix / Log actions. Built purely from the
          // same entries as the history below; hidden when they couldn't load
          // so we never render a fabricated "all clear" week.
          <PhilWeekSummary
            entries={entries}
            todayISO={todayISO}
            weekAnchorISO={weekAnchorISO}
            assignedJobs={assignedJobs.jobs}
            jobsError={assignedJobs.error}
          />
        )}

        {!fetchError && entries.length === 0 ? (
          <EmptyState
            title="No entries yet"
            description="Once you submit hours on /phil/my-day they'll show up here with status updates."
          />
        ) : !fetchError ? (
          <ul className="space-y-3">
            {entries.map((entry) => (
              <li key={entry.id}>
                <EntryCard
                  entry={entry}
                  assignedJobs={assignedJobs.jobs}
                  jobsError={assignedJobs.error}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </PhilShell>
  );
}

function EntryCard({
  entry,
  assignedJobs,
  jobsError,
}: {
  entry: TimeEntry;
  assignedJobs: ReadonlyArray<AssignableJob>;
  jobsError: boolean;
}) {
  return (
    <Card className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>{formatHoursLabel(entry.totalHours)}</CardTitle>
          <CardDescription>{formatDateLabel(entry.date)}</CardDescription>
        </div>
        <StatusChip tone={HOURS_CHIP_TONE[statusTone(entry.status)]}>
          {statusLabel(entry.status)}
        </StatusChip>
      </div>

      {entry.notes ? (
        <p className="text-sm text-text-muted">
          <span className="font-medium text-text">Note:</span> {entry.notes}
        </p>
      ) : null}

      {entry.status === "rejected" && entry.rejectedReason ? (
        <PhilNotice tone="danger" title="Why it bounced back">
          <p className="whitespace-pre-line">{entry.rejectedReason}</p>
        </PhilNotice>
      ) : null}

      {canResubmitInPhil(entry) ? (
        <RejectedHoursResubmitSheet
          entry={entry}
          assignedJobs={assignedJobs}
          jobsError={jobsError}
        />
      ) : null}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-text-muted">
        <dt>Submitted</dt>
        <dd>{formatTimestamp(entry.submittedAt) ?? "—"}</dd>
        {entry.status === "approved" ? (
          <>
            <dt>Approved</dt>
            <dd>{formatTimestamp(entry.approvedAt) ?? "—"}</dd>
          </>
        ) : null}
        {entry.status === "rejected" ? (
          <>
            <dt>Rejected</dt>
            <dd>{formatTimestamp(entry.rejectedAt) ?? "—"}</dd>
          </>
        ) : null}
      </dl>
    </Card>
  );
}

async function loadHistory(cookieValue: string | undefined): Promise<{
  entries: ReadonlyArray<TimeEntry>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/time-entries`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return { entries: [], fetchError: `API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = parseTimeEntryListLenient(body);
    if (!parsed.ok) {
      return { entries: [], fetchError: "Unexpected response shape" };
    }
    if (parsed.dropped > 0) {
      console.warn(
        `phil/hours: skipped ${parsed.dropped} malformed time entr${parsed.dropped === 1 ? "y" : "ies"}`,
      );
    }
    return { entries: parsed.entries, fetchError: null };
  } catch (err) {
    return {
      entries: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}

/**
 * Load the worker's active assigned jobs for resubmit attribution.
 *
 * Mirrors src/app/phil/my-day/page.tsx loadAssignedJobs(): source of truth is
 * users.json.assignedJobIds (GET /api/jobs already scopes a field caller to it
 * and strips draft/archived); isVisibleToField is defence-in-depth. Returns
 * `error: true` on any failure so the resubmit form blocks rather than falling
 * back to an unattributed entry.
 */
async function loadAssignedJobs(cookieValue: string | undefined): Promise<{
  jobs: ReadonlyArray<AssignableJob & { ref: string | null }>;
  error: boolean;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/jobs`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return { jobs: [], error: true };
    const body = await res.json();
    const parsed = JobListResponseSchema.safeParse(body);
    if (!parsed.success) return { jobs: [], error: true };
    const jobs = parsed.data.jobs
      .filter((j) => isVisibleToField(j))
      // A real job code rides along for the sharpened code chips (the W2b
      // IV#### `code` when set, else the free-text `ref`, else an honestly
      // absent chip) — AssignableJob consumers ignore the extra field.
      .map((j) => ({ id: j.id, name: j.name, ref: j.code ?? j.ref ?? null }));
    return { jobs, error: false };
  } catch {
    return { jobs: [], error: true };
  }
}
