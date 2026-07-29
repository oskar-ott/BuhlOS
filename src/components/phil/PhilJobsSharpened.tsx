"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Route } from "next";
import {
  AlertOctagon,
  AlertTriangle,
  Camera,
  ChevronRight,
  ClipboardCheck,
  Clock,
  ListChecks,
  Map as MapIcon,
  Plus,
  Search,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import { PhilOfflineLink } from "./PhilOfflineLink";
import { PhilStatusBadge, type PhilStatusTone } from "./ui/PhilStatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { statusLabel, statusTone } from "@/domains/jobs/format";
import { cn } from "@/lib/cn";
import type { Job } from "@/domains/jobs/types";
import { jobOpenWork, jobOpenWorkSummary } from "./philJobsListSignals";
import {
  readJobListPrefs,
  togglePin as togglePinPref,
  type JobListPrefs,
} from "./jobListPrefs";
import { orderJobList } from "./jobListOrder";
import { filterJobList } from "./jobListFilter";
import { useLongPress } from "./useLongPress";
import { PhilShortcutSheet } from "./PhilShortcutSheet";
import {
  buildPhilJobCommandModel,
  type PhilJobActionId,
  type PhilJobCommandAction,
} from "@/domains/phil/job-command-model";
import {
  philJobActionHref,
  philJobCommandInputFromListSignals,
} from "@/domains/phil/job-command-list-input";
import { PhilNewJobSheet } from "./PhilNewJobSheet";

/**
 * Phil Jobs — sharpened re-skin (phil_sharpened, dark; Wave 2a).
 *
 * Rendered only when the server-resolved flag is on; flag off = the current
 * PhilJobsList screen, byte-identical (src/app/phil/jobs/page.tsx branches).
 * A restyled PROJECTION of the same list — behaviour preserved, not rebuilt:
 *
 *   - ONE flat list (owner-pulled 2026-07-30): the "Recent" shortlist group
 *     and the "Your jobs · N" heading are gone — fewer slots (P10), same
 *     recency-first order underneath (#145: pinned first, then most-recently
 *     opened, never-opened jobs name-first — no fabricated "recent", P7).
 *     The glove-sized pin control and the long-press row-actions sheet
 *     (#146) carry over with their load-bearing testids
 *     (phil-jobs-all / phil-job-pin-*).
 *   - Search (owner-pulled 2026-07-30): a filter box above the list once a
 *     worker has 2+ jobs (invisible for the single-job worker, P10). Pure
 *     token match over name / code / ref / address (jobListFilter) — the
 *     filtered list keeps the recency order; zero matches says so honestly.
 *   - "+ New job" (Wave 2b): the navy header button opens PhilNewJobSheet —
 *     an in-page full-screen form (no new route) posting the RESTRICTED
 *     field-create body to /api/jobs (name + IV#### code + optional address;
 *     server gate = field/LH + phil_sharpened, api/jobs.js).
 *   - "On today" hero: the only real active-job signal in the list data is
 *     exactly-one-assigned (same signal as My Day's "On the job") AND that
 *     job's status is actually 'active' — with 2+ jobs no hero renders (we
 *     never guess which site they're on), and a lone Complete/On-hold job
 *     lists plainly with its truthful badge (P7). No crew
 *     avatars (crew comes from /api/time-entries-on-site on the job page,
 *     not this list payload) and no "Synced" pill (there is no per-job sync
 *     state to be truthful about) — honest absence over decoration.
 *   - Row status line: the real ?withStats=1 signals (open snags / active
 *     ITPs) + the address. Task/blocker rollups ("Waiting on parts",
 *     "Blocked") don't exist in the list data, so the badge shows the job's
 *     real status (Active / On hold / Complete) instead — show less, never
 *     invent (P7).
 */

// jobs-domain status tone → the sharpened badge tone (same three words).
const JOB_BADGE_TONE: Record<ReturnType<typeof statusTone>, PhilStatusTone> = {
  neutral: "neutral",
  success: "success",
  warning: "warning",
};

// Long-press sheet icons — same vocabulary as PhilJobsList / the job page.
const ACTION_ICON: Record<PhilJobActionId, typeof Camera> = {
  fix_rejected_hours: AlertTriangle,
  complete_checks: ClipboardCheck,
  continue_tasks: ListChecks,
  capture: Camera,
  log_hours: Clock,
  view_plans: MapIcon,
  view_tags: ShieldCheck,
  report_issue: AlertOctagon,
};

const EMPTY_PREFS: JobListPrefs = { recents: [], pinned: [] };

/** Top ≤3 launchable actions from the SAME command model the job page uses
 *  (mirrors PhilJobsList's helper — the list-row signals are the input). */
function topJobActions(
  job: Pick<
    Job,
    "id" | "name" | "status" | "inductionRequired" | "statsSnagsV2Active" | "statsItpsActive"
  >,
  max = 3,
): PhilJobCommandAction[] {
  const model = buildPhilJobCommandModel(philJobCommandInputFromListSignals(job));
  const ranked = model.primaryAction
    ? [model.primaryAction, ...model.actions]
    : model.actions;
  return ranked.slice(0, max);
}

interface Props {
  initialJobs: ReadonlyArray<Job>;
  /** Keys the per-worker recent + pinned prefs (#145); "" = no prefs read. */
  userId?: string;
}

export function PhilJobsSharpened({ initialJobs, userId = "" }: Props) {
  // Prefs after mount only — SSR paints the stable name-first list, exactly
  // like PhilJobsList (no hydration flash, no fabricated "recent").
  const [prefs, setPrefs] = useState<JobListPrefs>(EMPTY_PREFS);

  useEffect(() => {
    if (!userId) return;
    setPrefs(readJobListPrefs(userId));
  }, [userId]);

  const onTogglePin = useCallback(
    (jobId: string) => {
      if (!userId) return;
      setPrefs(togglePinPref(userId, jobId));
    },
    [userId],
  );

  const { fullList } = useMemo(() => orderJobList(initialJobs, prefs), [initialJobs, prefs]);

  const pinnedSet = useMemo(() => new Set(prefs.pinned), [prefs.pinned]);
  const canPin = userId.length > 0;

  // "+ New job" (Wave 2b) — in-page client state, no new route. The sheet is
  // only MOUNTED while open (it covers the tab bar at z-50, CaptureSheet
  // precedent). Server gate: field/LH + phil_sharpened (this screen already
  // renders only when the flag is on for this viewer).
  const [newJobOpen, setNewJobOpen] = useState(false);

  // The one honest "On today" signal in this payload: exactly one assigned
  // job AND it is actually active — a lone Complete/On-hold job is not "on
  // today" and renders in the plain register with its truthful badge instead.
  // The hero IS that job's entry — it must not repeat in the register below
  // ("Your jobs" counts the OTHERS), so with a hero and nothing else the
  // register section drops entirely: one job, shown once.
  const heroJob =
    initialJobs.length === 1 && initialJobs[0]!.status === "active"
      ? initialJobs[0]!
      : null;
  const registerJobs = useMemo(
    () => (heroJob ? fullList.filter((j) => j.id !== heroJob.id) : fullList),
    [heroJob, fullList],
  );

  // Search — client-only filter over the SAME recency-ordered list. Hidden
  // for a single-job worker (nothing to search, P10).
  const [query, setQuery] = useState("");
  const visibleJobs = useMemo(() => filterJobList(registerJobs, query), [registerJobs, query]);

  return (
    <div className="space-y-4" data-testid="phil-jobs-sharpened">
      {/* Header: title + navy "+ New job" (Wave 2b — prototype §2.2). */}
      <header className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-extrabold tracking-[-0.02em] text-text">
          Jobs
        </h1>
        <button
          type="button"
          onClick={() => setNewJobOpen(true)}
          data-testid="phil-new-job-open"
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-card bg-brand-navy px-4 font-display text-sm font-bold text-text-inverse transition hover:brightness-110 active:scale-[0.98] focus-visible:outline-brand-navy"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          New job
        </button>
      </header>

      {initialJobs.length === 0 ? (
        <EmptyState
          title="No jobs assigned yet"
          description="When admin or your leading hand puts you on a job, it'll show up here. Ask your PM if you think one is missing."
        />
      ) : (
        <>
          {initialJobs.length > 1 ? (
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search jobs"
                aria-label="Search jobs"
                data-testid="phil-jobs-search"
                enterKeyHint="search"
                autoCorrect="off"
                className="h-12 w-full rounded-card border border-border bg-surface-raised pl-11 pr-12 text-base text-text outline-none placeholder:text-text-muted focus:border-brand-navy [&::-webkit-search-cancel-button]:hidden"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  data-testid="phil-jobs-search-clear"
                  className="absolute right-1 top-1/2 flex min-h-[44px] min-w-[44px] -translate-y-1/2 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle active:scale-95"
                >
                  <X aria-hidden="true" className="h-5 w-5" />
                </button>
              ) : null}
            </div>
          ) : null}

          {heroJob ? <OnTodayCard job={heroJob} /> : null}

          {registerJobs.length > 0 ? (
            visibleJobs.length > 0 ? (
              <ul
                data-testid="phil-jobs-all"
                className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised"
              >
                {visibleJobs.map((job) => (
                  <li key={job.id}>
                    <SharpJobRow
                      job={job}
                      pinned={pinnedSet.has(job.id)}
                      canPin={canPin}
                      onTogglePin={onTogglePin}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p
                data-testid="phil-jobs-search-empty"
                className="rounded-card border border-dashed border-border bg-surface-subtle px-4 py-3 text-sm text-text-muted"
              >
                Nothing matches &ldquo;{query.trim()}&rdquo;. Check the spelling or clear the
                search.
              </p>
            )
          ) : null}
        </>
      )}

      {/* Mounted only while open: the sheet reads the router, and a closed
          create form shouldn't cost the list anything. */}
      {newJobOpen ? (
        <PhilNewJobSheet
          open
          onClose={() => setNewJobOpen(false)}
          jobs={initialJobs}
        />
      ) : null}
    </div>
  );
}

/* ── "On today" hero — the active job, yellow left rule ────────────────── */

function OnTodayCard({ job }: { job: Job }) {
  const address = (job.siteAddress ?? "").trim();
  const summary = jobOpenWorkSummary(jobOpenWork(job));
  // Code chip: the real IV#### `code` field (Wave 2b) when present, else the
  // legacy free-text `ref` — jobs without either render exactly as before.
  const chip = job.code ?? job.ref;
  return (
    <section aria-labelledby="phil-jobs-on-today-heading" className="space-y-1.5">
      <h2
        id="phil-jobs-on-today-heading"
        className="px-1 font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted"
      >
        On today
      </h2>
      <PhilOfflineLink
        href={`/phil/jobs/${encodeURIComponent(job.id)}` as Route}
        data-testid="phil-jobs-on-today"
        className="flex min-h-[72px] items-center gap-3 rounded-card border border-border border-l-[5px] border-l-accent-yellow bg-surface-raised p-4 shadow-card hover:bg-surface-subtle"
      >
        <span className="min-w-0 flex-1">
          {chip ? (
            <span className="block font-display text-[12px] font-bold uppercase tracking-[0.06em] text-text-muted [font-variant-numeric:tabular-nums]">
              {chip}
            </span>
          ) : null}
          <span className="block truncate font-display text-[17px] font-bold tracking-[-0.014em] text-text">
            {job.name}
          </span>
          {address || summary ? (
            <span className="mt-0.5 block truncate text-[13px] text-text-muted">
              {[address, summary].filter(Boolean).join(" · ")}
            </span>
          ) : null}
        </span>
        <PhilStatusBadge
          label={statusLabel(job.status)}
          tone={JOB_BADGE_TONE[statusTone(job.status)]}
          className="shrink-0"
        />
        <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
      </PhilOfflineLink>
    </section>
  );
}

/* ── Row — code + name + real one-line status + badge ──────────────────── */

function SharpJobRow({
  job,
  pinned,
  canPin,
  onTogglePin,
}: {
  job: Job;
  pinned: boolean;
  canPin: boolean;
  onTogglePin: (jobId: string) => void;
}) {
  const address = (job.siteAddress ?? "").trim();
  // Real, opt-in (?withStats=1) signals only — absent stats = no line, never
  // a fabricated "all clear" (same contract as philJobsListSignals).
  const summary = jobOpenWorkSummary(jobOpenWork(job));
  const statusLine = [address, summary].filter(Boolean).join(" · ");
  // Code chip: real `code` (IV####, Wave 2b) first, legacy `ref` fallback.
  const chip = job.code ?? job.ref;

  // Long-press → this job's top actions, from the SAME command model as the
  // job page (#146). Additive: a plain tap still opens the job.
  const [actionsOpen, setActionsOpen] = useState(false);
  const [rowActions, setRowActions] = useState<PhilJobCommandAction[]>([]);
  const onRowLongPress = useCallback(() => {
    const actions = topJobActions(job, 3);
    if (actions.length === 0) return; // nothing launchable → no sheet, tap stands
    setRowActions(actions);
    setActionsOpen(true);
  }, [job]);
  const rowLongPress = useLongPress({
    onLongPress: onRowLongPress,
    disabled: actionsOpen,
  });

  return (
    <>
      <div className="flex items-stretch">
        <PhilOfflineLink
          href={`/phil/jobs/${encodeURIComponent(job.id)}` as Route}
          className="flex min-h-[72px] flex-1 select-none items-center gap-3 px-4 py-3 hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none [-webkit-touch-callout:none]"
          aria-label={summary ? `Open ${job.name} — ${summary}` : `Open ${job.name}`}
          {...rowLongPress}
        >
          <span className="min-w-0 flex-1">
            {chip ? (
              <span className="block font-display text-[12px] font-bold uppercase tracking-[0.06em] text-text-muted [font-variant-numeric:tabular-nums]">
                {chip}
              </span>
            ) : null}
            <span className="block truncate font-display text-base font-semibold text-text">
              {job.name}
            </span>
            {statusLine ? (
              <span className="mt-0.5 block truncate text-[13px] text-text-muted">
                {statusLine}
              </span>
            ) : null}
          </span>

          <PhilStatusBadge
            label={statusLabel(job.status)}
            tone={JOB_BADGE_TONE[statusTone(job.status)]}
            className="shrink-0"
          />
          <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted/60" />
        </PhilOfflineLink>

        {/* Pin/unpin — identical control + testid to the current list (#145):
            a separate ≥44px target so a tap never opens the job. */}
        {canPin ? (
          <button
            type="button"
            data-testid={`phil-job-pin-${job.id}`}
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${job.name}` : `Pin ${job.name}`}
            onClick={() => onTogglePin(job.id)}
            className={cn(
              "flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center self-center",
              "rounded-card text-text-muted transition hover:bg-surface-subtle active:scale-95",
              "focus-visible:outline-brand-navy",
              pinned && "text-accent-yellow",
            )}
          >
            <Star
              aria-hidden="true"
              className="h-5 w-5"
              fill={pinned ? "currentColor" : "none"}
            />
          </button>
        ) : null}
      </div>

      {/* Long-press row actions (#146) — same sheet + testid as the current
          list; every item also has a visible normal path on the job page. */}
      <PhilShortcutSheet
        open={actionsOpen}
        onClose={() => setActionsOpen(false)}
        title={job.name}
        subtitle="Quick actions for this job"
        testId={`phil-job-actions-${job.id}`}
      >
        <ul className="space-y-2">
          {rowActions.map((action) => {
            const Icon = ACTION_ICON[action.id];
            return (
              <li key={action.id}>
                <PhilOfflineLink
                  href={philJobActionHref(job.id, action) as Route}
                  onClick={() => setActionsOpen(false)}
                  className="flex min-h-[56px] w-full items-center gap-3 rounded-card border border-border bg-surface p-3 text-left hover:bg-surface-subtle active:scale-[0.99]"
                >
                  <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-brand-navy" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-sm font-semibold text-text">
                      {action.label}
                    </span>
                    {action.reason ? (
                      <span className="mt-0.5 block truncate text-xs text-text-muted">
                        {action.reason}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
                </PhilOfflineLink>
              </li>
            );
          })}
        </ul>
      </PhilShortcutSheet>
    </>
  );
}
