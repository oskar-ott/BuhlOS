"use client";

import type { ReactNode } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Info,
  Loader2,
  Split,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { formatHoursLabel } from "@/domains/timesheets/format";
import { STANDARD_DAY_HOURS } from "@/domains/timesheets/service";
import {
  LEAVE_LABELS,
  dayDate,
  leaveOptions,
  receiptLine,
  statusWordFor,
  weekdayName,
  type HoursJob,
  type LeaveType,
} from "@/domains/timesheets/hours-view";
import type { HoursProblem } from "@/domains/timesheets/problem";
import type { TimeEntry } from "@/domains/timesheets/types";
import { JobChips } from "./JobChips";
import { LEAVE_ICON } from "./LeavePills";
import { ProblemBlock } from "./ProblemBlock";
import styles from "./hours.module.css";

/**
 * The bottom panel (docs/phil-hours.md): job, then the one primary action
 * that names the whole decision, then the action bar. Every state it can be
 * in is a named variant below; buttons someone can't use are absent, never
 * disabled, and a blocked primary is replaced by its reason in words.
 */
export interface PanelProblem {
  problem: HoursProblem;
  onRetry?: (() => void) | null;
  retryLabel?: string;
}

export interface PanelLeaveActions {
  canLogTafe: boolean;
  onLeave: (type: LeaveType) => void;
}

export type PanelState =
  | { kind: "nothing"; line: string; sub?: string }
  | { kind: "saving"; date: string; jobLabel: string | null; hoursLabel: string }
  | { kind: "saved"; entry: TimeEntry; jobs: ReadonlyArray<HoursJob> }
  | { kind: "unconfirmed"; date: string; problem: PanelProblem }
  | { kind: "jobsFailed"; onRetry: () => void }
  | ({ kind: "noJobs"; date: string } & PanelLeaveActions)
  | ({
      kind: "noDefault";
      date: string;
      jobs: ReadonlyArray<HoursJob>;
      onPickJob: (jobId: string) => void;
      onFind: () => void;
    } & PanelLeaveActions)
  | ({
      kind: "ready";
      date: string;
      weekend: boolean;
      /** The picked day sits in an earlier week. */
      backdated: boolean;
      jobs: ReadonlyArray<HoursJob>;
      pickedJob: HoursJob;
      lastJobId: string | null;
      foundJob: HoursJob | null;
      onPickJob: (jobId: string) => void;
      onFind: () => void;
      onLog: () => void;
      onOt: () => void;
      /** Null when the worker has one job — the button is absent. */
      onSplit: (() => void) | null;
      /** A refused save for this day, shown in this slot. */
      problem?: PanelProblem | null;
    } & PanelLeaveActions);

export function HoursBottomPanel({
  state,
  offline,
}: {
  state: PanelState;
  offline: boolean;
}): ReactNode {
  return (
    <section
      aria-label="Log hours"
      data-testid="hours-panel"
      data-panel={state.kind}
      className="sticky bottom-0 z-20 -mx-4 -mb-4 rounded-t-[20px] border-t border-border bg-surface px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_rgba(15,23,42,0.10)]"
    >
      <PanelBody state={state} offline={offline} />
    </section>
  );
}

function PanelBody({ state, offline }: { state: PanelState; offline: boolean }): ReactNode {
  switch (state.kind) {
    case "nothing":
      return (
        <div className="space-y-1 py-2" data-testid="hours-panel-nothing">
          <p className="font-display text-[16px] font-bold">{state.line}</p>
          {state.sub ? <p className="text-[14px] text-text-muted">{state.sub}</p> : null}
        </div>
      );

    case "saving":
      return (
        <div className="space-y-3">
          <JobLine day={state.date} name={state.jobLabel ?? "No job"} />
          <button
            type="button"
            disabled
            aria-busy="true"
            data-testid="hours-log-primary"
            className="flex min-h-[64px] w-full items-center justify-center gap-2 rounded-[14px] bg-accent-yellow px-4 font-display text-[17px] font-bold text-accent-ink"
          >
            <Loader2 aria-hidden="true" className={cn("h-5 w-5", styles.spin)} />
            Saving…
          </button>
          <p className="text-center text-[14px] text-text-muted">
            Hold on — this only takes a moment.
          </p>
        </div>
      );

    case "saved":
      return (
        <div className="space-y-1 py-1" data-testid="hours-panel-saved" role="status">
          <p className="flex items-center gap-2 font-display text-[18px] font-bold text-state-success">
            <CheckCircle2 aria-hidden="true" className="h-5 w-5" />
            Saved
          </p>
          <p className="text-[15px] tabular-nums text-text">
            {`${receiptLine(state.entry, state.jobs)} · ${statusWordFor(state.entry)}`}
          </p>
          <p className="text-[14px] text-text-muted">To log another day, tap it.</p>
        </div>
      );

    case "unconfirmed":
      return (
        <ProblemBlock
          problem={state.problem.problem}
          onRetry={state.problem.onRetry ?? undefined}
          retryLabel={state.problem.retryLabel}
        />
      );

    case "jobsFailed":
      return (
        <ProblemBlock
          problem={{
            caption: "Hours not saved",
            title: "Couldn't load your jobs",
            why: "Your phone couldn't reach BuhlOS — usually no signal or Wi-Fi.",
            todo: "Pull to refresh and try again.",
            canRetry: true,
          }}
          onRetry={state.onRetry}
          retryLabel="Try again · load your jobs"
        />
      );

    case "noJobs":
      return (
        <div className="space-y-3">
          <div
            className="rounded-[16px] bg-[#fef3c7] p-4"
            role="status"
            data-testid="hours-panel-no-jobs"
          >
            <p className="font-display text-[16px] font-bold">No active assigned job</p>
            <p className="mt-1 text-[14px] text-text">
              Ask the office to assign you to a job. Until then you can log a sick day or holiday.
            </p>
          </div>
          <ActionBar items={leaveItems(state, ["sick", "holiday"])} />
        </div>
      );

    case "noDefault":
      return (
        <div className="space-y-3" data-testid="hours-panel-no-default">
          <div className="flex items-start gap-2 rounded-[16px] bg-[#dbeafe] p-4" role="status">
            <Info aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-state-info" />
            <div>
              <p className="font-display text-[16px] font-bold">
                Pick which job these hours are for
              </p>
              <p className="mt-1 text-[14px] text-text">
                {`You're on ${state.jobs.length} jobs and haven't logged one yet, so there's no default.`}
              </p>
            </div>
          </div>
          <SectionLabel>{`Job for ${weekdayName(state.date)}`}</SectionLabel>
          <JobChips
            jobs={state.jobs}
            pickedJobId={null}
            lastJobId={null}
            date={state.date}
            onPick={state.onPickJob}
            onFind={state.onFind}
          />
          <p className="text-center text-[14px] text-text-muted">
            Tap a job and the log button appears here.
          </p>
          <ActionBar items={leaveItems(state, ["sick", "holiday"])} />
        </div>
      );

    case "ready": {
      const day = weekdayName(state.date);
      const several = state.jobs.length > 1 || state.foundJob !== null;
      return (
        <div className="space-y-3">
          {state.problem ? (
            <ProblemBlock
              problem={state.problem.problem}
              onRetry={state.problem.onRetry ?? undefined}
              retryLabel={state.problem.retryLabel}
            />
          ) : null}

          {several ? (
            <>
              <SectionLabel>{`Job for ${day}`}</SectionLabel>
              <JobChips
                jobs={state.jobs}
                pickedJobId={state.pickedJob.id}
                lastJobId={state.lastJobId}
                foundJob={state.foundJob}
                date={state.date}
                onPick={state.onPickJob}
                onFind={state.onFind}
              />
            </>
          ) : (
            <button
              type="button"
              onClick={state.onFind}
              data-testid="hours-job-field"
              className="flex min-h-[56px] w-full items-center justify-between gap-3 rounded-card border border-border-strong bg-surface px-4 text-left active:bg-surface-subtle"
            >
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                  {`Job for ${day}`}
                </span>
                <span className="block truncate font-display text-[16px] font-bold text-text">
                  {state.pickedJob.name}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-0.5 font-display text-[15px] font-semibold text-brand-navy">
                Change
                <ChevronRight aria-hidden="true" className="h-4 w-4" />
              </span>
            </button>
          )}

          {state.backdated ? (
            <p
              className="text-[14px] text-text-muted tabular-nums"
              data-testid="hours-backdated-line"
            >
              {`From an earlier week · you're sending ${dayDate(state.date)} · ${state.pickedJob.name} · ${
                state.weekend ? "weekend hours" : formatHoursLabel(STANDARD_DAY_HOURS)
              }`}
            </p>
          ) : null}

          {state.weekend ? (
            <PrimaryButton
              onClick={state.onOt}
              label={`Set ${day}'s hours →`}
              sub="No standard day on a weekend · all of it counts as OT"
            />
          ) : (
            <PrimaryButton
              onClick={state.onLog}
              label={`Log ${day} · ${formatHoursLabel(STANDARD_DAY_HOURS)}`}
              sub={
                offline
                  ? "Needs signal to send · you'll see if it fails"
                  : `${state.pickedJob.name} · sends to the office`
              }
            />
          )}

          {!state.weekend ? (
            <ActionBar
              items={[
                {
                  label: "Custom or OT",
                  Icon: Timer,
                  onClick: state.onOt,
                  testId: "hours-action-ot",
                },
                ...(state.onSplit
                  ? [
                      {
                        label: "Split jobs",
                        Icon: Split,
                        onClick: state.onSplit,
                        testId: "hours-action-split",
                      },
                    ]
                  : []),
                ...leaveItems(state, leaveOptions(state.canLogTafe)),
              ]}
            />
          ) : null}
        </div>
      );
    }
  }
}

function leaveItems(actions: PanelLeaveActions, types: ReadonlyArray<LeaveType>): ActionItem[] {
  return types
    .filter((t) => t !== "tafe" || actions.canLogTafe)
    .map((t) => ({
      label: LEAVE_LABELS[t],
      Icon: LEAVE_ICON[t],
      onClick: () => actions.onLeave(t),
      testId: `hours-action-${t}`,
    }));
}

function SectionLabel({ children }: { children: string }): ReactNode {
  return (
    <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-muted">
      {children}
    </p>
  );
}

function JobLine({ day, name }: { day: string; name: string }): ReactNode {
  return (
    <div className="rounded-card border border-border bg-surface-subtle px-4 py-2">
      <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-muted">{`Job for ${weekdayName(day)}`}</p>
      <p className="truncate font-display text-[16px] font-bold text-text">{name}</p>
    </div>
  );
}

function PrimaryButton({
  onClick,
  label,
  sub,
}: {
  onClick: () => void;
  label: string;
  sub: string;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="hours-log-primary"
      className="flex min-h-[64px] w-full flex-col items-center justify-center rounded-[14px] bg-accent-yellow px-4 py-2 text-accent-ink shadow-card active:scale-[0.99]"
    >
      <span className="font-display text-[17px] font-bold leading-tight tabular-nums">{label}</span>
      <span className="mt-0.5 max-w-full truncate text-[13px] font-medium text-accent-ink/80">
        {sub}
      </span>
    </button>
  );
}

interface ActionItem {
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  testId: string;
}

function ActionBar({ items }: { items: ActionItem[] }): ReactNode {
  if (items.length === 0) return null;
  return (
    <div
      className="flex divide-x divide-border overflow-hidden rounded-card border border-border bg-surface"
      role="group"
      aria-label="Other ways to log this day"
    >
      {items.map(({ label, Icon, onClick, testId }) => (
        <button
          key={testId}
          type="button"
          onClick={onClick}
          data-testid={testId}
          className="flex min-h-[64px] min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 text-text active:bg-surface-subtle"
        >
          <Icon aria-hidden="true" className="h-5 w-5 text-text-muted" />
          <span className="max-w-full truncate font-display text-[12px] font-semibold leading-tight">
            {label}
          </span>
        </button>
      ))}
    </div>
  );
}
