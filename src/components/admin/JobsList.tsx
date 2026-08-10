"use client";

import Link from "next/link";
import type { Route } from "next";
import { Suspense, use, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Archive, Plus, Search, X } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  JOB_STATUS_OPTIONS,
  lastActivityCaption,
  statusLabel,
  statusTone,
} from "@/domains/jobs/format";
import {
  filterJobs,
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
  type JobCardMeta,
} from "@/domains/jobs/portfolio";
import type { Job, JobStatus } from "@/domains/jobs/types";
import {
  clearRememberedFilters,
  writeRememberedFilters,
  type RememberedFilterSpec,
} from "@/lib/storage/remembered-filters";
import { useApplyRememberedFiltersOnce } from "@/lib/storage/use-remembered-filters";
import { pctWidthClass } from "@/components/admin/pct-width";
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
  const writeFilters = (next: { status: JobStatus | null; query: string }) => {
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

  const handleStatusClick = (next: JobStatus | null) => {
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
  const portfolio = useMemo(() => {
    const enriched = jobs.map((j) => withStreamedValue(j, streamedExtras[j.id]));
    return buildPortfolioSummary({
      jobs: enriched,
      healthByIndex: enriched.map((j) => deriveJobHealth(j)),
    });
  }, [jobs, streamedExtras]);

  const counts = useMemo(() => jobStatusCounts(jobs), [jobs]);
  // Statuses with zero jobs stay hidden (this page excludes archived rows
  // server-side) UNLESS the URL deep-links to one, in which case the pill
  // renders so the active filter is visible and clearable.
  const statusOptions = JOB_STATUS_OPTIONS.filter((s) => (counts.get(s) ?? 0) > 0 || status === s);

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
        <p className="min-w-0 text-sm text-text-muted">{portfolio.subline}</p>
        <div className="flex flex-wrap items-center gap-3">
          {portfolio.totalContract ? (
            <div className="text-right">
              <div className="flex items-baseline justify-end gap-1.5">
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
              per-job status change on the hub, so the portfolio offers the
              honest entry point to that flow rather than a multi-select that
              can't write. */}
          <Link
            href={"/v2/jobs?status=archived" as Route}
            className="inline-flex items-center gap-1.5 rounded-card border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
          >
            <Archive aria-hidden="true" className="h-4 w-4" /> Archived
          </Link>
          {newJobHref ? (
            <Link
              data-testid="jobs-new-job"
              href={newJobHref as Route}
              className="inline-flex items-center gap-1.5 rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-ink focus:outline-none focus:ring-2 focus:ring-brand-navy"
            >
              <Plus aria-hidden="true" className="h-4 w-4" /> New job
            </Link>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex w-full max-w-md items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Filter by name, address, or ref"
            aria-label="Filter jobs"
            className="w-full bg-transparent text-text outline-none placeholder:text-text-muted"
          />
        </label>

        <div
          role="group"
          aria-label="Filter jobs by status"
          className="flex flex-wrap items-center gap-1.5"
        >
          <FilterPill
            label="All"
            count={jobs.length}
            selected={status === null}
            onClick={() => handleStatusClick(null)}
          />
          {statusOptions.map((s) => (
            <FilterPill
              key={s}
              label={statusLabel(s)}
              count={counts.get(s) ?? 0}
              selected={status === s}
              onClick={() => handleStatusClick(s)}
            />
          ))}
          {filtersActive ? (
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
              Reset to all
            </button>
          ) : null}
        </div>

        {/* #227: health filter — triage the portfolio by risk. Only levels with
            jobs in the current status/search view render a pill. */}
        <div
          role="group"
          aria-label="Filter jobs by health"
          className="flex flex-wrap items-center gap-1.5"
        >
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
        <p className="ml-auto font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
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
        <ul className="grid gap-3">
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
        "inline-flex items-center gap-1.5 rounded-[6px] border px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-brand-navy",
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

/** Verdict dot + meter colours per level — the solid state dots, matching the
 *  hub hero so the verdict travels list→detail in the same voice (2f §06). */
const HEALTH_DOT: Record<JobHealthLevel, string> = {
  "at-risk": "bg-state-danger-dot",
  watch: "bg-state-warning-dot",
  good: "bg-state-success-dot",
  unknown: "bg-state-neutral-dot",
};

/** Risk-meter fill — driven by the real health level, not a fabricated 0–100
 *  score. Widths come off the pctWidthClass ladder (inline styles are banned). */
const RISK_BAR: Record<JobHealthLevel, { width: string; bar: string }> = {
  "at-risk": { width: pctWidthClass(100, 100), bar: "bg-state-danger-dot" },
  watch: { width: pctWidthClass(66, 100), bar: "bg-state-warning-dot" },
  good: { width: pctWidthClass(25, 100), bar: "bg-state-success-dot" },
  unknown: { width: pctWidthClass(0, 100), bar: "bg-border" },
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
  const topReason = health.reasons[0] ?? null;

  // Task progress: prefer the job object's own counts (full read), else the
  // streamed map. When neither is present the progress line omits.
  const tasksTotal =
    typeof job.statsTasksTotal === "number" ? job.statsTasksTotal : extra?.tasksTotal;
  const tasksComplete =
    typeof job.statsTasksComplete === "number" ? job.statsTasksComplete : extra?.tasksComplete;

  // Value: the object's value (full read), else the streamed value. Crew is on
  // both reads. Honest "—" when absent (LH redaction / not loaded), never 0.
  const meta = cardMetaWithStream(job, extra);

  const caption = lastActivityCaption(job);
  const address = (job.siteAddress ?? "").trim();
  // Mono identity line, 2a: code · ref · type · address — real parts only.
  const idLine = [job.code, job.ref, job.typeName, address].filter(Boolean).join(" · ");
  const evidencePending = job.statsEvidenceV2Pending ?? 0;

  // Verdict sub-caption: the top real reason; for clean/absent reads, a true
  // sentence about the state — never an invented number (P7).
  const verdictCaption = topReason
    ? `${topReason.count} ${topReason.label.toLowerCase()}`
    : health.level === "good"
      ? "nothing needs you"
      : health.level === "unknown"
        ? job.status === "draft"
          ? "publish to start tracking"
          : null
        : null;

  const tasksPct =
    typeof tasksTotal === "number" && typeof tasksComplete === "number" && tasksTotal > 0
      ? `${Math.round((tasksComplete / tasksTotal) * 100)}%`
      : "—";

  const risk = RISK_BAR[health.level];

  return (
    <div className="relative overflow-hidden rounded-[4px] border border-border bg-surface-raised transition-shadow hover:shadow-raised">
      <div className="flex items-start justify-between gap-4 px-4 pb-5 pt-4 sm:gap-8 sm:px-6 sm:pb-6 sm:pt-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link
              href={hubHref}
              className="font-display text-[17px] font-bold leading-tight tracking-tight text-text hover:underline hover:decoration-accent-yellow hover:decoration-2 hover:underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-navy sm:text-[20px]"
            >
              {job.name}
            </Link>
            <Pill dot tone={statusTone(job.status)}>
              {statusLabel(job.status)}
            </Pill>
            {isQaTestJobName(job.name) ? <Pill tone="neutral">Test data</Pill> : null}
          </div>
          {idLine ? (
            <p className="mt-1.5 font-mono text-xs font-medium uppercase tracking-[0.1em] text-text-muted">
              {idLine}
            </p>
          ) : null}

          {/* The verdict — same dot + label + top reason the hub hero carries. */}
          <p className="mt-3 flex items-center gap-2.5 text-sm">
            <span
              aria-hidden="true"
              className={cn("h-2.5 w-2.5 shrink-0 rounded-pill", HEALTH_DOT[health.level])}
            />
            <span className="font-display text-[17px] font-bold leading-none text-text">
              {healthLabel(health.level)}
            </span>
            {verdictCaption ? <span className="text-text-muted">· {verdictCaption}</span> : null}
            {caption ? (
              <span className="hidden text-xs uppercase tracking-wider text-text-muted lg:inline">
                · {caption}
              </span>
            ) : null}
          </p>

          {/* Phone (2e): the stats collapse to one mono line under the verdict. */}
          <p className="mt-2.5 font-mono text-xs font-medium uppercase tracking-[0.08em] text-text-muted sm:hidden">
            {meta.value} · Crew {meta.crew} · Tasks {tasksPct}
          </p>
        </div>

        <div className="hidden shrink-0 flex-col items-end gap-3 sm:flex">
          <dl className="flex items-start gap-8 text-right">
            <MetaCell label="Value" value={meta.value} muted={!meta.valueKnown} />
            <MetaCell label="Crew" value={meta.crew} muted={!meta.crewKnown} />
            <MetaCell
              label="Tasks"
              value={tasksPct}
              muted={!(typeof tasksTotal === "number" && tasksTotal > 0)}
              hint={
                typeof tasksTotal === "number" &&
                typeof tasksComplete === "number" &&
                tasksTotal > 0
                  ? `${tasksComplete}/${tasksTotal}`
                  : undefined
              }
            />
          </dl>
          {/* Quick links — deep-link past the hub (power-user one-tap). */}
          <div className="flex items-center gap-1.5">
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

      {/* The slim risk meter (2a) — real health level, no fabricated score. */}
      <div
        className="absolute inset-x-0 bottom-0 h-[3px] bg-surface-subtle"
        role="img"
        aria-label={`Risk: ${healthLabel(health.level)}`}
      >
        <span className={cn("block h-full", risk.width, risk.bar)} />
      </div>
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

/** Right-column stat (2a): mono label over a bold tabular display figure. */
function MetaCell({
  label,
  value,
  muted,
  hint,
}: {
  label: string;
  value: string;
  muted?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <dt className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
        {label}
        {hint ? <span className="ml-1 normal-case tracking-normal">· {hint}</span> : null}
      </dt>
      <dd
        className={cn(
          "mt-1 font-display text-[17px] font-bold tabular-nums leading-none",
          muted ? "text-text-muted" : "text-text"
        )}
      >
        {value}
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
}: {
  href: string;
  label: string;
  hot?: boolean;
  ariaLabel: string;
}) {
  return (
    <Link
      href={href as Route}
      aria-label={ariaLabel}
      className={cn(
        "rounded-[4px] border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand-navy",
        hot
          ? "border-brand-navy bg-brand-navy text-text-inverse hover:bg-accent-ink"
          : "border-border bg-surface text-text hover:bg-surface-subtle"
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
