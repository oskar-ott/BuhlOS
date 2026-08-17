"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  ClipboardCheck,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useDialogFocus } from "@/components/ui/useDialogFocus";
import { WeekShapeStrip } from "@/components/admin/WeekShapeStrip";
import { timesheetsClient } from "@/domains/timesheets/client";
import { formatHoursLabel } from "@/domains/timesheets/format";
import { addDays } from "@/domains/timesheets/service";
import { workerStrip } from "@/domains/timesheets/pay-run";
import {
  submittedWeekSelection,
  weeklyDayStatusLabel,
  type WeeklyDayStatus,
  type WeeklyHoursCloseout,
  type WeeklyHoursDay,
  type WeeklyWorkerHours,
} from "@/domains/timesheets/weekly-closeout";
import {
  approvedOrdOtSplit,
  buildQueryReason,
  MOBILE_QUERY_REASONS,
  mobileSummary,
  partitionMobileWorkers,
  submittedHoursOf,
  workerLongDayCount,
  workerOrdOtSplit,
  amendDayAllocations,
  canAmendDay,
  outstandingWeek,
  type MobileQueryReason,
  type OutstandingWeek,
} from "@/domains/timesheets/weekly-review";
import {
  WeeklyCloseoutXeroFinale,
  type XeroFinaleGate,
} from "@/components/admin/WeeklyCloseoutXeroFinale";
import { WeeklyCloseoutSendFinale } from "@/components/admin/WeeklyCloseoutSendFinale";
import { AmendHoursEditor, type AmendPayload } from "@/components/admin/AmendHoursEditor";
import type { ReviewCandidate } from "@/domains/timesheets/xero-closeout";

/**
 * WeeklyHoursApprovalMobile — the phone surface for /hours/weekly.
 *
 * The office clears the crew's week from a phone before the payroll run, ONE
 * person at a time: a navy summary readout, a guided "Review each" stepper, a
 * card per worker with the week strip + inline Approve / Query, and an honest
 * "waiting on the worker" list. It renders below `lg`; the existing dense
 * desktop board (WeeklyHoursCloseoutBoard) takes over at `lg` and up.
 *
 * It fires the SAME endpoints the desktop board uses (timesheetsClient) — no
 * second status-transition path, no new API:
 *   - Approve week  → POST /api/time-entries-bulk-approve (the worker's
 *     submitted days).
 *   - Query (send back) → POST /api/time-entries-reject per submitted day, with
 *     the chosen reason (the worker gets a push + a one-tap fix link). There is
 *     no separate two-way "ask" backend, so "Query" IS the reject flow — never a
 *     faked query thread (P7).
 *   - Undo → POST /api/time-entries-reopen back to submitted (admin tier only).
 *
 * SPEED: actions apply optimistically to a local overlay and toast immediately;
 * a debounced router.refresh() reconciles the list against persisted state so
 * the boss never waits on a round-trip mid-review. HONESTY (P7): the overlay is
 * only set on a FULL success — a partial or failed write is surfaced (toast) and
 * the worker stays actionable, never shown as done when it isn't.
 */

interface WeekNav {
  /** `?week=` value for the previous / next / current week. */
  prevWeek: string;
  nextWeek: string;
  currentWeek: string;
  isCurrentWeek: boolean;
}

interface WeeklyHoursApprovalMobileProps {
  closeout: WeeklyHoursCloseout;
  weekNav: WeekNav;
  /** True when the viewer can undo (reopen is admin tier). */
  canUndo: boolean;
  /**
   * True when the viewer may FIX a day's hours and approve it in one action
   * (admin tier — owner-directed). A leading hand keeps approve / query only;
   * the server enforces the same rule, so this just avoids showing a button
   * that would 403.
   */
  canAmend?: boolean;
  fetchError: string | null;
  /**
   * Server-resolved role + Xero flags. When this allows it, finishing the
   * review ends at the Xero finale instead of the plain "Week reviewed" card;
   * the finale itself decides what's honest once it has read the connection.
   */
  xeroGate?: XeroFinaleGate;
  className?: string;
}

/** Local, optimistic resolution of a worker's week this session. */
interface OverlayEntry {
  status: "approved" | "queried";
  /** {userId,date} refs to reopen for an undo (empty when the viewer can't undo,
   *  or once the 30s undo window has closed). */
  undo: Array<{ userId: string; date: string }>;
}
type Overlay = Record<string, OverlayEntry>;

/** "done" opens the sheet STRAIGHT at the finale — the re-entry path once
 *  every timesheet is reviewed (2026-08-17: with nothing left to approve the
 *  green card was a dead end, stranding the boss one screen short of Send). */
type SheetMode = "review" | "query" | "done";

interface Toast {
  id: number;
  msg: string;
  tone: "ok" | "warn";
}

const firstName = (name: string) => name.split(/\s+/)[0] || name;

const HOURS_WEEKLY: Route = "/hours/weekly" as Route;
const UNDO_WINDOW_MS = 30_000;

export function WeeklyHoursApprovalMobile({
  closeout,
  weekNav,
  canUndo,
  canAmend = false,
  fetchError,
  xeroGate,
  className,
}: WeeklyHoursApprovalMobileProps) {
  const router = useRouter();
  const summary = useMemo(() => mobileSummary(closeout), [closeout]);
  const bands = useMemo(() => partitionMobileWorkers(closeout), [closeout]);
  const workerById = useMemo(() => {
    const m = new Map<string, WeeklyWorkerHours>();
    for (const w of closeout.workers) m.set(w.workerId, w);
    return m;
  }, [closeout]);

  // Server-known: role + both Xero flags. NOT a promise that the push will
  // work — the finale still has to read the connection — but enough to stop
  // the page claiming export is desktop-only when it isn't.
  const xeroPushable = Boolean(
    xeroGate?.isAdmin && xeroGate.connectionFlag && xeroGate.exportFlag,
  );

  // Owner pull 2026-08-15: TIMESHEETS_EMAIL_TO set → the closeout ends by
  // emailing the week's PDF to Tia at accounts. Outranks the Xero copy and
  // finale while the interim process is on.
  const accountsMode = Boolean(xeroGate?.isAdmin && xeroGate.accountsConfigured);

  // What the Xero finale would send: everyone with approved hours this week.
  // Derived from the closeout already in memory — the finale never refetches
  // hours, so the numbers on the last screen are the ones the boss just saw.
  const xeroCandidates = useMemo<ReviewCandidate[]>(
    () =>
      closeout.workers
        .filter((w) => w.approvedHours > 0)
        .map((w) => {
          const split = approvedOrdOtSplit(w);
          return {
            workerId: w.workerId,
            workerName: w.workerName,
            approvedHours: w.approvedHours,
            overtimeHours: split.overtime,
            hasOvertime: split.hasOvertime,
          };
        }),
    [closeout],
  );

  const [overlay, setOverlay] = useState<Overlay>({});

  // The send finale's wait-or-send question (owner pull 2026-08-16): what is
  // still to come in across the WHOLE week, session decisions included — so a
  // boss who just rejected days is told the sheet would miss them.
  const outstanding = useMemo<OutstandingWeek>(
    () => outstandingWeek(closeout.workers, overlay),
    [closeout.workers, overlay],
  );

  // Per-worker in-flight guard. A ref is the source of truth (synchronous, so a
  // rapid stepper can't double-fire the SAME worker), mirrored to state so the
  // buttons can disable. A GLOBAL flag would wrongly block approving worker B
  // while A is still in flight — the exact "dropped approvals" bug in the
  // stepper — so this is per-worker.
  const busyRef = useRef<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const setBusy = useCallback((id: string, on: boolean) => {
    if (on) busyRef.current.add(id);
    else busyRef.current.delete(id);
    setBusyIds([...busyRef.current]);
  }, []);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sheet, setSheet] = useState<{
    ids: string[];
    startId: string;
    single: boolean;
    startMode: SheetMode;
  } | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeq = useRef(0);

  const toast = useCallback((msg: string, tone: "ok" | "warn" = "ok") => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  // Debounced reconcile — one refresh after a burst of actions, so the boss
  // never waits on a round-trip between people. Overlay survives the soft
  // refresh (the component stays mounted), so the 30s undo window is unbroken.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), 700);
  }, [router]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  // Close the undo window for ONE worker after 30s — reference-guarded on the
  // exact undo array so a later re-action (or an undo) is never clobbered.
  const scheduleUndoExpiry = useCallback(
    (workerId: string, undoRef: OverlayEntry["undo"]) => {
      if (undoRef.length === 0) return;
      setTimeout(() => {
        setOverlay((o) => {
          const cur = o[workerId];
          if (cur && cur.undo === undoRef) return { ...o, [workerId]: { ...cur, undo: [] } };
          return o;
        });
      }, UNDO_WINDOW_MS);
    },
    [],
  );

  const approveWorker = useCallback(
    async (worker: WeeklyWorkerHours) => {
      const entries = submittedWeekSelection(worker);
      if (entries.length === 0 || busyRef.current.has(worker.workerId)) return;
      setBusy(worker.workerId, true);
      const res = await timesheetsClient.bulkApproveEntries({ entries });
      setBusy(worker.workerId, false);
      if (!res.ok) {
        toast(
          res.error.status === 403
            ? "You can't approve these — office login needed"
            : "Couldn't approve — try again",
          "warn",
        );
        return;
      }
      const { approvedCount, failed } = res.data;
      // HONESTY (P7): only claim "approved" on a FULL success. A partial or empty
      // result stays actionable and says exactly what happened.
      if (approvedCount === 0) {
        toast(`Couldn't approve ${firstName(worker.workerName)} — try again`, "warn");
        scheduleRefresh();
        return;
      }
      if (failed.length > 0) {
        toast(
          `Approved ${approvedCount} of ${approvedCount + failed.length} days · ${firstName(worker.workerName)} — ${failed.length} need a look`,
          "warn",
        );
        scheduleRefresh();
        return;
      }
      const undo = canUndo ? res.data.approved.map((a) => ({ userId: a.userId, date: a.date })) : [];
      setOverlay((o) => ({ ...o, [worker.workerId]: { status: "approved", undo } }));
      toast(`Approved ${formatHoursLabel(submittedHoursOf(worker))} · ${firstName(worker.workerName)}`);
      scheduleUndoExpiry(worker.workerId, undo);
      scheduleRefresh();
    },
    [canUndo, toast, scheduleRefresh, scheduleUndoExpiry, setBusy],
  );

  const queryWorker = useCallback(
    async (worker: WeeklyWorkerHours, reason: MobileQueryReason, note: string) => {
      const days = submittedWeekSelection(worker);
      const reasonText = buildQueryReason(reason, note);
      if (days.length === 0 || !reasonText || busyRef.current.has(worker.workerId)) return;
      setBusy(worker.workerId, true);
      let failed = 0;
      for (const d of days) {
        const r = await timesheetsClient.rejectEntry({
          userId: d.userId,
          date: d.date,
          reason: reasonText,
        });
        if (!r.ok) failed += 1;
      }
      setBusy(worker.workerId, false);
      const succeeded = days.length - failed;
      if (succeeded === 0) {
        toast(`Couldn't send it back — try again`, "warn");
        scheduleRefresh();
        return;
      }
      if (failed > 0) {
        toast(
          `Sent ${succeeded} of ${days.length} days back · ${firstName(worker.workerName)} — ${failed} didn't send`,
          "warn",
        );
        scheduleRefresh();
        return;
      }
      const undo = canUndo ? days.map((d) => ({ userId: d.userId, date: d.date })) : [];
      setOverlay((o) => ({ ...o, [worker.workerId]: { status: "queried", undo } }));
      toast(`Sent back to ${firstName(worker.workerName)} · ${reason}`);
      scheduleUndoExpiry(worker.workerId, undo);
      scheduleRefresh();
    },
    [canUndo, toast, scheduleRefresh, scheduleUndoExpiry, setBusy],
  );

  /**
   * "Fix the hours and approve" for ONE day inside the review sheet.
   *
   * Deliberately NOT optimistic and NOT a week-level resolution: a corrected
   * day is approved, the worker's other days are not, so the overlay (which
   * means "this whole week is settled") stays untouched and the refresh below
   * re-renders the week with that one day approved. Honest either way (P7).
   */
  const amendDay = useCallback(
    async (
      worker: WeeklyWorkerHours,
      day: WeeklyHoursDay,
      payload: AmendPayload,
    ): Promise<boolean> => {
      if (busyRef.current.has(worker.workerId)) return false;
      setBusy(worker.workerId, true);
      const res = await timesheetsClient.amendAndApproveEntry({
        userId: worker.workerId,
        date: day.date,
        reason: payload.reason,
        totalHours: payload.totalHours,
        allocations: payload.allocations,
      });
      setBusy(worker.workerId, false);
      if (!res.ok) {
        toast(
          res.error.status === 403
            ? "Only the office can change someone's hours"
            : res.error.status === 409
              ? "That day moved while you were fixing it — refresh"
              : "Couldn't save the fix — try again",
          "warn",
        );
        scheduleRefresh();
        return false;
      }
      toast(
        `Fixed ${day.weekday} · ${formatHoursLabel(day.hours ?? 0)} → ${formatHoursLabel(res.data.entry.totalHours)}`,
      );
      scheduleRefresh();
      return true;
    },
    [toast, scheduleRefresh, setBusy],
  );

  const undoWorker = useCallback(
    async (worker: WeeklyWorkerHours) => {
      const entry = overlay[worker.workerId];
      if (!entry || entry.undo.length === 0 || busyRef.current.has(worker.workerId)) return;
      setBusy(worker.workerId, true);
      let failed = 0;
      for (const ref of entry.undo) {
        const r = await timesheetsClient.reopenEntry({
          userId: ref.userId,
          date: ref.date,
          toStatus: "submitted",
        });
        if (!r.ok) failed += 1;
      }
      setBusy(worker.workerId, false);
      if (failed === entry.undo.length) {
        toast("Couldn't undo — try again", "warn");
        return;
      }
      setOverlay((o) => {
        const next = { ...o };
        delete next[worker.workerId];
        return next;
      });
      toast(`Undone · ${firstName(worker.workerName)} back to submitted`);
      scheduleRefresh();
    },
    [overlay, toast, scheduleRefresh, setBusy],
  );

  // The stepper queue = to-approve workers not yet resolved this session.
  const pending = bands.toApprove.filter((w) => !overlay[w.workerId]);
  const openReview = (ids: string[], startId: string, single: boolean, startMode: SheetMode = "review") => {
    if (ids.length === 0) return;
    setSheet({ ids, startId, single, startMode });
  };
  const closeSheet = () => {
    setSheet(null);
    // Final reconcile once the review is done.
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    router.refresh();
  };

  const actions: CardActions = { overlay, busyIds, canUndo, approveWorker, undoWorker };

  return (
    <section
      data-testid="weekly-approval-mobile"
      aria-label="Weekly hours approval"
      className={cn("space-y-4", className)}
    >
      <Header weekNav={weekNav} rangeLabel={summary.rangeLabel} />

      {fetchError ? (
        <div
          role="alert"
          className="rounded-card border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p className="font-medium">Couldn&rsquo;t load the week</p>
          <p className="mt-1">{fetchError}. Refresh before approving.</p>
          <div className="mt-3">
            <RefreshButton />
          </div>
        </div>
      ) : null}

      <SummaryReadout summary={summary} />

      <ReviewCTA
        pendingCount={pending.length}
        allReady={summary.allReady}
        crewCount={summary.crewCount}
        onStart={() => openReview(pending.map((w) => w.workerId), pending[0]!.workerId, false)}
        onOpenFinale={
          xeroCandidates.length > 0 && (accountsMode || xeroPushable)
            ? () =>
                openReview(
                  xeroCandidates.map((c) => c.workerId),
                  xeroCandidates[0]!.workerId,
                  false,
                  "done",
                )
            : undefined
        }
      />

      {/* To approve — the actionable weeks. */}
      {bands.toApprove.length > 0 ? (
        <div className="space-y-2">
          <SectionLabel
            meta={`${bands.toApprove.filter((w) => overlay[w.workerId]?.status === "approved").length} of ${bands.toApprove.length} approved`}
          >
            To approve
          </SectionLabel>
          <div className="overflow-hidden rounded-card border border-border bg-surface">
            {bands.toApprove.map((w) => (
              <WorkerCard
                key={w.workerId}
                worker={w}
                actions={actions}
                onOpen={(mode) => openReview([w.workerId], w.workerId, true, mode)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Approved — settled weeks, collapsed to a calm confirmation. */}
      {bands.approved.length > 0 ? (
        <div className="space-y-2">
          <SectionLabel meta={`${bands.approved.length} ready`}>Approved</SectionLabel>
          <div className="overflow-hidden rounded-card border border-border bg-surface">
            {bands.approved.map((w) => (
              <SettledRow
                key={w.workerId}
                worker={w}
                undoable={canUndo && (overlay[w.workerId]?.undo.length ?? 0) > 0}
                busy={busyIds.includes(w.workerId)}
                onUndo={() => undoWorker(w)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Waiting on the worker — honest context, no fake nudge. A week sent back
          THIS session still offers a brief undo (reopen), matching approve. */}
      {bands.waiting.length > 0 ? (
        <div className="space-y-2">
          <SectionLabel meta={`${bands.waiting.length} waiting`}>Not ready yet</SectionLabel>
          <div className="space-y-2">
            {bands.waiting.map((w) => (
              <WaitingCard
                key={w.workerId}
                worker={w}
                undoable={canUndo && overlay[w.workerId]?.status === "queried" && (overlay[w.workerId]?.undo.length ?? 0) > 0}
                busy={busyIds.includes(w.workerId)}
                onUndo={() => undoWorker(w)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {bands.toApprove.length === 0 && bands.approved.length === 0 && bands.waiting.length === 0 ? (
        <div className="rounded-card border border-dashed border-border bg-surface-subtle p-8 text-center">
          <p className="font-display text-base text-text">No hours this week</p>
          <p className="mt-1 text-sm text-text-muted">
            Nobody logged hours and no missing days were flagged. Nothing to close out.
          </p>
        </div>
      ) : null}

      <p className="px-1 text-xs text-text-muted">
        {accountsMode ? (
          <>
            Approve here on the move, then{" "}
            <b className="font-semibold text-text">email the week&rsquo;s timesheets to Tia</b> —
            the pay run goes to accounts as a PDF while Xero is out of action.
          </>
        ) : xeroPushable ? (
          <>
            Approve here on the move, then{" "}
            <b className="font-semibold text-text">send the week to Xero as draft timesheets</b> —
            you review and post the pay run in Xero.
          </>
        ) : (
          <>
            Approve here on the move.{" "}
            <b className="font-semibold text-text">
              Payroll export and the full audit trail run in BuhlOS on desktop
            </b>{" "}
            — approved hours flow straight to the run.
          </>
        )}
      </p>

      {/* One-at-a-time review sheet. */}
      {sheet ? (
        <ReviewSheet
          ids={sheet.ids}
          startId={sheet.startId}
          single={sheet.single}
          startMode={sheet.startMode}
          workerById={workerById}
          overlay={overlay}
          canUndo={canUndo}
          busyIds={busyIds}
          onApprove={approveWorker}
          onQuery={queryWorker}
          onUndo={undoWorker}
          onAmendDay={amendDay}
          canAmend={canAmend}
          onClose={closeSheet}
          weekStart={closeout.weekStart}
          weekEnd={closeout.weekEnd}
          periodLabel={summary.rangeLabel}
          xeroGate={xeroGate}
          xeroCandidates={xeroCandidates}
          outstanding={outstanding}
        />
      ) : null}

      {/* Toasts. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-center gap-2 rounded-pill px-4 py-2 text-sm font-medium shadow-raised",
              t.tone === "ok"
                ? "bg-brand-navy text-text-inverse"
                : "bg-state-danger text-text-inverse",
            )}
          >
            {t.tone === "ok" ? (
              <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
            ) : (
              <TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0" />
            )}
            {t.msg}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Header + week nav ───────────────────────────────────────────────── */

function Header({ weekNav, rangeLabel }: { weekNav: WeekNav; rangeLabel: string }) {
  // Orientation: the bare URL deliberately opens the LAST complete week, so
  // name the viewed week's relation to today rather than leaving the range
  // to be parsed. Viewed Monday = prevWeek + 7 (the nav maths inverted).
  const viewedStart = addDays(weekNav.prevWeek, 7);
  const relation = weekNav.isCurrentWeek
    ? null // the "This week" pill below already says it
    : viewedStart === addDays(weekNav.currentWeek, -7)
      ? "Last week"
      : viewedStart > weekNav.currentWeek
        ? "Upcoming"
        : null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">Pay run</p>
          <h1 className="font-display text-2xl font-bold tracking-tight text-text">Weekly hours</h1>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <WeekArrow week={weekNav.prevWeek} label="Previous week" icon={<ArrowLeft aria-hidden="true" className="h-4 w-4" />} />
          <WeekArrow week={weekNav.nextWeek} label="Next week" icon={<ArrowRight aria-hidden="true" className="h-4 w-4" />} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-text-muted">{rangeLabel}</span>
        {relation ? <Pill tone="neutral">{relation}</Pill> : null}
        {!weekNav.isCurrentWeek ? (
          <Link
            href={{ pathname: HOURS_WEEKLY, query: { week: weekNav.currentWeek } }}
            className="rounded-pill border border-border px-2.5 py-0.5 text-xs font-medium text-text-muted hover:border-brand-navy hover:text-text"
          >
            This week
          </Link>
        ) : (
          <Pill tone="neutral">This week</Pill>
        )}
      </div>
    </div>
  );
}

function WeekArrow({ week, label, icon }: { week: string; label: string; icon: ReactNode }) {
  return (
    <Link
      href={{ pathname: HOURS_WEEKLY, query: { week } }}
      aria-label={label}
      title={label}
      className="flex h-10 w-10 items-center justify-center rounded-card border border-border text-text-muted hover:border-brand-navy hover:text-text"
    >
      {icon}
    </Link>
  );
}

/* ── Summary readout (navy) ──────────────────────────────────────────── */

function SummaryReadout({ summary }: { summary: ReturnType<typeof mobileSummary> }) {
  const { readyCount, crewCount, loggedHoursShort, overtimeShort, hasOvertime } = summary;
  return (
    <div className="overflow-hidden rounded-card bg-brand-navy shadow-card">
      <div className="flex items-stretch">
        <Segment value={`${readyCount}`} unit={`/ ${crewCount}`} label="Approved" />
        <Segment value={loggedHoursShort} unit="h" label="Logged" divider />
        <Segment
          value={overtimeShort}
          unit="h"
          label="Overtime"
          divider
          accent={hasOvertime}
        />
      </div>
      <div className="px-4 pb-4">
        <div
          className="h-1.5 w-full overflow-hidden rounded-pill bg-white/15"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={summary.progressPct}
          aria-label="Weeks approved"
        >
          <div
            aria-hidden="true"
            className={cn("h-full rounded-pill bg-accent-yellow transition-[width] motion-reduce:transition-none", progressFillClass(summary.progressPct))}
          />
        </div>
        <div className="mt-2 flex items-center justify-between font-mono text-[10px] tracking-wide text-white/70">
          <span>
            <b className="font-semibold text-text-inverse">{readyCount}</b> of {crewCount} approved
          </span>
          <span>
            {summary.toApproveCount > 0
              ? `${summary.toApproveCount} to review`
              : summary.needLookCount > 0
                ? `${summary.needLookCount} need a look`
                : "all clear"}
          </span>
        </div>
      </div>
    </div>
  );
}

function Segment({
  value,
  unit,
  label,
  divider,
  accent,
}: {
  value: string;
  unit: string;
  label: string;
  divider?: boolean;
  accent?: boolean;
}) {
  return (
    <div className={cn("flex flex-1 flex-col gap-0.5 px-4 py-3.5", divider && "border-l border-white/15")}>
      <span className="font-display text-xl font-bold leading-none tracking-tight tabular-nums">
        <span className={accent ? "text-accent-yellow" : "text-text-inverse"}>{value}</span>
        <span className="ml-0.5 text-xs font-semibold text-white/60">{unit}</span>
      </span>
      <span className="font-mono text-[9px] uppercase tracking-widest text-white/70">
        {label}
      </span>
    </div>
  );
}

/* ── Review CTA (guided one-by-one) ──────────────────────────────────── */

function ReviewCTA({
  pendingCount,
  allReady,
  crewCount,
  onStart,
  onOpenFinale,
}: {
  pendingCount: number;
  allReady: boolean;
  crewCount: number;
  onStart: () => void;
  /** Set when there are approved hours AND somewhere to send them (accounts
   *  email or a live Xero push) — the reviewed card then opens the finale
   *  instead of dead-ending (2026-08-17: the boss was stranded one screen
   *  short of Send once everything was approved). */
  onOpenFinale?: () => void;
}) {
  if (pendingCount === 0) {
    const head = allReady && crewCount > 0 ? "Week reviewed" : "Nothing to review";
    if (onOpenFinale) {
      return (
        <button
          type="button"
          data-testid="wha-open-finale"
          onClick={onOpenFinale}
          className="flex w-full items-center gap-3 rounded-card border border-emerald-200 bg-emerald-50 px-4 py-3.5 text-left active:translate-y-px"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-state-success text-text-inverse">
            <Check aria-hidden="true" className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-[15px] font-bold text-emerald-900">{head}</span>
            <span className="block text-xs text-emerald-800">
              Everything submitted is cleared. Open the send screen when you&rsquo;re ready.
            </span>
          </span>
          <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-emerald-900" />
        </button>
      );
    }
    return (
      <div className="flex items-center gap-3 rounded-card border border-emerald-200 bg-emerald-50 px-4 py-3.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-state-success text-text-inverse">
          <Check aria-hidden="true" className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="font-display text-[15px] font-bold text-emerald-900">{head}</p>
          <p className="text-xs text-emerald-800">
            Every submitted week is cleared for the payroll run.
          </p>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="wha-review-each"
      onClick={onStart}
      className="flex w-full items-center gap-3 rounded-card bg-accent-yellow px-4 py-3.5 text-left text-brand-navy shadow-card active:translate-y-px"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-brand-navy text-accent-yellow">
        <ClipboardCheck aria-hidden="true" className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-display text-[15px] font-extrabold tracking-tight">
          Start weekly closeout
        </span>
        <span className="block font-mono text-[11px] font-medium opacity-75">
          {pendingCount} {pendingCount === 1 ? "timesheet" : "timesheets"} still to approve
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0" />
    </button>
  );
}

/* ── Section label ───────────────────────────────────────────────────── */

function SectionLabel({ children, meta }: { children: ReactNode; meta?: string }) {
  return (
    <div className="flex items-center justify-between px-1">
      <h2 className="font-display text-sm font-semibold text-text">{children}</h2>
      {meta ? <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">{meta}</span> : null}
    </div>
  );
}

/* ── Worker card (to-approve) ────────────────────────────────────────── */

interface CardActions {
  overlay: Overlay;
  busyIds: string[];
  canUndo: boolean;
  approveWorker: (worker: WeeklyWorkerHours) => void;
  undoWorker: (worker: WeeklyWorkerHours) => void;
}

function WorkerCard({
  worker,
  actions,
  onOpen,
}: {
  worker: WeeklyWorkerHours;
  actions: CardActions;
  onOpen: (mode: SheetMode) => void;
}) {
  const { overlay, busyIds, canUndo, approveWorker, undoWorker } = actions;
  const status = overlay[worker.workerId]?.status;
  const split = workerOrdOtSplit(worker);
  const busy = busyIds.includes(worker.workerId);
  const undoable = canUndo && (overlay[worker.workerId]?.undo.length ?? 0) > 0;

  return (
    <div className="border-t border-border first:border-t-0">
      <div className="px-4 py-3.5">
        <button
          type="button"
          onClick={() => onOpen("review")}
          className="flex w-full items-center gap-3 text-left"
        >
          <WorkerAvatar name={worker.workerName} tone={status === "approved" ? "ready" : split.hasOvertime ? "look" : "neutral"} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-[15px] font-bold text-text">{worker.workerName}</div>
            <div className="truncate text-xs text-text-muted">{workerSubLine(worker)}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-display text-lg font-bold leading-none tabular-nums text-text">
              {worker.loggedHours}
              <span className="ml-0.5 text-xs font-semibold text-text-muted">h</span>
            </div>
            {split.hasOvertime ? (
              <span className="mt-1 inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-800">
                <TriangleAlert aria-hidden="true" className="h-2.5 w-2.5" />
                {split.overtime} OT
              </span>
            ) : (
              <span className="mt-1 block font-mono text-[10px] text-text-muted">no OT</span>
            )}
          </div>
        </button>

        <div className="mt-3 overflow-x-auto">
          <WeekShapeStrip cells={workerStrip(worker)} workerName={worker.workerName} />
        </div>

        {status === "approved" ? (
          <ResolvedBar
            tone="ok"
            label={`Approved · ${formatHoursLabel(submittedHoursOf(worker))}`}
            undoable={undoable}
            busy={busy}
            onUndo={() => undoWorker(worker)}
          />
        ) : status === "queried" ? (
          <ResolvedBar
            tone="warn"
            label={`Sent back to ${firstName(worker.workerName)}`}
            undoable={undoable}
            busy={busy}
            onUndo={() => undoWorker(worker)}
          />
        ) : (
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="flex-1"
              disabled={busy}
              onClick={() => onOpen("query")}
            >
              <RotateCcw aria-hidden="true" className="h-4 w-4" />
              Query
            </Button>
            <Button
              size="sm"
              className="flex-1"
              disabled={busy}
              onClick={() => approveWorker(worker)}
            >
              <Check aria-hidden="true" className="h-4 w-4" />
              {busy ? "Approving…" : "Approve"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ResolvedBar({
  tone,
  label,
  undoable,
  busy,
  onUndo,
}: {
  tone: "ok" | "warn";
  label: string;
  undoable: boolean;
  busy: boolean;
  onUndo: () => void;
}) {
  return (
    <div
      className={cn(
        "mt-3 flex items-center gap-2 rounded-card border px-3 py-2.5",
        tone === "ok" ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50",
      )}
    >
      <span
        className={cn(
          "flex items-center gap-1.5 text-[13px] font-semibold",
          tone === "ok" ? "text-emerald-900" : "text-amber-900",
        )}
      >
        {tone === "ok" ? (
          <Check aria-hidden="true" className="h-4 w-4" />
        ) : (
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
        )}
        {label}
      </span>
      {undoable ? (
        <button
          type="button"
          onClick={onUndo}
          disabled={busy}
          className="ml-auto font-display text-[13px] font-semibold text-text-muted underline decoration-border underline-offset-2 disabled:opacity-50"
        >
          {busy ? "…" : "Undo"}
        </button>
      ) : null}
    </div>
  );
}

/* ── Settled row (approved band) ─────────────────────────────────────── */

function SettledRow({
  worker,
  undoable,
  busy,
  onUndo,
}: {
  worker: WeeklyWorkerHours;
  undoable: boolean;
  busy: boolean;
  onUndo: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
      <WorkerAvatar name={worker.workerName} tone="ready" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-sm font-semibold text-text">{worker.workerName}</div>
        <div className="truncate text-xs text-text-muted">{workerSubLine(worker)}</div>
      </div>
      <span className="inline-flex items-center gap-1.5 font-display text-[13px] font-bold text-emerald-700">
        <Check aria-hidden="true" className="h-4 w-4" />
        {formatHoursLabel(worker.approvedHours)}
      </span>
      {undoable ? (
        <button
          type="button"
          onClick={onUndo}
          disabled={busy}
          className="font-display text-[13px] font-semibold text-text-muted underline decoration-border underline-offset-2 disabled:opacity-50"
        >
          {busy ? "…" : "Undo"}
        </button>
      ) : null}
    </div>
  );
}

/* ── Waiting card (waiting on the worker) ────────────────────────────── */

function WaitingCard({
  worker,
  undoable,
  busy,
  onUndo,
}: {
  worker: WeeklyWorkerHours;
  undoable: boolean;
  busy: boolean;
  onUndo: () => void;
}) {
  const reasons = worker.needsLookReasons.length > 0 ? worker.needsLookReasons : worker.blockers;
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-3">
        <WorkerAvatar name={worker.workerName} tone="look" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-sm font-semibold text-text">{worker.workerName}</div>
          <div className="truncate text-xs text-text-muted">{workerSubLine(worker)}</div>
        </div>
        <Pill tone={worker.rejectedCount > 0 ? "danger" : "warning"}>
          {worker.rejectedCount > 0 ? "Sent back" : worker.missingCount > 0 ? "Missing" : "Draft"}
        </Pill>
      </div>
      {reasons.length > 0 ? (
        <ul className="mt-2 space-y-1 pl-1">
          {reasons.slice(0, 3).map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-text-muted">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                  worker.rejectedCount > 0 ? "bg-state-danger" : "bg-accent-yellow",
                )}
              />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] text-text-muted">
          Waiting on {firstName(worker.workerName)} — nothing to approve here yet.
        </p>
        {undoable ? (
          <button
            type="button"
            onClick={onUndo}
            disabled={busy}
            className="shrink-0 font-display text-[13px] font-semibold text-text-muted underline decoration-border underline-offset-2 disabled:opacity-50"
          >
            {busy ? "…" : "Undo send-back"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ── Shared bits ─────────────────────────────────────────────────────── */

function WorkerAvatar({ name, tone }: { name: string; tone: "ready" | "look" | "neutral" }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join("") || "—";
  const toneClass =
    tone === "ready"
      ? "bg-emerald-100 text-emerald-800"
      : tone === "look"
        ? "bg-amber-100 text-amber-900"
        : "bg-surface-subtle text-text-muted";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-display text-xs font-semibold",
        toneClass,
      )}
    >
      {initials}
    </span>
  );
}

function workerSubLine(worker: WeeklyWorkerHours): string {
  const jobs = worker.jobBreakdown;
  const jobPart =
    jobs.length === 0 ? "No hours yet" : jobs.length === 1 ? jobs[0]!.jobName : `${jobs.length} jobs`;
  return worker.workerRole ? `${worker.workerRole} · ${jobPart}` : jobPart;
}

/**
 * Progress-bar fill as a STATIC Tailwind class (the repo bans the `style`
 * attribute). Bucketed to the nearest 10% so the class is statically
 * resolvable; the exact "X of Y" count sits beside the bar. Mirrors the
 * desktop board's progressFillClass.
 */
function progressFillClass(pct: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  if (clamped <= 0) return "w-0";
  if (clamped >= 100) return "w-full";
  const bucket = Math.round(clamped / 10) * 10;
  switch (bucket) {
    case 10:
      return "w-[10%]";
    case 20:
      return "w-1/5";
    case 30:
      return "w-[30%]";
    case 40:
      return "w-2/5";
    case 50:
      return "w-1/2";
    case 60:
      return "w-3/5";
    case 70:
      return "w-[70%]";
    case 80:
      return "w-4/5";
    case 90:
      return "w-[90%]";
    default:
      return "w-1/2";
  }
}

// Day-status pills in the review sheet — ONLY the exceptions (rejected / draft)
// earn a pill; a submitted day is the norm in a to-approve week, so pilling
// every row would be noise. Approved days in a mixed week read clean too.
const DAY_PILL_TONE: Partial<Record<WeeklyDayStatus, "danger" | "warning">> = {
  rejected: "danger",
  draft: "warning",
};

/* ── Review sheet (one at a time) ────────────────────────────────────── */

function ReviewSheet({
  ids,
  startId,
  single,
  startMode,
  workerById,
  overlay,
  canUndo,
  canAmend,
  busyIds,
  onApprove,
  onQuery,
  onUndo,
  onAmendDay,
  onClose,
  weekStart,
  weekEnd,
  periodLabel,
  xeroGate,
  xeroCandidates,
  outstanding,
}: {
  ids: string[];
  startId: string;
  single: boolean;
  startMode: SheetMode;
  workerById: Map<string, WeeklyWorkerHours>;
  overlay: Overlay;
  canUndo: boolean;
  canAmend: boolean;
  busyIds: string[];
  onApprove: (worker: WeeklyWorkerHours) => void;
  onQuery: (worker: WeeklyWorkerHours, reason: MobileQueryReason, note: string) => void;
  onUndo: (worker: WeeklyWorkerHours) => void;
  onAmendDay: (
    worker: WeeklyWorkerHours,
    day: WeeklyHoursDay,
    payload: AmendPayload,
  ) => Promise<boolean>;
  onClose: () => void;
  weekStart: string;
  weekEnd: string;
  periodLabel: string;
  xeroGate?: XeroFinaleGate;
  xeroCandidates: ReviewCandidate[];
  /** Week-wide "still to come in" counts for the send finale's wait choice. */
  outstanding: OutstandingWeek;
}) {
  const panelRef = useDialogFocus(true);
  const [shown, setShown] = useState(false);
  const [cursor, setCursor] = useState(() => Math.max(0, ids.indexOf(startId)));
  const [mode, setMode] = useState<"review" | "query" | "done">(startMode);
  const [reason, setReason] = useState<MobileQueryReason | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // A Xero push is in flight — the sheet must not be dismissed under it, or
  // the boss loses the only report of what Xero actually did. (The write
  // itself is durable and idempotent, so this costs visibility, not data.)
  const [finaleBusy, setFinaleBusy] = useState(false);
  const guardedClose = () => {
    if (finaleBusy) return;
    onClose();
  };

  // Close on Escape (backdrop click handled below).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !finaleBusy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, finaleBusy]);

  const id = ids[cursor]!;
  const worker = workerById.get(id);

  const resetDay = () => {
    setMode("review");
    setReason(null);
    setNote("");
  };
  const advance = () => {
    if (single) {
      onClose();
      return;
    }
    if (cursor + 1 < ids.length) {
      setCursor(cursor + 1);
      resetDay();
    } else {
      setMode("done");
    }
  };
  const approve = () => {
    if (worker) onApprove(worker);
    advance();
  };
  const sendBack = () => {
    if (worker && reason) onQuery(worker, reason, note);
    advance();
  };

  const alreadyResolved = worker ? overlay[worker.workerId]?.status : undefined;
  const canSendBack = reason != null && buildQueryReason(reason, note) != null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review week"
      className="fixed inset-0 z-[60] flex flex-col justify-end bg-accent-ink/40"
      onClick={guardedClose}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        data-testid="wha-review-sheet"
        className={cn(
          "flex max-h-[92vh] flex-col rounded-t-[20px] bg-surface shadow-raised transition-transform duration-300 motion-reduce:transition-none",
          shown ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="flex justify-center pt-2.5">
          <span aria-hidden="true" className="h-1 w-10 rounded-pill bg-border" />
        </div>

        {mode === "done" || !worker ? (
          xeroGate?.isAdmin && xeroGate.accountsConfigured ? (
            /* Owner pull 2026-08-15: while Xero is out of action the closeout
               ends by emailing the week to accounts — TIMESHEETS_EMAIL_TO set
               means the send finale owns this slot. */
            <WeeklyCloseoutSendFinale
              reviewedCount={ids.length}
              weekStart={weekStart}
              weekEnd={weekEnd}
              periodLabel={periodLabel}
              candidates={xeroCandidates}
              outstanding={outstanding}
              onClose={onClose}
              onBusyChange={setFinaleBusy}
            />
          ) : (
            <WeeklyCloseoutXeroFinale
              reviewedCount={ids.length}
              weekStart={weekStart}
              weekEnd={weekEnd}
              periodLabel={periodLabel}
              gate={xeroGate ?? { isAdmin: false, connectionFlag: false, exportFlag: false }}
              candidates={xeroCandidates}
              onClose={onClose}
              onBusyChange={setFinaleBusy}
            />
          )
        ) : (
          <>
            <div className="border-b border-border px-5 pb-4 pt-3">
              {!single ? (
                <div className="mb-3 flex items-center gap-3">
                  <div className="flex flex-1 gap-1">
                    {ids.map((x, i) => (
                      <span
                        key={x}
                        className={cn(
                          "h-1 flex-1 rounded-pill",
                          i < cursor || overlay[x] ? "bg-state-success" : i === cursor ? "bg-brand-navy" : "bg-border",
                        )}
                      />
                    ))}
                  </div>
                  <span className="font-mono text-[10px] tracking-wide text-text-muted">
                    {cursor + 1} of {ids.length}
                  </span>
                </div>
              ) : null}
              <div className="flex items-center gap-3">
                <WorkerAvatar name={worker.workerName} tone={workerOrdOtSplit(worker).hasOvertime ? "look" : "neutral"} />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-display text-lg font-bold text-text">{worker.workerName}</h3>
                  <p className="truncate text-xs text-text-muted">{workerSubLine(worker)}</p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-display text-2xl font-extrabold leading-none tracking-tight tabular-nums text-text">
                    {worker.loggedHours}
                    <span className="ml-0.5 text-sm font-semibold text-text-muted">h</span>
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase tracking-widest text-text-muted">This week</div>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {mode === "query" ? (
                <QueryPanel worker={worker} reason={reason} note={note} onReason={setReason} onNote={setNote} />
              ) : (
                <ReviewBody
                  worker={worker}
                  alreadyApproved={alreadyResolved === "approved"}
                  canAmend={canAmend}
                  busy={busyIds.includes(worker.workerId)}
                  onAmendDay={onAmendDay}
                />
              )}
            </div>

            <div className="flex gap-2 border-t border-border px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {mode === "query" ? (
                <>
                  <Button variant="secondary" className="flex-1" onClick={resetDay}>
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    className="flex-1"
                    disabled={!canSendBack}
                    onClick={sendBack}
                  >
                    <RotateCcw aria-hidden="true" className="h-4 w-4" />
                    Send back
                  </Button>
                </>
              ) : alreadyResolved === "approved" ? (
                <>
                  {canUndo ? (
                    <Button
                      variant="secondary"
                      className="flex-1"
                      onClick={() => {
                        onUndo(worker);
                        advance();
                      }}
                    >
                      Undo approval
                    </Button>
                  ) : null}
                  <Button className="flex-1" onClick={advance}>
                    {single ? "Close" : "Next →"}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="secondary" className="flex-1" onClick={() => setMode("query")}>
                    <RotateCcw aria-hidden="true" className="h-4 w-4" />
                    Query
                  </Button>
                  <Button
                    className="flex-1"
                    disabled={busyIds.includes(worker.workerId)}
                    onClick={approve}
                  >
                    <Check aria-hidden="true" className="h-4 w-4" />
                    Approve {formatHoursLabel(submittedHoursOf(worker))}
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ReviewBody({
  worker,
  alreadyApproved,
  canAmend,
  busy,
  onAmendDay,
}: {
  worker: WeeklyWorkerHours;
  alreadyApproved: boolean;
  canAmend: boolean;
  busy: boolean;
  onAmendDay: (
    worker: WeeklyWorkerHours,
    day: WeeklyHoursDay,
    payload: AmendPayload,
  ) => Promise<boolean>;
}) {
  // Which day's inline "fix the hours" editor is open — one at a time, so the
  // sheet never turns into a form.
  const [amendDate, setAmendDate] = useState<string | null>(null);
  const split = workerOrdOtSplit(worker);
  const longDays = workerLongDayCount(worker);
  // Meaningful days only — drop empty weekends (mirrors the desktop board).
  const dayRows = worker.days.filter(
    (d) => !(["Sat", "Sun"].includes(d.weekday) && d.entryId === null && d.status !== "missing"),
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5">
        <SplitBlock label="Ordinary" value={split.ordinary} />
        <SplitBlock label="Overtime" value={split.overtime} hot={split.hasOvertime} />
      </div>

      {split.hasOvertime ? (
        <div className="flex items-start gap-2 rounded-card border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <b className="font-semibold">
              {formatHoursLabel(worker.loggedHours)} — {formatHoursLabel(split.overtime)} overtime.
            </b>
            {longDays > 0 ? ` ${longDays} long day${longDays > 1 ? "s" : ""} this week.` : ""} Approving includes the overtime.
          </span>
        </div>
      ) : null}

      <div>
        <div className="mb-1 flex items-center justify-between px-1">
          <h4 className="font-display text-sm font-semibold text-text">Day by day</h4>
          <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
            {dayRows.filter((d) => d.hours != null).length} days
          </span>
        </div>
        <div className="rounded-card border border-border">
          {dayRows.map((day) => (
            <DaySheetRow
              key={day.date}
              day={day}
              worker={worker}
              // Only a day still waiting on a decision can be fixed here — the
              // server says the same (409 on anything else).
              canAmend={canAmendDay(day, canAmend)}
              amendOpen={amendDate === day.date}
              busy={busy}
              onOpenAmend={setAmendDate}
              onAmendDay={onAmendDay}
            />
          ))}
        </div>
      </div>

      {worker.jobBreakdown.length > 0 ? (
        <div>
          <h4 className="mb-2 px-1 font-display text-sm font-semibold text-text">Booked to</h4>
          <div className="flex flex-wrap gap-2">
            {worker.jobBreakdown.map((j, i) => (
              <span
                key={j.jobId ?? `internal-${i}`}
                className="inline-flex items-center gap-1.5 rounded-pill bg-surface-subtle px-2.5 py-1 text-xs text-text"
              >
                <span className="truncate">{j.jobName}</span>
                <b className="font-mono text-[10px] font-semibold text-text-muted tabular-nums">{j.hours}h</b>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {alreadyApproved ? (
        <div className="rounded-card border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-900">
          <b className="font-semibold">Already approved.</b> This week is cleared for the run.
        </div>
      ) : null}
    </div>
  );
}

function SplitBlock({ label, value, hot }: { label: string; value: number; hot?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-card border p-3",
        hot ? "border-amber-200 bg-amber-50" : "border-border bg-surface",
      )}
    >
      <div
        className={cn(
          "font-mono text-[9px] uppercase tracking-widest",
          hot ? "text-amber-700" : "text-text-muted",
        )}
      >
        {label}
      </div>
      <div className={cn("mt-1.5 font-display text-2xl font-extrabold leading-none tracking-tight tabular-nums", hot ? "text-amber-900" : "text-text")}>
        {value}
        <span className="ml-0.5 text-sm font-semibold text-text-muted">h</span>
      </div>
    </div>
  );
}

function DaySheetRow({
  day,
  worker,
  canAmend,
  amendOpen,
  busy,
  onOpenAmend,
  onAmendDay,
}: {
  day: WeeklyHoursDay;
  worker: WeeklyWorkerHours;
  canAmend: boolean;
  amendOpen: boolean;
  busy: boolean;
  onOpenAmend: (date: string | null) => void;
  onAmendDay: (
    worker: WeeklyWorkerHours,
    day: WeeklyHoursDay,
    payload: AmendPayload,
  ) => Promise<boolean>;
}) {
  const num = new Date(day.date + "T00:00:00Z").toLocaleDateString("en-AU", {
    day: "numeric",
    timeZone: "UTC",
  });
  const logged = day.hours != null;
  const long = day.hours != null && day.hours > 10;
  const tone = DAY_PILL_TONE[day.status];
  return (
    <div className="border-t border-border first:border-t-0">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="w-10 shrink-0">
          <div className="font-display text-[13px] font-bold text-text">{day.weekday}</div>
          <div className="font-mono text-[10px] text-text-muted">{num}</div>
        </div>
        <div className="min-w-0 flex-1">
          {logged ? (
            <>
              <div className="truncate font-display text-[13px] font-medium text-text">
                {day.jobLabel ?? "No job"}
                {tone ? (
                  <Pill tone={tone} className="ml-1.5 align-middle">
                    {weeklyDayStatusLabel(day.status)}
                  </Pill>
                ) : null}
              </div>
              {day.note ? <div className="truncate text-xs text-text-muted">{day.note}</div> : null}
            </>
          ) : (
            <div className="text-[13px] text-text-muted">
              {day.status === "missing"
                ? "Missing"
                : day.status === "leave"
                  ? `On leave${day.leaveType ? ` · ${day.leaveType}` : ""}`
                  : day.status === "holiday"
                    ? day.holidayName ?? "Public holiday"
                    : "Not on"}
            </div>
          )}
        </div>
        {/* One compact affordance in the row's action slot — the office's
            "that's a typo" motion, right next to the number that's wrong. */}
        {canAmend && !amendOpen ? (
          <button
            type="button"
            onClick={() => onOpenAmend(day.date)}
            disabled={busy}
            data-testid={`wha-amend-open-${day.date}`}
            aria-label={`Fix the hours for ${day.weekday}`}
            className="shrink-0 rounded-pill border border-border px-3 py-1.5 font-display text-[12px] font-semibold text-text-muted disabled:opacity-50"
          >
            Fix
          </button>
        ) : null}
        <div className="shrink-0 text-right">
          {logged ? (
            <>
              <span className="font-display text-[15px] font-bold tabular-nums text-text">{day.hours}</span>
              {long ? (
                <span className="block font-mono text-[9px] font-semibold uppercase tracking-wide text-amber-700">
                  long day
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-text-muted">—</span>
          )}
        </div>
      </div>
      {canAmend && amendOpen ? (
        <div className="px-3 pb-3">
          <AmendHoursEditor
            dateLabel={`${day.weekday} ${num}`}
            workerName={worker.workerName}
            currentTotalHours={day.hours ?? 0}
            allocations={amendDayAllocations(day)}
            saving={busy}
            onCancel={() => onOpenAmend(null)}
            onSave={(payload) => {
              void onAmendDay(worker, day, payload).then((ok) => {
                if (ok) onOpenAmend(null);
              });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}


function QueryPanel({
  worker,
  reason,
  note,
  onReason,
  onNote,
}: {
  worker: WeeklyWorkerHours;
  reason: MobileQueryReason | null;
  note: string;
  onReason: (r: MobileQueryReason) => void;
  onNote: (n: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-card border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <b className="font-semibold">Send {firstName(worker.workerName)}&rsquo;s week back?</b> They&rsquo;ll get it
        on their phone to fix and re-submit, with a push. Pick a reason:
      </div>
      <div className="flex flex-wrap gap-2">
        {MOBILE_QUERY_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={reason === r}
            onClick={() => onReason(r)}
            className={cn(
              "inline-flex h-9 items-center rounded-pill border px-3 text-sm",
              reason === r
                ? "border-brand-navy bg-brand-navy text-text-inverse"
                : "border-border bg-surface text-text",
            )}
          >
            {r}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="sr-only">Add a note</span>
        <textarea
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => onNote(e.target.value)}
          placeholder={reason === "Other" ? "Say what needs fixing…" : "Add a note (optional)…"}
          className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
        />
      </label>
      {reason === "Other" ? (
        <p className="px-1 text-[11px] text-text-muted">A note is required for &ldquo;Other&rdquo;.</p>
      ) : null}
    </div>
  );
}

