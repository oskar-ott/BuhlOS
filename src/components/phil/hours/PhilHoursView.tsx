"use client";

import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ChevronRight, RotateCw, WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { timesheetsClient } from "@/domains/timesheets/client";
import { readSavedEntries, recordSavedEntry } from "@/domains/timesheets/saved-entries-journal";
import { useSubmissionKey } from "@/domains/timesheets/useSubmissionKey";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  STANDARD_DAY_HOURS,
  buildCustomHoursPayload,
  buildSplitDayPayload,
  buildStandardDayPayload,
  isWeekendDate,
  lastLoggedJobFor,
  primaryJobId,
  weekStartOf,
} from "@/domains/timesheets/service";
import {
  buildDayTypeResubmitPayload,
  buildResubmitPayload,
  buildSplitResubmitPayload,
} from "@/domains/timesheets/resubmit";
import {
  buildDraftSendPayload,
  buildEarlierWeeks,
  defaultJobId,
  entriesInWeek,
  entryTarget,
  fixNeededLine,
  initialPick,
  isLoggableDate,
  mergeSavedEntries,
  nextPickAfterSave,
  weekRangeLabel,
  weekRows,
  weekSummaryLine,
  weekdayName,
  type HoursJob,
  type LeaveType,
} from "@/domains/timesheets/hours-view";
import {
  retryDay,
  sendDay,
  type SaveAttempt,
  type SaveOutcome,
  type SaveWire,
} from "@/domains/timesheets/hours-save";
import type { HoursProblem } from "@/domains/timesheets/problem";
import type { PatchTimeEntryPayload, TimeEntry } from "@/domains/timesheets/types";
import { useOnline } from "../useOnline";
import { DayDetailSheet } from "./DayDetailSheet";
import { EarlierWeeks } from "./EarlierWeeks";
import { FindJobSheet } from "./FindJobSheet";
import { FixSheet } from "./FixSheet";
import { HoursBottomPanel, type PanelState } from "./HoursBottomPanel";
import { HoursWeekCard, type RowUiState } from "./HoursWeekCard";
import { LeaveSheet } from "./LeaveSheet";
import { OtSheet } from "./OtSheet";
import { SplitSheet } from "./SplitSheet";

/**
 * The worker's Hours screen (docs/phil-hours.md — the 2026-10 "Log my hours"
 * redesign). This week as rows, one bottom panel that names the whole
 * decision, and the sheets for everything that isn't the one-tap standard
 * day. Everything shown is a real entry, a real calendar day or a sum of
 * stored hours (P7); the app does not know which days anyone works, so it
 * never says "to go" or "week done".
 *
 * One day's states: Unlogged → Saving… → Waiting on the office (server
 * confirms) · Saving… → Unlogged + error block (refused) · Saving… → Not
 * confirmed (no answer) → Try again re-reads the day first and only resends
 * if it isn't there (hours-save.ts) — never twice.
 */
export interface PhilHoursViewProps {
  /** The worker's full entry history (newest first). Ignored when `loadFailed`. */
  entries: ReadonlyArray<TimeEntry>;
  /** The hours read failed: the screen shows the failed state — no numbers. */
  loadFailed: boolean;
  /** Sydney-local today, YYYY-MM-DD. */
  todayISO: string;
  /** Assigned jobs (plus any finished job the history names). */
  jobs: ReadonlyArray<HoursJob>;
  jobsError: boolean;
  viewerId: string | null;
  canLogTafe: boolean;
  /** `?log=1` — arrived to log: today is picked. */
  launchLog?: boolean;
  /** `?job=` — arrived from a job screen: that job is picked for today. */
  launchJobId?: string | null;
  /** `?fix=` — arrived to fix a sent-back day: its Fix sheet opens. */
  launchFixDate?: string | null;
}

type Sheet =
  | { kind: "none" }
  | { kind: "ot"; date: string; variant: "weekday" | "weekend" }
  | { kind: "leave"; date: string; preset: LeaveType }
  | { kind: "split"; date: string }
  | { kind: "detail"; date: string }
  | { kind: "change"; date: string }
  | { kind: "fix"; date: string };

type Result =
  | { kind: "saved"; entry: TimeEntry }
  | { kind: "refused"; date: string; problem: HoursProblem; attempt: SaveAttempt }
  | null;

const wire: SaveWire = {
  create: (payload, idempotencyKey) => timesheetsClient.submitNewEntry(payload, { idempotencyKey }),
  patch: (date, payload, idempotencyKey) =>
    timesheetsClient.editOwnEntry(date, payload, { idempotencyKey }),
  readDay: (date) => timesheetsClient.listOwnEntries({ fromDate: date, toDate: date }),
};

function haptic() {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function")
      navigator.vibrate(10);
  } catch {
    // not supported — the receipt is the confirmation
  }
}

export function PhilHoursView(props: PhilHoursViewProps): ReactNode {
  const { entries, loadFailed, todayISO, jobs, jobsError, viewerId, canLogTafe } = props;
  const router = useRouter();
  const online = useOnline();
  const submissionKey = useSubmissionKey();

  // ── Confirmed saves overlay the server list until the store catches up ──
  const [savedEntries, setSavedEntries] = useState<ReadonlyArray<TimeEntry>>([]);
  useEffect(() => {
    const journalled = readSavedEntries(viewerId);
    if (journalled.length === 0) return;
    setSavedEntries((prev) => {
      const have = new Set(prev.map((e) => e.date));
      const add = journalled.filter((e) => !have.has(e.date));
      return add.length > 0 ? [...prev, ...add] : prev;
    });
  }, [viewerId]);
  function recordSaved(entry: TimeEntry) {
    recordSavedEntry(entry);
    setSavedEntries((prev) => [...prev.filter((e) => e.date !== entry.date), entry]);
  }
  const merged = useMemo(() => mergeSavedEntries(entries, savedEntries), [entries, savedEntries]);

  // ── Picking ─────────────────────────────────────────────────────────────
  const currentMonday = weekStartOf(todayISO);
  const [picked, setPicked] = useState<string | null>(() => {
    const todayOpen =
      !entries.some((e) => e.date === todayISO) && isLoggableDate(todayISO, todayISO);
    if ((props.launchLog || props.launchJobId) && todayOpen) return todayISO;
    return initialPick(entries, todayISO);
  });
  // A job picked for ONE day (chips / Find another job) — never carried over.
  const [jobPicks, setJobPicks] = useState<Record<string, string>>(() =>
    props.launchJobId && jobs.some((j) => j.id === props.launchJobId)
      ? { [todayISO]: props.launchJobId }
      : {}
  );
  const [foundJobs, setFoundJobs] = useState<Record<string, HoursJob>>({});

  // ── In-flight / unanswered days, and the panel's last result ────────────
  const [rowState, setRowState] = useState<Record<string, RowUiState | undefined>>({});
  const [unconfirmed, setUnconfirmed] = useState<Record<string, SaveAttempt | undefined>>({});
  const [result, setResult] = useState<Result>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(() => {
    const fix = props.launchFixDate;
    const target = fix ? entries.find((e) => e.date === fix) : undefined;
    return target && target.status === "rejected" ? { kind: "fix", date: fix! } : { kind: "none" };
  });
  const [findJobFor, setFindJobFor] = useState<string | null>(null);
  const [sheetProblem, setSheetProblem] = useState<{
    date: string;
    problem: HoursProblem;
    attempt: SaveAttempt;
  } | null>(null);
  const [view, setView] = useState<"week" | "earlier">("week");
  const [openEarlierWeek, setOpenEarlierWeek] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();

  // ── Derived ─────────────────────────────────────────────────────────────
  const allJobs = useMemo<HoursJob[]>(() => {
    const have = new Set(jobs.map((j) => j.id));
    return [...jobs, ...Object.values(foundJobs).filter((j) => !have.has(j.id))];
  }, [jobs, foundJobs]);
  const lastJob = useMemo(
    () =>
      lastLoggedJobFor(
        merged,
        jobs.map((j) => j.id)
      ),
    [merged, jobs]
  );
  const weekEntries = useMemo(() => entriesInWeek(merged, currentMonday), [merged, currentMonday]);
  const rows = useMemo(
    () => weekRows(currentMonday, merged, todayISO),
    [currentMonday, merged, todayISO]
  );
  const earlier = useMemo(() => buildEarlierWeeks(merged, todayISO), [merged, todayISO]);
  const entryFor = (date: string | null) =>
    date ? (merged.find((e) => e.date === date) ?? null) : null;

  // A picked day that gained an entry (saved here, or elsewhere) is no longer pickable.
  const pickedOpen = picked !== null && !entryFor(picked) && isLoggableDate(picked, todayISO);
  const pickedDate = pickedOpen ? picked : null;
  const pickedJobId = pickedDate
    ? defaultJobId({
        picked: jobPicks[pickedDate],
        lastJobId: lastJob?.jobId ?? null,
        jobs: foundJobs[pickedDate] ? [...jobs, foundJobs[pickedDate]!] : jobs,
      })
    : null;
  const pickedJob = pickedJobId ? (allJobs.find((j) => j.id === pickedJobId) ?? null) : null;

  // ── Sending ─────────────────────────────────────────────────────────────
  function attemptFor(
    mode: "create" | "patch",
    date: string,
    payload: SaveAttempt["payload"],
    action: SaveAttempt["action"]
  ): SaveAttempt {
    const key = submissionKey.keyFor(JSON.stringify(payload));
    return mode === "create"
      ? {
          mode,
          date,
          payload: payload as Extract<SaveAttempt, { mode: "create" }>["payload"],
          key,
          action,
        }
      : { mode, date, payload: payload as PatchTimeEntryPayload, key, action };
  }

  async function run(attempt: SaveAttempt, how: "send" | "retry") {
    const { date } = attempt;
    setRowState((s) => ({ ...s, [date]: "saving" }));
    setResult(null);
    setSheetProblem(null);
    const outcome = how === "send" ? await sendDay(wire, attempt) : await retryDay(wire, attempt);
    settle(outcome, attempt);
  }

  function settle(outcome: SaveOutcome, attempt: SaveAttempt) {
    const { date } = attempt;
    setRowState((s) => ({ ...s, [date]: undefined }));
    if (outcome.kind === "saved") {
      submissionKey.clear();
      setUnconfirmed((u) => ({ ...u, [date]: undefined }));
      recordSaved(outcome.entry);
      setJustSaved(date);
      haptic();
      setSheet({ kind: "none" });
      setFindJobFor(null);
      if (attempt.action === "log") {
        const next = nextPickAfterSave(date, merged, todayISO);
        setPicked(next);
        setResult(next ? null : { kind: "saved", entry: outcome.entry });
      } else {
        setResult({ kind: "saved", entry: outcome.entry });
      }
      router.refresh();
      return;
    }
    if (outcome.kind === "unconfirmed") {
      setUnconfirmed((u) => ({ ...u, [date]: attempt }));
      setRowState((s) => ({ ...s, [date]: "unconfirmed" }));
    }
    // The error sits in the slot that failed: the open sheet's footer, else the panel.
    if (sheet.kind !== "none") {
      setSheetProblem({ date, problem: outcome.problem, attempt });
    } else if (outcome.kind === "refused") {
      setResult({ kind: "refused", date, problem: outcome.problem, attempt });
    }
    if (outcome.kind === "unconfirmed" && !entryFor(date)) setPicked(date);
  }

  const retryLabelFor = (attempt: SaveAttempt) =>
    `Try again · ${weekdayName(attempt.date)} ${formatHoursLabel(attempt.payload.totalHours ?? 0)}`;

  function problemFor(date: string | null) {
    if (!date) return null;
    if (sheetProblem && sheetProblem.date === date) {
      const a = sheetProblem.attempt;
      const isUnconfirmed = unconfirmed[date] === a;
      return {
        problem: sheetProblem.problem,
        onRetry: () => void run(a, isUnconfirmed ? "retry" : "send"),
        retryLabel: isUnconfirmed ? retryLabelFor(a) : "Try again",
      };
    }
    return null;
  }

  // ── Log actions (the picked day) ────────────────────────────────────────
  function logStandard() {
    if (!pickedDate || !pickedJob) return;
    const payload = buildStandardDayPayload({ date: pickedDate, jobId: pickedJob.id, notes: null });
    void run(attemptFor("create", pickedDate, payload, "log"), "send");
  }
  function logHours(date: string, totalHours: number, note: string | null) {
    const job = pickedDate === date ? pickedJob : null;
    if (!job) return;
    const payload = buildCustomHoursPayload({ date, totalHours, jobId: job.id, notes: note });
    void run(attemptFor("create", date, payload, "log"), "send");
  }
  function logLeave(date: string, type: LeaveType, note: string | null) {
    const payload = buildStandardDayPayload({ date, jobId: null, notes: note, dayType: type });
    void run(attemptFor("create", date, payload, "log"), "send");
  }
  function logSplit(
    date: string,
    totalHours: number,
    allocations: Array<{ jobId: string; hours: number }>
  ) {
    const payload = buildSplitDayPayload({ date, totalHours, allocations, notes: null });
    void run(attemptFor("create", date, payload, "log"), "send");
  }
  function changeHours(entry: TimeEntry, totalHours: number, note: string | null) {
    const notes = note ?? entry.notes ?? null;
    const leave = entry.dayType as LeaveType | null | undefined;
    const jobId = primaryJobId(entry);
    const payload = leave
      ? buildDayTypeResubmitPayload(entry, { totalHours, dayType: leave, notes })
      : jobId
        ? buildResubmitPayload(entry, { totalHours, jobId, notes })
        : null;
    if (!payload) return;
    void run(attemptFor("patch", entry.date, payload, "change"), "send");
  }
  function changeSplit(
    entry: TimeEntry,
    totalHours: number,
    allocations: Array<{ jobId: string; hours: number }>
  ) {
    const payload = buildSplitResubmitPayload(entry, {
      totalHours,
      allocations,
      notes: entry.notes ?? null,
    });
    void run(attemptFor("patch", entry.date, payload, "change"), "send");
  }
  function saveNote(entry: TimeEntry, note: string) {
    const payload = { ...buildDraftSendPayload(entry), notes: note };
    void run(attemptFor("patch", entry.date, payload, "change"), "send");
  }
  function sendDraft(entry: TimeEntry) {
    void run(attemptFor("patch", entry.date, buildDraftSendPayload(entry), "change"), "send");
  }
  function sendFix(entry: TimeEntry, payload: PatchTimeEntryPayload) {
    void run(attemptFor("patch", entry.date, payload, "change"), "send");
  }

  function pickDay(date: string) {
    setPicked(date);
    setResult(null);
  }
  function openEntry(entry: TimeEntry) {
    setSheetProblem(null);
    setSheet(
      entry.status === "rejected"
        ? { kind: "fix", date: entry.date }
        : { kind: "detail", date: entry.date }
    );
  }
  function pickJobForDay(date: string, jobId: string) {
    setJobPicks((p) => ({ ...p, [date]: jobId }));
  }
  function foundJobForDay(date: string, job: HoursJob) {
    setFoundJobs((f) => ({ ...f, [date]: job }));
    setJobPicks((p) => ({ ...p, [date]: job.id }));
    setFindJobFor(null);
  }

  // ── Failed load: header + the block + nothing numeric ───────────────────
  if (loadFailed) {
    return (
      <div className="flex min-h-full flex-col" data-testid="hours-view-failed">
        <Header subline="This week" />
        <div className="mt-4 space-y-3">
          <div role="alert" className="rounded-[16px] border border-[#f4c9c9] bg-[#fee2e2] p-4">
            <div className="flex items-start gap-3">
              <AlertCircle
                aria-hidden="true"
                className="mt-0.5 h-5 w-5 shrink-0 text-state-danger"
              />
              <div className="space-y-1">
                <p className="font-display text-[16px] font-bold text-state-danger">
                  Couldn&rsquo;t load your hours
                </p>
                <p className="text-[14px] text-text">
                  Your phone couldn&rsquo;t reach BuhlOS — usually no signal or Wi-Fi.
                </p>
                <p className="text-[14px] text-text">
                  Try again when you&rsquo;ve got signal. Days you already sent are safe with the
                  office.
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => startRefresh(() => router.refresh())}
              data-testid="hours-load-retry"
              className="mt-3 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-card bg-accent-yellow font-display text-[15px] font-bold text-accent-ink disabled:opacity-70"
            >
              <RotateCw
                aria-hidden="true"
                className={cn("h-4 w-4", refreshing && "animate-spin")}
              />
              {refreshing ? "Trying…" : "Try again"}
            </button>
          </div>
          <p className="text-[14px] text-text-muted">
            Your week shows here once it loads. You can log hours as soon as it does.
          </p>
        </div>
      </div>
    );
  }

  // ── Panel state ─────────────────────────────────────────────────────────
  const leaveActions = {
    canLogTafe,
    onLeave: (type: LeaveType) => {
      if (!pickedDate) return;
      setSheetProblem(null);
      setSheet({ kind: "leave", date: pickedDate, preset: type });
    },
  };
  let panel: PanelState;
  const pickedRowState = pickedDate ? rowState[pickedDate] : picked ? rowState[picked] : undefined;
  if (picked && pickedRowState === "saving") {
    const job = jobPicks[picked] ? allJobs.find((j) => j.id === jobPicks[picked]) : pickedJob;
    panel = {
      kind: "saving",
      date: picked,
      jobLabel: job?.name ?? null,
      hoursLabel: formatHoursLabel(STANDARD_DAY_HOURS),
    };
  } else if (picked && pickedRowState === "unconfirmed" && unconfirmed[picked]) {
    const a = unconfirmed[picked]!;
    panel = {
      kind: "unconfirmed",
      date: picked,
      problem: {
        problem: lastProblemFor(a),
        onRetry: () => void run(a, "retry"),
        retryLabel: retryLabelFor(a),
      },
    };
  } else if (result?.kind === "saved" && !pickedDate) {
    panel = { kind: "saved", entry: result.entry, jobs: allJobs };
  } else if (!pickedDate) {
    const anyPickable = rows.some((r) => r.kind === "pickable");
    panel = anyPickable
      ? {
          kind: "nothing",
          line: "Nothing waiting to be logged",
          sub: "Tap a day to log it — tomorrow can be logged too.",
        }
      : {
          kind: "nothing",
          line: "Every day up to today is logged",
          sub: "To log another day, tap it, or open Earlier weeks.",
        };
  } else if (jobsError && !foundJobs[pickedDate]) {
    panel = { kind: "jobsFailed", onRetry: () => startRefresh(() => router.refresh()) };
  } else if (jobs.length === 0 && !foundJobs[pickedDate]) {
    panel = { kind: "noJobs", date: pickedDate, ...leaveActions };
  } else if (!pickedJob) {
    panel = {
      kind: "noDefault",
      date: pickedDate,
      jobs,
      onPickJob: (id) => pickJobForDay(pickedDate, id),
      onFind: () => setFindJobFor(pickedDate),
      ...leaveActions,
    };
  } else {
    const weekend = isWeekendDate(pickedDate);
    const refused = result?.kind === "refused" && result.date === pickedDate ? result : null;
    panel = {
      kind: "ready",
      date: pickedDate,
      weekend,
      backdated: weekStartOf(pickedDate) !== currentMonday,
      jobs,
      pickedJob,
      lastJobId: lastJob?.jobId ?? null,
      foundJob: foundJobs[pickedDate] ?? null,
      onPickJob: (id) => pickJobForDay(pickedDate, id),
      onFind: () => setFindJobFor(pickedDate),
      onLog: logStandard,
      onOt: () => {
        setSheetProblem(null);
        setSheet({ kind: "ot", date: pickedDate, variant: weekend ? "weekend" : "weekday" });
      },
      onSplit:
        jobs.length > 1 && !weekend ? () => setSheet({ kind: "split", date: pickedDate }) : null,
      problem: refused
        ? {
            problem: refused.problem,
            onRetry: refused.problem.canRetry ? () => void run(refused.attempt, "send") : null,
          }
        : null,
      ...leaveActions,
    };
  }

  const fixLine = fixNeededLine(weekEntries);
  const summary = weekSummaryLine(weekEntries);
  const rowProps = {
    pickedDate,
    rowState,
    justSavedDate: justSaved,
    jobs: allJobs,
    onPickDay: pickDay,
    onOpenEntry: openEntry,
    onTapUnconfirmed: (date: string) => {
      setPicked(date);
      setResult(null);
    },
  };

  // ── Sheets (the entry is looked up live so a save re-renders them) ─────
  const sheetEntry =
    sheet.kind === "detail" || sheet.kind === "change" || sheet.kind === "fix"
      ? entryFor(sheet.date)
      : null;
  const busyFor = (date: string) => rowState[date] === "saving";
  const closeSheet = () => {
    setSheet({ kind: "none" });
    setSheetProblem(null);
  };

  return (
    <div className="flex min-h-full flex-col" data-testid="hours-view">
      <Header
        subline={view === "week" ? `This week · ${weekRangeLabel(currentMonday)}` : "Earlier weeks"}
      />
      {!online ? (
        <p
          className="-mx-4 flex items-center gap-2 bg-surface-subtle px-4 py-2 text-[13px] font-medium text-text-muted"
          role="status"
          data-testid="hours-no-signal"
        >
          <WifiOff aria-hidden="true" className="h-4 w-4" />
          No signal — showing what&rsquo;s on this phone
        </p>
      ) : null}

      <div className="flex-1 space-y-3 pb-4 pt-4">
        {view === "week" ? (
          <>
            {fixLine ? (
              <p
                className="flex items-center gap-2 rounded-card bg-[#fee2e2] px-3 py-2 font-display text-[14px] font-bold text-state-danger"
                role="alert"
                data-testid="hours-fix-line"
              >
                <AlertCircle aria-hidden="true" className="h-4 w-4" />
                {fixLine}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3 px-1">
              <p
                className="font-display text-[15px] font-bold tabular-nums text-text"
                data-testid="hours-summary"
              >
                {summary}
              </p>
              <button
                type="button"
                onClick={() => setView("earlier")}
                data-testid="hours-earlier-link"
                className="inline-flex min-h-[44px] shrink-0 items-center gap-0.5 font-display text-[14px] font-semibold text-brand-navy"
              >
                Earlier weeks
                <ChevronRight aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
            <HoursWeekCard rows={rows} {...rowProps} />
          </>
        ) : (
          <EarlierWeeks
            weeks={earlier.weeks}
            hidden={earlier.hidden}
            openWeek={openEarlierWeek}
            onToggleWeek={(w) => setOpenEarlierWeek((o) => (o === w ? null : w))}
            onBack={() => setView("week")}
            todayISO={todayISO}
            rowProps={rowProps}
          />
        )}
      </div>

      <HoursBottomPanel state={panel} offline={!online} />

      {sheet.kind === "ot" ? (
        <OtSheet
          key={`ot-${sheet.date}-${sheet.variant}`}
          open
          onClose={closeSheet}
          variant={sheet.variant}
          date={sheet.date}
          target={pickedJob?.name ?? "this job"}
          busy={busyFor(sheet.date)}
          problem={problemFor(sheet.date)}
          onSubmit={(total, note) => logHours(sheet.date, total, note)}
        />
      ) : null}

      {sheet.kind === "leave" ? (
        <LeaveSheet
          key={`leave-${sheet.date}`}
          open
          onClose={closeSheet}
          date={sheet.date}
          preset={sheet.preset}
          canLogTafe={canLogTafe}
          busy={busyFor(sheet.date)}
          problem={problemFor(sheet.date)}
          onSubmit={(type, note) => logLeave(sheet.date, type, note)}
        />
      ) : null}

      {sheet.kind === "split" ? (
        <SplitSheet
          key={`split-${sheet.date}`}
          open
          onClose={closeSheet}
          date={sheet.date}
          jobs={jobs}
          defaultJobId={pickedJob?.id ?? null}
          busy={busyFor(sheet.date)}
          problem={problemFor(sheet.date)}
          onSubmit={(total, allocations) => logSplit(sheet.date, total, allocations)}
        />
      ) : null}

      {sheet.kind === "detail" && sheetEntry ? (
        <DayDetailSheet
          key={`detail-${sheetEntry.id}-${sheetEntry.updatedAt}`}
          open
          onClose={closeSheet}
          entry={sheetEntry}
          jobs={allJobs}
          jobsError={jobsError}
          busy={busyFor(sheetEntry.date)}
          problem={problemFor(sheetEntry.date)}
          onChangeHours={() => setSheet({ kind: "change", date: sheetEntry.date })}
          onSaveNote={(note) => saveNote(sheetEntry, note)}
          onSendDraft={() => sendDraft(sheetEntry)}
        />
      ) : null}

      {sheet.kind === "change" && sheetEntry ? (
        (sheetEntry.allocations ?? []).length > 1 ? (
          <SplitSheet
            key={`change-split-${sheetEntry.id}`}
            open
            onClose={closeSheet}
            date={sheetEntry.date}
            jobs={jobs}
            defaultJobId={primaryJobId(sheetEntry)}
            initialTotal={sheetEntry.totalHours}
            initialRows={(sheetEntry.allocations ?? []).map((a) => ({
              jobId: a.jobId && jobs.some((j) => j.id === a.jobId) ? a.jobId : null,
              hours: a.hours,
            }))}
            busy={busyFor(sheetEntry.date)}
            problem={problemFor(sheetEntry.date)}
            onSubmit={(total, allocations) => changeSplit(sheetEntry, total, allocations)}
          />
        ) : (
          <OtSheet
            key={`change-${sheetEntry.id}`}
            open
            onClose={closeSheet}
            variant={
              sheetEntry.dayType ? "leave" : isWeekendDate(sheetEntry.date) ? "weekend" : "change"
            }
            date={sheetEntry.date}
            target={entryTarget(sheetEntry, allJobs)}
            sentHours={sheetEntry.totalHours}
            busy={busyFor(sheetEntry.date)}
            problem={problemFor(sheetEntry.date)}
            onSubmit={(total, note) => changeHours(sheetEntry, total, note)}
          />
        )
      ) : null}

      {sheet.kind === "fix" && sheetEntry && sheetEntry.status === "rejected" ? (
        <FixSheet
          key={`fix-${sheetEntry.id}-${foundJobs[sheetEntry.date]?.id ?? ""}`}
          open
          onClose={closeSheet}
          entry={sheetEntry}
          jobs={jobs}
          canLogTafe={canLogTafe}
          busy={busyFor(sheetEntry.date)}
          problem={problemFor(sheetEntry.date)}
          onFindJob={() => setFindJobFor(sheetEntry.date)}
          foundJob={foundJobs[sheetEntry.date] ?? null}
          onSend={(payload) => sendFix(sheetEntry, payload)}
        />
      ) : null}

      {findJobFor ? (
        <FindJobSheet
          key={`find-${findJobFor}`}
          open
          onClose={() => setFindJobFor(null)}
          date={findJobFor}
          jobs={jobs}
          currentJobId={
            jobPicks[findJobFor] ?? lastJob?.jobId ?? (jobs.length === 1 ? jobs[0]!.id : null)
          }
          entries={merged}
          onPick={(job) => foundJobForDay(findJobFor, job)}
          nested={sheet.kind === "fix"}
        />
      ) : null}
    </div>
  );

  /** The last problem recorded for an unanswered attempt, re-derived as a timeout. */
  function lastProblemFor(attempt: SaveAttempt): HoursProblem {
    if (sheetProblem && sheetProblem.attempt === attempt) return sheetProblem.problem;
    return {
      caption: attempt.action === "log" ? "Hours not saved" : "Change not sent",
      title: "No answer — it may not have gone through",
      why: "Your phone didn't hear back in time, usually because of weak signal.",
      todo: "Check the day. If it hasn't changed, try again when you've got signal.",
      canRetry: true,
    };
  }
}

function Header({ subline }: { subline: string }): ReactNode {
  return (
    <header
      className="-mx-4 -mt-4 bg-brand-navy px-4 pb-4 pt-3 text-white"
      data-testid="hours-header"
    >
      <h1 className="font-display text-[24px] font-extrabold leading-tight tracking-[-0.02em]">
        Hours
      </h1>
      <p className="mt-0.5 text-[14px] font-medium tabular-nums text-white/75">{subline}</p>
    </header>
  );
}
