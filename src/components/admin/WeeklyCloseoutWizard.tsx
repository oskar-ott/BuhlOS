"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { Check, RotateCcw, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { useDialogFocus } from "@/components/ui/useDialogFocus";
import { pctWidthClass } from "@/components/admin/pct-width";
import { timesheetsClient } from "@/domains/timesheets/client";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  submittedWeekSelection,
  weeklyDayStatusLabel,
  type WeeklyDayStatus,
  type WeeklyHoursCloseout,
  type WeeklyWorkerHours,
} from "@/domains/timesheets/weekly-closeout";
import {
  closeoutRejectReason,
  reviewDayRows,
  submittedHoursOf,
  weeklyReviewQueue,
  workerOrdOtSplit,
  workerStatusWord,
} from "@/domains/timesheets/weekly-review";

/**
 * WeeklyCloseoutWizard — the desktop "Start weekly closeout" ritual on
 * /hours/weekly (lean-reset redesign): a centred modal that steps the office
 * through EVERY worker's week, one at a time — ordinary/overtime up top, the
 * day-by-day truth, the jobs the week was booked to — ending on approve /
 * send-back / next. The phone has run this ritual for a while
 * (WeeklyHoursApprovalMobile's ReviewSheet); this is the same model brought to
 * the desk, built on the SAME pure view-model (weekly-review.ts) and the SAME
 * endpoints — no second status-transition path:
 *   - Approve → POST /api/time-entries-bulk-approve (the worker's submitted
 *     days via submittedWeekSelection).
 *   - Send back → POST /api/time-entries-reject per submitted day, with the
 *     boss's note (or the named default — the endpoint requires a reason and
 *     the worker reads it in a push).
 *   - Undo → POST /api/time-entries-reopen back to submitted (admin tier only,
 *     30s window — same contract as the board and the phone).
 *
 * SPEED + HONESTY (P7), ported from the mobile surface: actions apply to a
 * local overlay and the stepper advances immediately; a debounced
 * router.refresh() reconciles against persisted state. The overlay is only set
 * on a FULL success — a partial or failed write surfaces in the wizard's
 * notice line and the worker stays actionable, never shown as done when it
 * isn't. Busy state is PER WORKER so a slow write on one week never blocks
 * reviewing the next.
 */

interface OverlayEntry {
  status: "approved" | "queried";
  undo: Array<{ userId: string; date: string }>;
}
type Overlay = Record<string, OverlayEntry>;

interface Notice {
  tone: "ok" | "warn";
  msg: string;
}

const HOURS_PERIOD: Route = "/hours/period" as Route;
const UNDO_WINDOW_MS = 30_000;

const firstName = (name: string) => name.split(/\s+/)[0] || name;

// Day-status pill tones in the "Day by day" list — matches the replica:
// approved green, submitted blue, rejected red; draft warns.
const DAY_PILL_TONE: Partial<Record<WeeklyDayStatus, "success" | "info" | "danger" | "warning">> = {
  approved: "success",
  submitted: "info",
  rejected: "danger",
  draft: "warning",
};

export interface WeeklyCloseoutWizardProps {
  closeout: WeeklyHoursCloseout;
  /** "14 July – 20 July" — the header eyebrow. */
  weekLabel: string;
  /** True when the viewer can undo (reopen is admin tier). */
  canUndo: boolean;
  onClose: () => void;
}

export function WeeklyCloseoutWizard({
  closeout,
  weekLabel,
  canUndo,
  onClose,
}: WeeklyCloseoutWizardProps) {
  const router = useRouter();
  const panelRef = useDialogFocus(true);

  // The queue walks the WHOLE crew (weeks with nothing submitted get "Next"),
  // frozen at open so a mid-review router.refresh can't reorder the walk.
  const [queue] = useState<string[]>(() => weeklyReviewQueue(closeout));
  const workerById = new Map(closeout.workers.map((w) => [w.workerId, w]));

  const [cursor, setCursor] = useState(0);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [overlay, setOverlay] = useState<Overlay>({});
  const [notice, setNotice] = useState<Notice | null>(null);

  // Per-worker in-flight guard — ref as synchronous source of truth (a rapid
  // stepper can't double-fire the SAME worker), mirrored to state for the
  // buttons. Per-worker, never global: approving B while A is in flight is the
  // whole point of the optimistic stepper.
  const busyRef = useRef<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const setBusy = useCallback((id: string, on: boolean) => {
    if (on) busyRef.current.add(id);
    else busyRef.current.delete(id);
    setBusyIds([...busyRef.current]);
  }, []);

  // Debounced reconcile — one refresh after a burst of decisions, so the boss
  // never waits on a round-trip between people.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), 700);
  }, [router]);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

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

  const close = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    router.refresh();
    onClose();
  }, [router, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const approveWorker = useCallback(
    async (worker: WeeklyWorkerHours) => {
      const entries = submittedWeekSelection(worker);
      if (entries.length === 0 || busyRef.current.has(worker.workerId)) return;
      setBusy(worker.workerId, true);
      const res = await timesheetsClient.bulkApproveEntries({ entries });
      setBusy(worker.workerId, false);
      if (!res.ok) {
        setNotice({
          tone: "warn",
          msg:
            res.error.status === 403
              ? `Couldn't approve ${firstName(worker.workerName)} — office login needed`
              : `Couldn't approve ${firstName(worker.workerName)} — try again`,
        });
        return;
      }
      const { approvedCount, failed } = res.data;
      // HONESTY (P7): only claim "approved" on a FULL success.
      if (approvedCount === 0) {
        setNotice({ tone: "warn", msg: `Couldn't approve ${firstName(worker.workerName)} — try again` });
        scheduleRefresh();
        return;
      }
      if (failed.length > 0) {
        setNotice({
          tone: "warn",
          msg: `Approved ${approvedCount} of ${approvedCount + failed.length} days · ${firstName(worker.workerName)} — ${failed.length} need a look`,
        });
        scheduleRefresh();
        return;
      }
      const undo = canUndo ? res.data.approved.map((a) => ({ userId: a.userId, date: a.date })) : [];
      setOverlay((o) => ({ ...o, [worker.workerId]: { status: "approved", undo } }));
      setNotice({
        tone: "ok",
        msg: `Approved ${formatHoursLabel(submittedHoursOf(worker))} · ${firstName(worker.workerName)}`,
      });
      scheduleUndoExpiry(worker.workerId, undo);
      scheduleRefresh();
    },
    [canUndo, scheduleRefresh, scheduleUndoExpiry, setBusy],
  );

  const rejectWorker = useCallback(
    async (worker: WeeklyWorkerHours, noteText: string) => {
      const days = submittedWeekSelection(worker);
      if (days.length === 0 || busyRef.current.has(worker.workerId)) return;
      const reason = closeoutRejectReason(noteText);
      setBusy(worker.workerId, true);
      let failed = 0;
      for (const d of days) {
        const r = await timesheetsClient.rejectEntry({
          userId: d.userId,
          date: d.date,
          reason,
        });
        if (!r.ok) failed += 1;
      }
      setBusy(worker.workerId, false);
      const succeeded = days.length - failed;
      if (succeeded === 0) {
        setNotice({ tone: "warn", msg: "Couldn't send it back — try again" });
        scheduleRefresh();
        return;
      }
      if (failed > 0) {
        setNotice({
          tone: "warn",
          msg: `Sent ${succeeded} of ${days.length} days back · ${firstName(worker.workerName)} — ${failed} didn't send`,
        });
        scheduleRefresh();
        return;
      }
      const undo = canUndo ? days.map((d) => ({ userId: d.userId, date: d.date })) : [];
      setOverlay((o) => ({ ...o, [worker.workerId]: { status: "queried", undo } }));
      setNotice({ tone: "ok", msg: `Sent back to ${firstName(worker.workerName)} with your note` });
      scheduleUndoExpiry(worker.workerId, undo);
      scheduleRefresh();
    },
    [canUndo, scheduleRefresh, scheduleUndoExpiry, setBusy],
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
        setNotice({ tone: "warn", msg: "Couldn't undo — try again" });
        return;
      }
      setOverlay((o) => {
        const next = { ...o };
        delete next[worker.workerId];
        return next;
      });
      setNotice({ tone: "ok", msg: `Undone · ${firstName(worker.workerName)} back to submitted` });
      scheduleRefresh();
    },
    [overlay, scheduleRefresh, setBusy],
  );

  const count = queue.length;
  const done = cursor >= count;
  const worker = done ? null : workerById.get(queue[cursor]!) ?? null;

  const resetStep = () => {
    setRejecting(false);
    setNote("");
  };
  const advance = () => {
    setCursor((c) => c + 1);
    resetStep();
  };
  const back = () => {
    setCursor((c) => Math.max(0, c - 1));
    resetStep();
  };

  const resolved = worker ? overlay[worker.workerId]?.status : undefined;
  const hasSubmitted = worker != null && !resolved && worker.submittedCount > 0;
  const busy = worker != null && busyIds.includes(worker.workerId);
  const undoable = worker != null && canUndo && (overlay[worker.workerId]?.undo.length ?? 0) > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Weekly closeout"
      data-testid="closeout-wizard"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-accent-ink/50 p-4 sm:p-6"
      onClick={close}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-[600px] flex-col overflow-hidden rounded-2xl bg-surface shadow-raised"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[.14em] text-text-muted">
              Weekly closeout · {weekLabel}
            </p>
            <h2 className="mt-0.5 font-display text-lg font-semibold text-text">
              Review each week
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-card border border-border text-text-muted hover:border-brand-navy hover:text-text"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        {/* Progress */}
        <div className="px-5 pb-1 pt-3">
          <p className="font-mono text-[11px] text-text-muted">
            {Math.min(cursor + 1, count)} of {count}
          </p>
          <div
            className="mt-1.5 h-[5px] overflow-hidden rounded-pill bg-surface-subtle"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={count}
            aria-valuenow={Math.min(cursor, count)}
            aria-label="Weeks reviewed"
          >
            <div
              aria-hidden="true"
              className={cn(
                "h-full rounded-pill bg-accent-yellow transition-[width] motion-reduce:transition-none",
                pctWidthClass(cursor, count),
              )}
            />
          </div>
        </div>

        {/* Notice line — the wizard's honest outcome readout. */}
        {notice ? (
          <div className="px-5 pt-2" role="status" aria-live="polite">
            <p
              className={cn(
                "rounded-card px-3 py-1.5 text-xs font-medium",
                notice.tone === "ok"
                  ? "bg-emerald-50 text-emerald-900"
                  : "bg-amber-50 text-amber-900",
              )}
            >
              {notice.msg}
            </p>
          </div>
        ) : null}

        {done || !worker ? (
          <DonePanel onClose={close} />
        ) : (
          <>
            {/* Scrollable body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              <div className="flex items-center gap-3.5">
                <span
                  aria-hidden="true"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-navy font-display text-[15px] font-semibold text-white"
                >
                  {initialsOf(worker.workerName)}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-display text-xl font-semibold text-text">
                    {worker.workerName}
                  </h3>
                  <p className="mt-0.5 truncate text-[13px] text-text-muted">
                    {worker.workerRole ? `${worker.workerRole} · ` : ""}
                    {workerStatusWord(worker)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-display text-2xl font-extrabold leading-none tabular-nums text-text">
                    {formatHoursLabel(worker.loggedHours)}
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase tracking-[.1em] text-text-muted">
                    this week
                  </div>
                </div>
              </div>

              <OrdOtBlocks worker={worker} />

              <h4 className="mb-2 mt-4 font-display text-[13px] font-semibold text-text">
                Day by day
              </h4>
              <div className="overflow-hidden rounded-card border border-border">
                {reviewDayRows(worker).map(({ day, note: dayNote }) => (
                  <div
                    key={day.date}
                    className="flex items-start gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0"
                  >
                    <div className="w-[78px] shrink-0 font-display text-[13px] font-semibold text-text">
                      {day.weekday}
                    </div>
                    {dayNote == null ? (
                      <>
                        <div className="min-w-0 flex-1">
                          {day.jobLabel ? (
                            <div className="flex justify-between gap-2 text-[13px]">
                              <span className="truncate text-text">{day.jobLabel}</span>
                              <span className="font-mono tabular-nums text-text-muted">
                                {day.hours != null ? formatHoursLabel(day.hours) : "—"}
                              </span>
                            </div>
                          ) : (
                            <div className="flex justify-between gap-2 text-[13px]">
                              <span className="text-text-muted">No job assigned</span>
                              <span className="font-mono tabular-nums text-text-muted">
                                {day.hours != null ? formatHoursLabel(day.hours) : "—"}
                              </span>
                            </div>
                          )}
                          {day.rejectedReason ? (
                            <p className="mt-0.5 text-xs text-state-danger">
                              Reason: {day.rejectedReason}
                            </p>
                          ) : null}
                        </div>
                        {DAY_PILL_TONE[day.status] ? (
                          <Pill tone={DAY_PILL_TONE[day.status]!} className="shrink-0">
                            {weeklyDayStatusLabel(day.status)}
                          </Pill>
                        ) : null}
                      </>
                    ) : (
                      <div className="flex-1 text-[13px] text-text-muted">{dayNote}</div>
                    )}
                  </div>
                ))}
              </div>

              {worker.jobBreakdown.length > 0 ? (
                <>
                  <h4 className="mb-2 mt-4 font-display text-[13px] font-semibold text-text">
                    Booked to
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {worker.jobBreakdown.map((j, i) => (
                      <span
                        key={j.jobId ?? `internal-${i}`}
                        className="inline-flex items-center gap-1.5 rounded-pill border border-border px-2.5 py-1 text-xs text-text"
                      >
                        <span className="truncate">{j.jobName}</span>
                        <b className="font-mono font-semibold tabular-nums text-text-muted">
                          {j.hours}h
                        </b>
                      </span>
                    ))}
                  </div>
                </>
              ) : null}

              {resolved === "approved" ? (
                <ResolvedNote tone="ok" label="Approved — this week is cleared for the run." />
              ) : resolved === "queried" ? (
                <ResolvedNote
                  tone="warn"
                  label={`Sent back to ${firstName(worker.workerName)} — waiting on the fix.`}
                />
              ) : null}
            </div>

            {/* Footer */}
            <div className="shrink-0 border-t border-border px-6 py-3.5">
              {rejecting ? (
                <>
                  <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[.1em] text-text-muted">
                    Note to {firstName(worker.workerName)} (sent with the push)
                  </label>
                  <textarea
                    autoFocus
                    rows={2}
                    maxLength={500}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Thursday's arvo was on 8 Specimen Ct — please split it 6h/4h."
                    className="block w-full resize-y rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
                  />
                  <div className="mt-2.5 flex justify-end gap-2">
                    <Button variant="secondary" onClick={resetStep}>
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      data-testid="closeout-wizard-send-back"
                      disabled={busy}
                      onClick={() => {
                        void rejectWorker(worker, note);
                        advance();
                      }}
                    >
                      Send back with note →
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <Button variant="secondary" onClick={back} disabled={cursor === 0}>
                    ← Back
                  </Button>
                  <div className="flex gap-2">
                    {undoable ? (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void undoWorker(worker)}
                      >
                        <RotateCcw aria-hidden="true" className="h-4 w-4" />
                        Undo
                      </Button>
                    ) : null}
                    {hasSubmitted ? (
                      <>
                        {/* Ghost-red per the replica — the solid danger button
                            is reserved for the actual send-back confirm. */}
                        <button
                          type="button"
                          data-testid="closeout-wizard-reject"
                          disabled={busy}
                          onClick={() => setRejecting(true)}
                          className="h-10 rounded-card border border-rose-200 bg-rose-50 px-4 text-sm font-semibold text-rose-800 hover:border-rose-300 disabled:opacity-60"
                        >
                          Reject
                        </button>
                        <Button
                          data-testid="closeout-wizard-approve"
                          disabled={busy}
                          onClick={() => {
                            void approveWorker(worker);
                            advance();
                          }}
                        >
                          <Check aria-hidden="true" className="h-4 w-4" />
                          Approve all · {formatHoursLabel(submittedHoursOf(worker))}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="secondary"
                        data-testid="closeout-wizard-next"
                        onClick={advance}
                      >
                        Next →
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join("") || "—"
  );
}

/** Ordinary / Overtime blocks + the amber overtime warning line. Numbers come
 *  from the STORED per-day split via workerOrdOtSplit — never re-derived. */
function OrdOtBlocks({ worker }: { worker: WeeklyWorkerHours }): ReactNode {
  const split = workerOrdOtSplit(worker);
  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <div className="rounded-card border border-border px-3.5 py-2.5">
          <div className="font-mono text-[9px] uppercase tracking-[.1em] text-text-muted">
            Ordinary
          </div>
          <div className="mt-0.5 font-display text-lg font-bold tabular-nums text-text">
            {formatHoursLabel(split.ordinary)}
          </div>
        </div>
        <div
          className={cn(
            "rounded-card border px-3.5 py-2.5",
            split.hasOvertime ? "border-amber-200 bg-amber-50" : "border-border",
          )}
        >
          <div
            className={cn(
              "font-mono text-[9px] uppercase tracking-[.1em]",
              split.hasOvertime ? "text-amber-700" : "text-text-muted",
            )}
          >
            Overtime
          </div>
          <div
            className={cn(
              "mt-0.5 font-display text-lg font-bold tabular-nums",
              split.hasOvertime ? "text-amber-900" : "text-text",
            )}
          >
            {formatHoursLabel(split.overtime)}
          </div>
        </div>
      </div>
      {split.hasOvertime ? (
        <div className="mt-2.5 flex items-start gap-2 rounded-card border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <b className="font-semibold">
              {formatHoursLabel(worker.loggedHours)} logged — {formatHoursLabel(split.overtime)}{" "}
              overtime this week.
            </b>{" "}
            Approving includes the overtime.
          </span>
        </div>
      ) : null}
    </>
  );
}

function ResolvedNote({ tone, label }: { tone: "ok" | "warn"; label: string }): ReactNode {
  return (
    <div
      className={cn(
        "mt-4 rounded-card border p-3 text-xs font-medium",
        tone === "ok"
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : "border-amber-200 bg-amber-50 text-amber-900",
      )}
    >
      {label}
    </div>
  );
}

function DonePanel({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <div className="px-6 py-9 text-center">
      <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
        <Check aria-hidden="true" className="h-7 w-7" />
      </span>
      <h3 className="mt-4 font-display text-xl font-semibold text-text">Week reviewed</h3>
      <p className="mx-auto mt-2 max-w-[34ch] text-sm text-text-muted">
        Every submitted week is cleared for the payroll run. Take it to the pay
        period tab to roll it up for Xero.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <Button onClick={onClose}>Done</Button>
        <Link
          href={HOURS_PERIOD}
          className="inline-flex items-center rounded-card border border-border px-4 py-2 text-sm font-semibold text-text hover:border-brand-navy"
        >
          Open pay period →
        </Link>
      </div>
    </div>
  );
}
