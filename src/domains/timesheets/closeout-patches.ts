import {
  rollupWorkerDays,
  summarizeWorkers,
  type WeeklyDayStatus,
  type WeeklyHoursCloseout,
  type WeeklyHoursDay,
  type WeeklyWorkerHours,
} from "./weekly-closeout";

/**
 * What the desktop closeout board knows about a day BEFORE the page's copy
 * catches up (2026-10-15, shorter-paths audit H3).
 *
 * Every per-day action on /hours/weekly used to re-run the whole page —
 * overview walk, payroll runs, one cost-rate read per worker — so each click
 * bought two to four seconds of a stale row. The wizard and the phone sheet
 * already keep a local overlay and reconcile with ONE debounced refresh; this
 * is the board's version of that overlay, in domain terms:
 *
 *   - A patch is recorded only from a server answer (the entry the approve /
 *     reject / reopen response returns, or the leave row the mark returns) —
 *     never from the click. The server already agreed; the page's copy can
 *     trail it (the Blob CDN window), so the patch outranks the page until
 *     the page CONFIRMS it.
 *   - A patch is dropped the moment the page's copy shows the same status —
 *     from then on the page is the truth again (a worker who re-submits a
 *     sent-back day is seen, not masked by the office's old patch).
 *   - A patch is never dropped on a stale read: the write landed.
 *
 * The worker's counts, blockers, "needs a look" lines and readiness are
 * re-run over the patched days with the SAME roll-up the server build uses
 * (rollupWorkerDays), so the row, the chip and the Week-of hero move together
 * and never say something the roll-up wouldn't.
 */

export interface DayPatch {
  status: WeeklyDayStatus;
  /** Set on a send-back; cleared (null) on approve / reopen. Omit = keep. */
  rejectedReason?: string | null;
  /** Set when a missing day is marked not worked. Omit = keep. */
  leaveType?: string | null;
}

export type DayPatches = Readonly<Record<string, DayPatch>>;

export function patchKey(workerId: string, date: string): string {
  return `${workerId}|${date}`;
}

/** Record (or replace) the board's patch for one day. */
export function withDayPatch(
  patches: DayPatches,
  workerId: string,
  date: string,
  patch: DayPatch,
): DayPatches {
  return { ...patches, [patchKey(workerId, date)]: patch };
}

/** Record the same patch for several days of one worker (a bulk decision). */
export function withDayPatches(
  patches: DayPatches,
  refs: ReadonlyArray<{ userId: string; date: string }>,
  patch: DayPatch,
): DayPatches {
  if (refs.length === 0) return patches;
  const next = { ...patches };
  for (const r of refs) next[patchKey(r.userId, r.date)] = patch;
  return next;
}

/**
 * Drop every patch the page's copy now confirms (same status on the same
 * day). Returns the SAME object when nothing changed, so a state setter can
 * bail out without a render.
 */
export function pruneConfirmedPatches(
  patches: DayPatches,
  closeout: WeeklyHoursCloseout,
): DayPatches {
  const keys = Object.keys(patches);
  if (keys.length === 0) return patches;
  const serverStatus = new Map<string, WeeklyDayStatus>();
  for (const w of closeout.workers) {
    for (const d of w.days) serverStatus.set(patchKey(w.workerId, d.date), d.status);
  }
  let changed = false;
  const next: Record<string, DayPatch> = {};
  for (const k of keys) {
    const patch = patches[k]!;
    if (serverStatus.get(k) === patch.status) {
      changed = true;
      continue;
    }
    next[k] = patch;
  }
  return changed ? next : patches;
}

/**
 * One worker with the board's patches applied and the roll-up re-run.
 * Returns the SAME worker when no patch touches them (cheap, stable refs).
 */
export function applyDayPatches(worker: WeeklyWorkerHours, patches: DayPatches): WeeklyWorkerHours {
  let changed = false;
  const days: WeeklyHoursDay[] = worker.days.map((d) => {
    const patch = patches[patchKey(worker.workerId, d.date)];
    if (!patch) return d;
    changed = true;
    return {
      ...d,
      status: patch.status,
      rejectedReason: patch.rejectedReason === undefined ? d.rejectedReason : patch.rejectedReason,
      leaveType: patch.leaveType === undefined ? d.leaveType : patch.leaveType,
    };
  });
  if (!changed) return worker;
  return { ...worker, ...rollupWorkerDays(days), days };
}

/**
 * The closeout as the board shows it: every worker patched, the summary
 * re-summed from those workers. Worker ORDER is the page's — a row never
 * jumps under the cursor because of a click; the next reconcile re-sorts.
 * `approvedByJob` is entry-level and stays the page's until then.
 */
export function applyCloseoutPatches(
  closeout: WeeklyHoursCloseout,
  patches: DayPatches,
): WeeklyHoursCloseout {
  if (Object.keys(patches).length === 0) return closeout;
  let changed = false;
  const workers = closeout.workers.map((w) => {
    const next = applyDayPatches(w, patches);
    if (next !== w) changed = true;
    return next;
  });
  if (!changed) return closeout;
  return { ...closeout, workers, summary: summarizeWorkers(workers) };
}
