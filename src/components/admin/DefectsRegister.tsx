"use client";

import Link from "next/link";
import type { Route } from "next";
import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertOctagon, CheckCircle2, ChevronRight, ClipboardCheck, ClipboardList, X } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { InboxStatStrip, type InboxStat } from "./InboxShell";
import { isActive, priorityLabel, priorityTone, statusLabel, statusTone } from "@/domains/snags/format";
import { SNAG_PRIORITIES, SNAG_STATUSES } from "@/domains/snags/schema";
import { bulkCloseSnags } from "@/domains/snags/client";
import {
  filterRegisterSnags,
  isRegisterSnagClosable,
  parseRegisterPriorityParam,
  parseRegisterStatusParam,
  registerActiveCount,
  registerEmptyStateMessage,
  registerStatusCounts,
  type RegisterFilters,
  type RegisterJobRef,
  type RegisterSnag,
} from "@/domains/snags/register";
import type { SnagPriority } from "@/domains/snags/types";
import { relativeWhen } from "@/domains/jobs/format";
import {
  clearRememberedFilters,
  writeRememberedFilters,
  type RememberedFilterSpec,
} from "@/lib/storage/remembered-filters";
import { useApplyRememberedFiltersOnce } from "@/lib/storage/use-remembered-filters";
import { cn } from "@/lib/cn";

interface Props {
  /** Whole register, pre-sorted by the API (active-first, priority,
   *  oldest first). The server component fetches ?status=all so the
   *  client filters locally — pill counts stay honest. */
  snags: ReadonlyArray<RegisterSnag>;
  /** Viewer-visible jobs (already LH-scoped by the API) for the job select. */
  jobs: ReadonlyArray<RegisterJobRef>;
}

/** Per-device remembered default for this list (#216 pattern). Exported
 *  for the render test so it exercises the real key + validators. */
export const DEFECTS_FILTERS_STORAGE_KEY = "buhlos.defects-register.filters";
export const DEFECTS_FILTER_SPEC: RememberedFilterSpec = {
  status: (v) => parseRegisterStatusParam(v) !== null,
  priority: (v) => parseRegisterPriorityParam(v) !== null,
  // Jobs come and go; a stale remembered id just filters to an honest
  // empty state with a visible Reset. Cap length to keep junk out.
  jobId: (v) => v.trim() !== "" && v.length <= 120,
};

/**
 * /defects — cross-job defects register (#414).
 *
 * Every snag across every visible job in ONE queue: status pills + job
 * and priority selects (URL-driven `?status=` / `?jobId=` / `?priority=`,
 * remembered per device per #216), rows deep-linking into the owning
 * job's snags page, and bulk-close on top of api/snags-bulk-close.js.
 *
 * Filter mechanics mirror JobsList (the #216 reference implementation):
 *   - Filter state is read LIVE from useSearchParams() — never
 *     snapshotted into useState (soft-nav pitfall, #116→#118).
 *   - Interaction writes mirror the URL via history.replaceState (no
 *     server round-trip) + write-through the per-device memory.
 *   - The remembered default applies once on mount, only when the URL
 *     carries none of the list's own params (URL always wins); Reset
 *     clears the URL params AND the stored default.
 *
 * Status markers reuse the snags domain's five-tone mapping
 * (statusTone/statusLabel — doc 27 §6); the brand-navy pills mark
 * SELECTION only. Legacy-store rows carry a subtle neutral "legacy"
 * pill — same data.json, older write path, closable here all the same.
 *
 * Bulk close: select closable rows → one inline arm/confirm step naming
 * the count (house rule: no window.confirm — see TestJobsCleanup) →
 * selection grouped BY JOB → one POST per job (the endpoint is per-job
 * + atomic by design) → per-snag results surfaced honestly (n closed,
 * m failed with reasons). Every viewer of this page is staff (route
 * gate: admin + LH); the server's canManageJob is the real authority —
 * an LH only ever SEES jobs they manage, so the checkboxes never
 * promise more than the API allows.
 */
export function DefectsRegister({ snags, jobs }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  // URL is the source of truth (validated; unknown values degrade to the
  // default Active view).
  const status = parseRegisterStatusParam(searchParams.get("status"));
  const priority = parseRegisterPriorityParam(searchParams.get("priority"));
  const jobIdParam = (searchParams.get("jobId") ?? "").trim();
  const jobId = jobIdParam === "" ? null : jobIdParam;
  const filters: RegisterFilters = { status, priority, jobId };

  useApplyRememberedFiltersOnce(DEFECTS_FILTERS_STORAGE_KEY, DEFECTS_FILTER_SPEC);

  // Selection is keyed `${jobId}:${snagId}` so one snag id appearing on
  // two jobs can't cross-select; the raw snag ids are recovered per job
  // when the calls are issued.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  /** Mirror a full filter set into the URL + the per-device memory.
   *  Interaction handlers only (never on load). */
  const writeFilters = (next: RegisterFilters) => {
    const params = new URLSearchParams(window.location.search);
    if (next.status) params.set("status", next.status);
    else params.delete("status");
    if (next.priority) params.set("priority", next.priority);
    else params.delete("priority");
    if (next.jobId) params.set("jobId", next.jobId);
    else params.delete("jobId");
    const qs = params.toString();
    try {
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    } catch {
      // History API throttled — filtering still works from URL state.
    }
    writeRememberedFilters(DEFECTS_FILTERS_STORAGE_KEY, {
      status: next.status,
      priority: next.priority,
      jobId: next.jobId,
    });
  };

  const handleReset = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete("status");
    params.delete("priority");
    params.delete("jobId");
    const qs = params.toString();
    try {
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    } catch {
      // Best-effort, as above.
    }
    clearRememberedFilters(DEFECTS_FILTERS_STORAGE_KEY);
  };

  const filtered = useMemo(
    () => filterRegisterSnags(snags, { status, priority, jobId }),
    [snags, status, priority, jobId]
  );

  const counts = useMemo(() => registerStatusCounts(snags), [snags]);
  const activeCount = useMemo(() => registerActiveCount(snags), [snags]);
  // Zero-count statuses stay hidden UNLESS deep-linked, so the active
  // filter is always visible and clearable (JobsList convention).
  const statusOptions = SNAG_STATUSES.filter((s) => (counts.get(s) ?? 0) > 0 || status === s);

  // Shared inbox stat strip (§6) — a glanceable header over the register's OWN
  // data (no new fetch). Every number is derived from the same `snags` the list
  // renders: open count + urgent/high among still-active rows (the "needs an
  // owner" signal) + resolved-awaiting-verify + closed. A zero reads calm/muted
  // (the shell handles that); nothing here is fabricated.
  // OMITTED vs the prototype: the "Stale > 3 days" tile — the register doesn't
  // compute a staleness threshold anywhere (it sorts oldest-first but has no
  // age-bucket count), so inventing one here would be a fabricated policy.
  const urgentHighActive = useMemo(
    () =>
      snags.reduce(
        (n, s) =>
          isActive(s.status) && (s.priority === "urgent" || s.priority === "high") ? n + 1 : n,
        0
      ),
    [snags]
  );
  const stats: InboxStat[] = [
    { key: "open", label: "Open", value: counts.get("open") ?? 0, icon: AlertOctagon, tone: "warning" },
    { key: "urgentHigh", label: "Urgent / high (open)", value: urgentHighActive, icon: ClipboardList, tone: "danger" },
    { key: "resolved", label: "Resolved (to verify)", value: counts.get("resolved") ?? 0, icon: ClipboardCheck, tone: "info" },
    { key: "closed", label: "Closed", value: counts.get("closed") ?? 0, icon: CheckCircle2, tone: "success" },
  ];

  const jobNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of jobs) m.set(j.id, j.name);
    return m;
  }, [jobs]);

  const filtersActive = status !== null || priority !== null || jobId !== null;

  // Only rows the endpoint will actually close get a checkbox.
  const visibleSelected = useMemo(() => {
    const visibleKeys = new Set(filtered.map(rowKey));
    return new Set([...selected].filter((k) => visibleKeys.has(k)));
  }, [filtered, selected]);

  const toggleRow = (key: string) => {
    setResult(null);
    setArmed(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  async function runBulkClose() {
    setBusy(true);
    setResult(null);
    // Group the selection by job — the endpoint is per-job + atomic.
    const byJob = new Map<string, string[]>();
    for (const item of filtered) {
      if (!visibleSelected.has(rowKey(item))) continue;
      const ids = byJob.get(item.jobId) ?? [];
      ids.push(item.id);
      byJob.set(item.jobId, ids);
    }
    let closedCount = 0;
    const failures: string[] = [];
    // Sequential on purpose: each call is one read-modify-write of that
    // job's data.json; hammering them in parallel buys nothing.
    for (const [job, ids] of byJob) {
      const res = await bulkCloseSnags(job, ids);
      if (!res.ok) {
        const jobName = jobNameById.get(job) ?? job;
        failures.push(`${jobName}: ${ids.length} not closed — ${res.error.message}`);
        continue;
      }
      closedCount += res.data.closedCount;
      for (const f of res.data.failed) {
        failures.push(`${f.snagId ?? "(missing id)"}: ${f.error}`);
      }
    }
    const attempted = [...byJob.values()].reduce((n, ids) => n + ids.length, 0);
    if (failures.length === 0) {
      setResult(`Closed ${closedCount} ${closedCount === 1 ? "defect" : "defects"}.`);
    } else {
      const shown = failures.slice(0, 3).join("; ");
      const more = failures.length > 3 ? ` (+${failures.length - 3} more)` : "";
      setResult(
        `Closed ${closedCount} of ${attempted}. ${failures.length} didn't close — ${shown}${more}.`
      );
    }
    setSelected(new Set());
    setArmed(false);
    setBusy(false);
    // Re-run the server component so closed rows reflect server truth.
    router.refresh();
  }

  if (snags.length === 0) {
    return (
      <EmptyState
        title="No defects recorded"
        description="When a snag is raised on any of your jobs — from Phil or BuhlOS — it'll appear here."
      />
    );
  }

  const selectedCount = visibleSelected.size;
  const selectedJobCount = new Set(
    filtered.filter((i) => visibleSelected.has(rowKey(i))).map((i) => i.jobId)
  ).size;

  return (
    <div className="space-y-3">
      <InboxStatStrip stats={stats} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          role="group"
          aria-label="Filter defects by status"
          className="flex flex-wrap items-center gap-1.5"
        >
          <FilterPill
            label="Active"
            count={activeCount}
            selected={status === null}
            onClick={() => writeFilters({ ...filters, status: null })}
          />
          {statusOptions.map((s) => (
            <FilterPill
              key={s}
              label={statusLabel(s)}
              count={counts.get(s) ?? 0}
              selected={status === s}
              onClick={() => writeFilters({ ...filters, status: s })}
            />
          ))}
          <FilterPill
            label="All"
            count={snags.length}
            selected={status === "all"}
            onClick={() => writeFilters({ ...filters, status: "all" })}
          />
          {filtersActive ? (
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
              Reset to active
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex w-full items-center gap-2 text-sm text-text-muted sm:w-auto">
            <span className="sr-only sm:not-sr-only">Job</span>
            <select
              aria-label="Filter defects by job"
              value={jobId ?? ""}
              onChange={(e) =>
                writeFilters({ ...filters, jobId: e.target.value === "" ? null : e.target.value })
              }
              className="w-full min-w-0 rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy sm:w-auto sm:max-w-[220px]"
            >
              <option value="">All jobs</option>
              {[...jobs]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex w-full items-center gap-2 text-sm text-text-muted sm:w-auto">
            <span className="sr-only sm:not-sr-only">Priority</span>
            <select
              aria-label="Filter defects by priority"
              value={priority ?? ""}
              onChange={(e) =>
                writeFilters({
                  ...filters,
                  priority: e.target.value === "" ? null : (e.target.value as SnagPriority),
                })
              }
              className="w-full min-w-0 rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy sm:w-auto"
            >
              <option value="">All priorities</option>
              {SNAG_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {priorityLabel(p)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {selectedCount > 0 ? (
        <div
          data-testid="defects-bulk-bar"
          className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-surface-raised px-4 py-2.5"
        >
          <p className="text-sm text-text">
            <span className="font-semibold">{selectedCount}</span>{" "}
            {selectedCount === 1 ? "defect" : "defects"} selected
            {selectedJobCount > 1 ? ` across ${selectedJobCount} jobs` : ""}
          </p>
          {busy ? (
            <span className="text-sm text-text-muted" data-testid="defects-bulk-busy">
              Closing {selectedCount} {selectedCount === 1 ? "defect" : "defects"}…
            </span>
          ) : armed ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                data-testid="defects-bulk-confirm"
                onClick={() => void runBulkClose()}
              >
                Yes, close {selectedCount} {selectedCount === 1 ? "defect" : "defects"}
                {selectedJobCount > 1 ? ` across ${selectedJobCount} jobs` : ""}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              data-testid="defects-bulk-arm"
              onClick={() => setArmed(true)}
            >
              <ClipboardCheck aria-hidden="true" className="h-4 w-4" /> Close{" "}
              {selectedCount === 1 ? "defect" : `${selectedCount} defects`}…
            </Button>
          )}
        </div>
      ) : null}

      {result ? (
        <p
          role="status"
          data-testid="defects-bulk-result"
          className="rounded-card border border-border bg-surface-subtle px-4 py-2.5 text-sm text-text"
        >
          {result}
        </p>
      ) : null}

      {filtered.length === 0 ? (
        <div className="rounded-card border border-border bg-surface-raised">
          <div className="py-6 text-center text-sm text-text-muted">
            {registerEmptyStateMessage(filters, {
              jobName: jobId ? jobNameById.get(jobId) : null,
              statusLabelOf: statusLabel,
            })}
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
          {filtered.map((item) => {
            const key = rowKey(item);
            return (
              <li key={key}>
                <DefectRow
                  item={item}
                  selected={visibleSelected.has(key)}
                  onToggle={() => toggleRow(key)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function rowKey(item: Pick<RegisterSnag, "jobId" | "id">): string {
  return `${item.jobId}:${item.id}`;
}

/** Selection pill — brand navy marks SELECTION (doc 27 §6); the row's
 *  status Pill keeps the five-tone palette via statusTone. */
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
        "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand-navy",
        selected
          ? "border-brand-navy bg-brand-navy text-text-inverse"
          : "border-border bg-surface text-text hover:bg-surface-subtle"
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "inline-flex h-4 min-w-[16px] items-center justify-center rounded-pill px-1 text-[10px] font-semibold",
          selected ? "bg-accent-yellow text-brand-navy" : "bg-surface-subtle text-text-muted"
        )}
      >
        {count}
      </span>
    </button>
  );
}

function DefectRow({
  item,
  selected,
  onToggle,
}: {
  item: RegisterSnag;
  selected: boolean;
  onToggle: () => void;
}) {
  const closable = isRegisterSnagClosable(item);
  const age = item.createdAt ? relativeWhen(item.createdAt) : "";
  const meta = [
    item.areaName,
    item.assignedToName,
    item.evidenceCount > 0
      ? `${item.evidenceCount} ${item.evidenceCount === 1 ? "photo" : "photos"}`
      : null,
  ].filter(Boolean);

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      {closable ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${item.title || "untitled defect"} on ${item.jobName}`}
          className="mt-1.5 h-4 w-4 shrink-0 rounded border-border accent-brand-navy focus:outline-none focus:ring-2 focus:ring-brand-navy"
        />
      ) : (
        // Keep the text column aligned when the row isn't closable.
        <span aria-hidden="true" className="mt-1.5 h-4 w-4 shrink-0" />
      )}

      <Link
        href={`/v2/jobs/${encodeURIComponent(item.jobId)}/snags` as Route}
        className="flex min-w-0 flex-1 items-start gap-3 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-navy"
        aria-label={`Open snags for ${item.jobName}`}
      >
        <div className="flex shrink-0 flex-col items-start gap-1 pt-0.5">
          <Pill tone={statusTone(item.status)}>{statusLabel(item.status)}</Pill>
          <Pill tone={priorityTone(item.priority)}>{priorityLabel(item.priority)}</Pill>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-base font-semibold text-text">
            {item.title || "Untitled defect"}
          </p>
          <p className="mt-0.5 truncate text-sm text-text-muted">{item.jobName}</p>
          {meta.length > 0 ? (
            <p className="mt-0.5 truncate text-xs text-text-muted">{meta.join(" · ")}</p>
          ) : null}
        </div>
      </Link>

      <div className="flex shrink-0 flex-col items-end gap-1">
        {age ? (
          <span className="whitespace-nowrap text-[11px] uppercase tracking-wider text-text-muted">
            {age}
          </span>
        ) : null}
        {item.source === "legacy" ? <Pill tone="neutral">legacy</Pill> : null}
        <ChevronRight
          aria-hidden="true"
          className="hidden h-5 w-5 text-text-muted/60 sm:block"
        />
      </div>
    </div>
  );
}
