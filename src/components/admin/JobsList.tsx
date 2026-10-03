"use client";

import Link from "next/link";
import type { Route } from "next";
import { Suspense, use, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Archive, Plus, Search, X } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/EmptyState";
import { relativeWhen } from "@/domains/jobs/format";
import {
  filterJobs,
  JOB_LIST_PHASE_OPTIONS,
  isHistoryJob,
  jobStatusCounts,
  jobsEmptyStateMessage,
  parseJobStatusParam,
} from "@/domains/jobs/list-filter";
import { isQaTestJobName } from "@/domains/jobs/test-data";
import { deriveJobHealth, type JobHealth, type JobHealthLevel } from "@/domains/jobs/job-health";
import {
  HEALTH_LEVELS,
  healthCounts,
  healthLabel,
  parseHealthParam,
  sortByHealth,
} from "@/domains/jobs/job-health-list";
import {
  buildPortfolioSummary,
  formatContractValue,
  jobCardFacts,
  jobCardVerdict,
  type JobCardMeta,
  type JobCardVerdictTone,
} from "@/domains/jobs/portfolio";
import type { Job } from "@/domains/jobs/types";
import { jobPhase, phaseLabel, phaseTone, type JobPhase } from "@/domains/jobs/lifecycle";
import {
  clearRememberedFilters,
  writeRememberedFilters,
  type RememberedFilterSpec,
} from "@/lib/storage/remembered-filters";
import { useApplyRememberedFiltersOnce } from "@/lib/storage/use-remembered-filters";
import { cn } from "@/lib/cn";

/** Streamed per-job extras (full ?withStats read): task progress + the admin-tier
 *  contractValue that the fast statsOnly list paint omits. */
type CardExtra = { tasksTotal?: number; tasksComplete?: number; contractValue?: number };
type CardExtraMap = Record<string, CardExtra>;

interface Props {
  jobs: ReadonlyArray<Job>;
  /** Admin-only: show the per-card "Build" action that opens the Job Builder. */
  canBuild?: boolean;
  /** Literal-admin only: when set, the header shows a "+ New job" entry point to
   *  the builder. Absent ⇒ no create affordance (LH viewers). */
  newJobHref?: string;
  /** Perf: when the list is served from the fast statsOnly read (no areaGroups-
   *  derived task counts, no money fields), the "X/Y tasks" progress and the
   *  card's Value are STREAMED in via this promise and hydrated behind the
   *  already-painted cards. Absent (flag-off / no stream) ⇒ the cards use the
   *  values already on the job objects. */
  cardExtrasPromise?: Promise<CardExtraMap>;
}

/** Per-device remembered default for this list (issue #216). Exported for
 *  the render test so it exercises the real key + validators. */
export const JOBS_FILTERS_STORAGE_KEY = "buhlos.jobs-list.filters";
export const JOBS_FILTER_SPEC: RememberedFilterSpec = {
  status: (v) => parseJobStatusParam(v) !== null,
  q: (v) => v.trim() !== "" && v.length <= 200,
};

/** How long a search keystroke waits before being mirrored into the URL. */
const SEARCH_URL_DEBOUNCE_MS = 250;

/**
 * Filter pill group. Phone (below `sm`): ONE row that scrolls sideways, bled to
 * the page edges like the office top nav, so the status + health pills cost two
 * short rows instead of three stacked rows of chrome above the first job (P10 —
 * the first card is on the first screen). `sm`+: the wrapping row as before.
 */
const FILTER_STRIP_CLASS =
  "-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 py-0.5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:py-0";

/**
 * Admin jobs portfolio — Phase D6, filters URL-driven since #216, restyled to
 * the admin-redesign card grid (brief §3, prototype docs/prototype/admin/
 * admin-jobs.jsx) in this slice.
 *
 * Each card carries the real, glanceable read on a job: status, the rolled-up
 * health risk read (deriveJobHealth — NOT the prototype's fabricated 0–100
 * score), the contract Value + Crew meta (Value is admin-tier; "—" when
 * redacted/unpriced), task progress, and the pending evidence
 * action chips that deep-link past the hub. The prototype's Billed% and PM
 * tiles are dropped — neither has a data source (see src/domains/jobs/
 * portfolio.ts).
 *
 * Filtering (#216 + #227): status pills + a search box + a health filter, all
 * reflected in the URL (`?status=` + `?q=` + `?health=`) so views are shareable
 * and restorable from a remembered per-device default. Mechanics are unchanged
 * by the restyle:
 *
 *   - Filter state is read LIVE from useSearchParams() — never snapshotted into
 *     useState — so same-route deep links re-filter (the soft-nav pitfall).
 *   - Filtering stays client-side over the already-loaded array; interaction
 *     writes mirror the URL via window.history.replaceState so a pill/keystroke
 *     never refetches /api/jobs. router.replace is reserved for the
 *     once-per-mount remembered-default application.
 *   - The search <input> keeps local echo for typing latency, synced FROM the
 *     URL when the param changes externally (lastWrittenQueryRef).
 *
 * Cross-ref:
 *   src/domains/jobs/portfolio.ts — the pure card / summary view-model
 *   src/domains/jobs/list-filter.ts — the pure filter matrix
 *   src/domains/jobs/job-health.ts — the real risk read
 *   src/app/v2/jobs/page.tsx — the server component that hydrates this list
 */
export function JobsList({ jobs, canBuild = false, newJobHref, cardExtrasPromise }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Streamed card extras (statsOnly list): starts empty, hydrated when the
  // ?withStats read resolves (CardExtrasHydrator below). Additive — cards render
  // immediately from statsOnly; the "X/Y tasks" line + Value fill in when this
  // lands (health/chips come from statsOnly and never change, so no flicker).
  const [streamedExtras, setStreamedExtras] = useState<CardExtraMap>({});

  // URL is the source of truth for the status filter (validated; unknown
  // values degrade to "all").
  const status = parseJobStatusParam(searchParams.get("status"));
  const urlQuery = searchParams.get("q") ?? "";
  // #227: health filter is URL-driven too (validated; garbage → no filter).
  const health = parseHealthParam(searchParams.get("health"));

  // Local echo for the search box; the URL mirror is debounced. The ref tracks
  // the last value THIS component wrote so the sync effect only adopts genuinely
  // external URL changes (deep links) instead of clobbering in-flight typing.
  const [query, setQuery] = useState(urlQuery);
  const lastWrittenQueryRef = useRef(urlQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (urlQuery !== lastWrittenQueryRef.current) {
      lastWrittenQueryRef.current = urlQuery;
      setQuery(urlQuery);
    }
  }, [urlQuery]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Apply the remembered per-device default (only when the URL is clean of both
  // filter params; storage is read inside the effect, never in render).
  useApplyRememberedFiltersOnce(JOBS_FILTERS_STORAGE_KEY, JOBS_FILTER_SPEC);

  /**
   * Mirror the given filter set into the URL + the per-device memory. Reads
   * window.location.search at call time (interaction handlers only) so a
   * debounced search write can't resurrect a status changed while pending.
   */
  const writeFilters = (next: { status: JobPhase | null; query: string }) => {
    const params = new URLSearchParams(window.location.search);
    if (next.status) params.set("status", next.status);
    else params.delete("status");
    const q = next.query.trim();
    if (q) params.set("q", q);
    else params.delete("q");
    const qs = params.toString();
    try {
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    } catch {
      // History API throttled — filtering still works from local state.
    }
    writeRememberedFilters(JOBS_FILTERS_STORAGE_KEY, { status: next.status, q });
  };

  const handleStatusClick = (next: JobPhase | null) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    writeFilters({ status: next, query });
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    lastWrittenQueryRef.current = value.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const freshStatus = parseJobStatusParam(
        new URLSearchParams(window.location.search).get("status")
      );
      writeFilters({ status: freshStatus, query: value });
    }, SEARCH_URL_DEBOUNCE_MS);
  };

  const handleReset = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuery("");
    lastWrittenQueryRef.current = "";
    const params = new URLSearchParams(window.location.search);
    params.delete("status");
    params.delete("q");
    params.delete("health");
    const qs = params.toString();
    try {
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    } catch {
      // Best-effort, as above.
    }
    clearRememberedFilters(JOBS_FILTERS_STORAGE_KEY);
  };

  // #227: jump straight to a health level (e.g. from a "3 at risk" summary).
  const handleHealthClick = (next: JobHealthLevel | null) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const params = new URLSearchParams(window.location.search);
    if (next) params.set("health", next);
    else params.delete("health");
    const qs = params.toString();
    try {
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    } catch {
      // History API throttled — filtering still works from local state.
    }
  };

  // Filter on the LIVE keystroke value (not the debounced URL mirror) so the
  // list narrows instantly while typing.
  const filtered = useMemo(() => filterJobs(jobs, { status, query }), [jobs, status, query]);

  // #227: derive each row's health from its already-loaded stats (no I/O), then
  // triage the portfolio "needs me first".
  const withHealth = useMemo(
    () => filtered.map((job) => ({ job, health: deriveJobHealth(job) })),
    [filtered]
  );
  const healthTally = useMemo(() => healthCounts(withHealth), [withHealth]);
  const visible = useMemo(() => {
    const byHealth = health ? withHealth.filter((x) => x.health.level === health) : withHealth;
    return sortByHealth(byHealth);
  }, [withHealth, health]);

  // Portfolio header summary (pure VM): "N jobs · M need attention" + the honest
  // total-contract readout. Computed over the WHOLE loaded list (not the current
  // filter) so the header reads the portfolio, not the view — and folds in the
  // streamed contractValue so the total fills in with the cards.
  // History (closed + archived) is never part of the working portfolio, so the
  // header and the "All" count exclude it — a closed job's stale tags must
  // not keep "need attention" lit forever (docs/job-lifecycle.md).
  const workingJobs = useMemo(() => jobs.filter((j) => !isHistoryJob(j)), [jobs]);
  const portfolio = useMemo(() => {
    const enriched = workingJobs.map((j) => withStreamedValue(j, streamedExtras[j.id]));
    return buildPortfolioSummary({
      jobs: enriched,
      healthByIndex: enriched.map((j) => deriveJobHealth(j)),
    });
  }, [workingJobs, streamedExtras]);

  const counts = useMemo(() => jobStatusCounts(jobs), [jobs]);
  // Statuses with zero jobs stay hidden (the page only ships archived rows for
  // ?status=archived, so the Archived pill counts real rows there) UNLESS the URL deep-links to one, in which case the pill
  // renders so the active filter is visible and clearable.
  const statusOptions = JOB_LIST_PHASE_OPTIONS.filter(
    (s) => (counts.get(s) ?? 0) > 0 || status === s
  );

  const filtersActive = status !== null || query.trim() !== "" || health !== null;

  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No active jobs"
        description="When admin or PMs activate a job in the Job Builder, it'll appear here. Archived jobs aren't listed."
        action={
          newJobHref ? (
            <Link
              data-testid="jobs-new-job"
              href={newJobHref as Route}
              className="inline-flex items-center gap-1.5 rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-ink focus:outline-none focus:ring-2 focus:ring-brand-navy"
            >
              <Plus aria-hidden="true" className="h-4 w-4" /> New job
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {cardExtrasPromise ? (
        <Suspense fallback={null}>
          <CardExtrasHydrator promise={cardExtrasPromise} onResolved={setStreamedExtras} />
        </Suspense>
      ) : null}

      {/* Portfolio header (lean-reset replica 320-328) — the "Jobs" head lives
          in the shell topbar; this row is the real "N jobs · M need attention"
          subline, the honest total-contract readout (admin-only data), and the
          create / archive actions. No card chrome — a plain header row. */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-0.5">
        <p className="min-w-0 text-sm text-text-muted">
          {portfolio.subline}
          {/* Phone: the ordering note rides the subline (its own row is desktop). */}
          <span className="sm:hidden"> · sorted by risk</span>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {portfolio.totalContract ? (
            <div className="text-left sm:text-right">
              <div className="flex flex-wrap items-baseline justify-start gap-1.5 sm:justify-end">
                <span className="font-mono text-xs uppercase tracking-[0.12em] text-text-muted">
                  Total contract
                </span>
                <span className="font-display text-base font-bold text-text">
                  {portfolio.totalContract.value}
                </span>
                <span className="font-mono text-xs uppercase tracking-[0.12em] text-text-muted">
                  Admin only
                </span>
              </div>
              {/* Honesty: the sum only covers jobs that actually carry a value —
                  keep the priced-subset context so a part-priced portfolio never
                  implies a whole-portfolio total. */}
              <div className="font-mono text-xs text-text-muted">
                {portfolio.totalContract.hint}
              </div>
            </div>
          ) : null}
          {/* Cross-job bulk archive has no API today (api/jobs-bulk-edit.js is
              intra-job: areas / groups / tasks only). Archiving a job is a
              per-job status change on the hub. This link is a real navigation
              (not a pill) because the server only loads archived rows for
              ?status=archived — see src/app/v2/jobs/page.tsx. */}
          <Link
            href={"/v2/jobs?status=archived" as Route}
            className="hidden items-center gap-1.5 rounded-card border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy sm:inline-flex"
          >
            <Archive aria-hidden="true" className="h-4 w-4" /> Archived
          </Link>
          {newJobHref ? (
            <Link
              data-testid="jobs-new-job"
              href={newJobHref as Route}
              className="hidden items-center gap-1.5 rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-ink focus:outline-none focus:ring-2 focus:ring-brand-navy sm:inline-flex"
            >
              <Plus aria-hidden="true" className="h-4 w-4" /> New job
            </Link>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
        {/* Phone: search and the create entry share one row (the header's
            New job button is desktop) — one less row above the first job. */}
        <div className="flex w-full items-stretch gap-2 sm:w-auto sm:max-w-md sm:flex-1">
          <label className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm sm:min-h-0">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder="Search name, IV number or address"
              aria-label="Filter jobs"
              className="w-full bg-transparent text-text outline-none placeholder:text-text-muted"
            />
          </label>
          {newJobHref ? (
            <Link
              data-testid="jobs-new-job-mobile"
              href={newJobHref as Route}
              aria-label="New job"
              className="inline-flex shrink-0 items-center gap-1 rounded-card bg-brand-navy px-3 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-ink focus:outline-none focus:ring-2 focus:ring-brand-navy sm:hidden"
            >
              <Plus aria-hidden="true" className="h-4 w-4" /> New
            </Link>
          ) : null}
        </div>

        <div role="group" aria-label="Filter jobs by status" className={FILTER_STRIP_CLASS}>
          <FilterPill
            label="All"
            count={workingJobs.length}
            selected={status === null}
            onClick={() => handleStatusClick(null)}
          />
          {statusOptions.map((s) => (
            <FilterPill
              key={s}
              label={phaseLabel(s)}
              count={counts.get(s) ?? 0}
              selected={status === s}
              onClick={() => handleStatusClick(s)}
            />
          ))}
          {filtersActive ? (
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex min-h-[44px] shrink-0 items-center gap-1 whitespace-nowrap rounded-pill px-2.5 py-1 text-xs font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy sm:min-h-0"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
              Reset to all
            </button>
          ) : null}
          {/* Phone: the Archived view trails the status strip (the header's
              Archived button is desktop). Still a real navigation — the
              server only ships archived rows for ?status=archived. */}
          <Link
            href={"/v2/jobs?status=archived" as Route}
            className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-muted transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy sm:hidden"
          >
            <Archive aria-hidden="true" className="h-3.5 w-3.5" /> Archived
          </Link>
        </div>

        {/* #227: health filter — triage the portfolio by risk. Only levels with
            jobs in the current status/search view render a pill. */}
        <div role="group" aria-label="Filter jobs by health" className={FILTER_STRIP_CLASS}>
          {HEALTH_LEVELS.filter((lvl) => healthTally[lvl] > 0 || health === lvl).map((lvl) => (
            <FilterPill
              key={lvl}
              label={healthLabel(lvl)}
              count={healthTally[lvl]}
              selected={health === lvl}
              onClick={() => handleHealthClick(health === lvl ? null : lvl)}
            />
          ))}
        </div>

        {/* Job Detail Variants 2a — the list's one ordering, named. */}
        <p className="ml-auto hidden font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted sm:block">
          Sorted by risk
        </p>
      </div>

      {visible.length === 0 ? (
        <Card>
          <div className="py-6 text-center text-sm text-text-muted">
            {jobsEmptyStateMessage({ status, query })}
          </div>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3">
          {visible.map(({ job, health: jobHealth }) => (
            <li key={job.id}>
              <JobCard
                job={job}
                health={jobHealth}
                canBuild={canBuild}
                extra={streamedExtras[job.id]}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Apply a streamed contractValue to a job that the statsOnly paint left
 *  unpriced. Never overwrites a value already on the object. */
function withStreamedValue(job: Job, extra: CardExtra | undefined): Job {
  if (
    extra?.contractValue !== undefined &&
    !(typeof job.contractValue === "number" && Number.isFinite(job.contractValue))
  ) {
    return { ...job, contractValue: extra.contractValue };
  }
  return job;
}

/**
 * Status / health / filter pill. Selection uses the navy brand accent (doc 27
 * §6 — brand accents mark SELECTION, never entity state; the card's status Pill
 * keeps the five-tone palette via statusTone).
 */
function FilterPill({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        // 44px tall on phones (a strip item under a thumb), compact from sm up.
        "inline-flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] border px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-brand-navy sm:min-h-0",
        selected
          ? "border-text bg-brand-navy text-text-inverse"
          : "border-border bg-surface text-text hover:bg-surface-subtle"
      )}
    >
      <span>{label}</span>
      <span className={selected ? "tabular-nums" : "tabular-nums text-text-muted"}>{count}</span>
    </button>
  );
}

/** Verdict dot colours per tone — the solid state dots, matching the hub hero
 *  so the verdict travels list→detail in the same voice (2f §06). */
const VERDICT_DOT: Record<JobCardVerdictTone, string> = {
  danger: "bg-state-danger-dot",
  warning: "bg-state-warning-dot",
  success: "bg-state-success-dot",
  neutral: "bg-state-neutral-dot",
};

function JobCard({
  job,
  health,
  canBuild,
  extra,
}: {
  job: Job;
  health: JobHealth;
  canBuild: boolean;
  /** Streamed extras (statsOnly list): task progress + contractValue. */
  extra?: CardExtra;
}) {
  const hubHref = `/v2/jobs/${encodeURIComponent(job.id)}` as Route;

  // Task progress: prefer the job object's own counts (full read), else the
  // streamed map. When neither is present the progress cell reads "—".
  const tasksTotal =
    typeof job.statsTasksTotal === "number" ? job.statsTasksTotal : extra?.tasksTotal;
  const tasksComplete =
    typeof job.statsTasksComplete === "number" ? job.statsTasksComplete : extra?.tasksComplete;
  const hasTasks =
    typeof tasksTotal === "number" && typeof tasksComplete === "number" && tasksTotal > 0;

  // Value: the object's value (full read), else the streamed value. Crew is on
  // both reads. Honest "—" when absent (LH redaction / not loaded), never 0.
  const meta = cardMetaWithStream(job, extra);

  const updated = job.updatedAt ? relativeWhen(job.updatedAt) : "";
  // Identity line: the job number in mono (it's typed, read out, searched),
  // then type + address in plain words (sentence case reads shorter than the
  // old all-caps mono line). Wraps, never truncates — the full address stays.
  const numberPart = [job.code, job.ref].filter(Boolean).join(" · ");
  const wordsPart = [job.typeName, (job.siteAddress ?? "").trim()].filter(Boolean).join(" · ");
  const evidencePending = job.statsEvidenceV2Pending ?? 0;

  // The verdict line — health words when health is the read (active work, or
  // any real backlog), else the phase truth in one sentence: a draft is "not
  // published yet", a paused job "paused", a finished job "crew can log until
  // …" — never "On track · nothing needs you" on a job that isn't running
  // (P7; 2026-09-27 phone audit). Pure + unit-tested in portfolio.ts.
  const verdict = jobCardVerdict(job, health);
  // Phone facts line: only the facts that are real for this job — a lean job
  // with no structure carries no "Tasks —", an unpriced one no "$—".
  const facts = jobCardFacts(job, {
    contractValue: extra?.contractValue,
    tasksTotal: extra?.tasksTotal,
    tasksComplete: extra?.tasksComplete,
  });

  // Active is the normal state, so it wears no pill — the verdict line already
  // says how running work is going. Every other phase is tagged by the name.
  const phase = jobPhase(job);
  // The attention rule along the card's foot marks only the jobs that need
  // you (health is the read AND it's at-risk/watch). A calm job carries no
  // bar, so the red/amber ones stand out down the list.
  const needsYou = verdict.label !== null && (verdict.tone === "danger" || verdict.tone === "warning");

  return (
    <div className="relative overflow-hidden rounded-[4px] border border-border bg-surface-raised transition-shadow hover:shadow-raised">
      <div className="px-4 pb-4 pt-4 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-8 sm:px-6 sm:pb-5 sm:pt-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {/* The name is the link — and its ::after covers the whole card, so
                the card is the tap target (a phone thumb, not a 17px word). The
                quick links + review chip sit above it (relative z-10). */}
            <Link
              href={hubHref}
              data-testid="job-card-link"
              className="min-w-0 font-display text-[17px] font-bold leading-tight tracking-tight text-text after:absolute after:inset-0 after:content-[''] hover:underline hover:decoration-accent-yellow hover:decoration-2 hover:underline-offset-4 focus:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-brand-navy sm:text-[19px]"
            >
              {job.name}
            </Link>
            {phase !== "active" ? (
              <Pill dot tone={phaseTone(phase)}>
                {phaseLabel(phase)}
              </Pill>
            ) : null}
            {isQaTestJobName(job.name) ? <Pill tone="neutral">Test data</Pill> : null}
          </div>
          {numberPart || wordsPart ? (
            <p className="mt-1 break-words text-[13px] text-text-muted">
              {numberPart ? (
                <span className="font-mono text-xs font-medium tracking-[0.06em]">{numberPart}</span>
              ) : null}
              {numberPart && wordsPart ? " · " : null}
              {wordsPart}
            </p>
          ) : null}

          {/* The verdict — same dot + label + top reason the hub hero carries;
              a sentence alone when health isn't the read for this phase. One
              text flow, so a long reason wraps as words, not as a stray "·". */}
          <p className="mt-3 text-sm leading-snug">
            <span
              aria-hidden="true"
              className={cn(
                "mr-2 inline-block h-2.5 w-2.5 rounded-pill align-[0.05em]",
                VERDICT_DOT[verdict.tone]
              )}
            />
            {verdict.label ? (
              <span className="font-display text-base font-bold text-text">{verdict.label}</span>
            ) : null}
            {verdict.caption ? (
              <span className={verdict.label ? "text-text-muted" : "font-medium text-text"}>
                {verdict.label ? ` · ${verdict.caption}` : verdict.caption}
              </span>
            ) : null}
          </p>

          {/* Phone (2e): the facts collapse to one quiet line under the
              verdict — real facts only, plus when the job last moved. */}
          {facts.length > 0 ? (
            <p className="mt-2 text-[13px] tabular-nums text-text-muted sm:hidden">
              {facts.join(" · ")}
            </p>
          ) : null}

          {/* Phone: the one deep link that carries work — this job's review
              queue — stays one tap away (desktop has the quick-link row on the
              right). z-10 lifts it above the card's stretched link. */}
          {evidencePending > 0 ? (
            <div className="relative z-10 mt-3 sm:hidden">
              <QuickLink
                href={`/v2/jobs/${encodeURIComponent(job.id)}/evidence`}
                label={`Review ${evidencePending} →`}
                hot
                ariaLabel={`Open ${evidencePending} pending evidence for ${job.name}`}
                className="min-h-[44px] px-4 text-sm"
              />
            </div>
          ) : null}
        </div>

        <div className="hidden flex-col items-end gap-3 sm:flex">
          {/* Fixed-width columns, so Value / Crew / Tasks / Updated line up
              down the whole list and read like a table. */}
          <dl className="flex items-start text-right">
            <MetaCell label="Value" value={meta.value} muted={!meta.valueKnown} className="w-28" />
            <MetaCell label="Crew" value={meta.crew} muted={!meta.crewKnown} className="w-16" />
            <MetaCell
              label="Tasks"
              value={hasTasks ? `${Math.round(((tasksComplete as number) / (tasksTotal as number)) * 100)}%` : "—"}
              sub={hasTasks ? `${tasksComplete}/${tasksTotal}` : undefined}
              muted={!hasTasks}
              className="w-24"
            />
            <MetaCell
              label="Updated"
              value={updated || "—"}
              muted
              small
              className="w-24"
            />
          </dl>
          {/* Quick links — deep-link past the hub (power-user one-tap). Lifted
              above the card's stretched name link so they stay clickable. */}
          <div className="relative z-10 flex items-center gap-1.5">
            {canBuild ? (
              <QuickLink
                href={`/v2/jobs/${encodeURIComponent(job.id)}/builder`}
                label="Builder"
                ariaLabel={`Open the builder for ${job.name}`}
              />
            ) : null}
            <QuickLink
              href={`/v2/jobs/${encodeURIComponent(job.id)}/photos`}
              label="Photos"
              ariaLabel={`Open the photo wall for ${job.name}`}
            />
            {evidencePending > 0 ? (
              <QuickLink
                href={`/v2/jobs/${encodeURIComponent(job.id)}/evidence`}
                label={`Evidence ${evidencePending}`}
                hot
                ariaLabel={`Open ${evidencePending} pending evidence for ${job.name}`}
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* Attention rule (2a) — real health level, no fabricated score; only on
          the jobs that need you. */}
      {needsYou ? (
        <div
          className={cn("absolute inset-x-0 bottom-0 h-[3px]", VERDICT_DOT[verdict.tone])}
          role="img"
          aria-label={`Risk: ${healthLabel(health.level)}`}
        />
      ) : null}
    </div>
  );
}

/** Resolve the card meta with the streamed value folded in (statsOnly list).
 *  Value prefers the object's own figure, then the streamed one; "—" otherwise. */
function cardMetaWithStream(job: Job, extra?: CardExtra): JobCardMeta {
  const hasOwnValue = typeof job.contractValue === "number" && Number.isFinite(job.contractValue);
  const value = hasOwnValue
    ? (job.contractValue as number)
    : extra?.contractValue !== undefined
      ? extra.contractValue
      : undefined;
  const hasCrew = typeof job.statsCrewCount === "number" && Number.isFinite(job.statsCrewCount);
  return {
    value: value !== undefined ? formatContractValue(value) : "—",
    valueKnown: value !== undefined,
    crew: hasCrew ? String(job.statsCrewCount) : "—",
    crewKnown: hasCrew,
  };
}

/** Right-column stat (2a): mono label over a bold tabular display figure.
 *  `small` is for a quiet, non-figure value (when the job last moved) — it
 *  keeps the figure's line height so the row stays level. `sub` is a quiet
 *  detail after the figure (tasks done/total beside the percentage). */
function MetaCell({
  label,
  value,
  sub,
  muted,
  small,
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  muted?: boolean;
  small?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1.5 whitespace-nowrap tabular-nums",
          small
            ? "text-sm font-medium leading-[17px]"
            : "font-display text-[17px] font-bold leading-none",
          muted ? "text-text-muted" : "text-text"
        )}
      >
        {value}
        {sub ? (
          <span className="ml-1.5 font-sans text-xs font-medium text-text-muted">{sub}</span>
        ) : null}
      </dd>
    </div>
  );
}

/** Quiet per-card deep link (2a). `hot` marks the one with pending work. */
function QuickLink({
  href,
  label,
  hot,
  ariaLabel,
  className,
}: {
  href: string;
  label: string;
  hot?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <Link
      href={href as Route}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center rounded-[4px] border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand-navy",
        hot
          ? "border-brand-navy bg-brand-navy text-text-inverse hover:bg-accent-ink"
          : "border-border bg-surface text-text hover:bg-surface-subtle",
        className
      )}
    >
      {label}
    </Link>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-card border border-border bg-surface-raised">{children}</div>;
}

/** Resolves the streamed card-extras map and lifts it into JobsList state exactly
 *  once. `use()` suspends this leaf until the ?withStats read resolves (parent
 *  <Suspense fallback={null}>), so the cards paint immediately from statsOnly and
 *  the per-card task progress + Value fill in after. Renders nothing. */
function CardExtrasHydrator({
  promise,
  onResolved,
}: {
  promise: Promise<CardExtraMap>;
  onResolved: (m: CardExtraMap) => void;
}) {
  const resolved = use(promise);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    onResolved(resolved);
  }, [resolved, onResolved]);
  return null;
}
