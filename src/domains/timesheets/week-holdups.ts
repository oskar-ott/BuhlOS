import type { WeeklyDayStatus, WeeklyHoursDay, WeeklyWorkerHours } from "./weekly-closeout";
import { shortDayLabel } from "./weekly-review";

/**
 * What's holding up the week — and the one-tap fix for each (owner pull
 * 2026-10-12: "if any problems come up approving and exporting timesheets it
 * doesn't halt the process — clear instructions and simple remedies to the
 * problems holding it up are presented").
 *
 * The send finale used to NAME what was outstanding ("Dylan · sent back for a
 * fix: Fri 9 Oct") and offer only "Wait for the full week" or "Send anyway".
 * Nothing on that screen could move a single day forward, so a day the worker
 * never fixed, a draft they never sent, or an approve that didn't go through
 * on bad signal sat there until someone left the screen to chase it. Every
 * line here carries the fix the office can make RIGHT THERE, using the actions
 * the server already allows the admin tier:
 *
 *   waiting  — submitted, not decided yet       → Approve (bulk approve those days)
 *   failed   — an approve this session didn't go through (why kept)
 *                                                → Approve again
 *   sentBack — rejected, waiting on the worker   → Take it back (reopen → submitted;
 *                                                  the line becomes "waiting" with Approve)
 *   draft    — saved on the phone, never sent    → Send it in for them (submit on
 *                                                  their behalf; then "waiting")
 *   missing  — nothing logged                    → no button: named on the sheet so
 *                                                  accounts sees it (crew on holiday is
 *                                                  normal — owner call 2026-08-17)
 *
 * Which lines HOLD the send is unchanged from the 2026-08-17 owner call: only
 * days mid-flight (waiting / failed / sent back) — drafts and missing days
 * inform and never hold.
 *
 * DAY-LEVEL, because the page's copy of the week can trail a write by up to a
 * minute (the Blob CDN window): every remedy acts on explicit {userId, date}
 * refs, and the session map below records what each write did, so a line
 * moves the moment its write lands — never on a re-read that may still be
 * stale. PURE: no React, no I/O.
 */

export type HoldUpKind = "failed" | "waiting" | "sentBack" | "draft" | "missing";

/** What a write this session made a day — the server already agreed (the write
 *  returned ok), the page's copy just hasn't caught up yet. */
export type SessionDayStatus = "approved" | "submitted" | "rejected";
/** Keyed by `${workerId}|${date}`. */
export type SessionDays = Readonly<Record<string, SessionDayStatus | undefined>>;

/** The per-worker optimistic resolution the phone closeout already keeps. */
export type WorkerOverlay = Readonly<
  Record<string, { status: "approved" | "queried" } | undefined>
>;

export interface HoldUpLine {
  workerId: string;
  workerName: string;
  kind: HoldUpKind;
  /** YYYY-MM-DD, ascending. */
  dates: string[];
  /** "Mon 5 Oct, Tue 6 Oct" — the sheet's own day format. */
  days: string;
  /** Logged hours on those days (0 for "missing"). */
  hours: number;
  /** For "failed": the plain-words reason the approve didn't go through. */
  why?: string;
}

export function sessionKey(workerId: string, date: string): string {
  return `${workerId}|${date}`;
}

/**
 * A day's status as it stands NOW: this session's own writes first, then the
 * per-worker overlay (an approve / send back of the worker's submitted days),
 * then the page's copy.
 */
export function effectiveDayStatus(
  workerId: string,
  day: WeeklyHoursDay,
  overlay: WorkerOverlay,
  session: SessionDays,
): WeeklyDayStatus {
  const own = session[sessionKey(workerId, day.date)];
  if (own) return own;
  if (day.status === "submitted") {
    const resolved = overlay[workerId]?.status;
    if (resolved === "approved") return "approved";
    if (resolved === "queried") return "rejected";
  }
  return day.status;
}

/**
 * The worker as it stands now — day statuses (and the counts derived from
 * them) brought up to date with this session's writes. Lets the review sheet
 * and "Approve" act on a day the office just took back or sent in, while the
 * page's own copy still shows it sent back / as a draft.
 */
export function withSessionDays(worker: WeeklyWorkerHours, session: SessionDays): WeeklyWorkerHours {
  return effectiveWorker(worker, {}, session);
}

/**
 * The worker with EVERY day at its effective status — the session's writes
 * and the per-worker overlay both applied. What the finale's approved list is
 * built from, so a person approved a moment ago is on it before the page's
 * copy catches up.
 */
export function effectiveWorker(
  worker: WeeklyWorkerHours,
  overlay: WorkerOverlay,
  session: SessionDays,
): WeeklyWorkerHours {
  let changed = false;
  const days = worker.days.map((d) => {
    const s = effectiveDayStatus(worker.workerId, d, overlay, session);
    if (s === d.status) return d;
    changed = true;
    return { ...d, status: s };
  });
  if (!changed) return worker;
  const count = (s: WeeklyDayStatus) => days.filter((d) => d.status === s).length;
  const approved = days.filter((d) => d.status === "approved");
  return {
    ...worker,
    days,
    approvedCount: approved.length,
    approvedHours: Math.round(approved.reduce((n, d) => n + (d.hours ?? 0), 0) * 100) / 100,
    submittedCount: count("submitted"),
    rejectedCount: count("rejected"),
    draftCount: count("draft"),
    missingCount: count("missing"),
  };
}

const KIND_ORDER: HoldUpKind[] = ["failed", "waiting", "sentBack", "draft", "missing"];

/**
 * Every hold-up in the week, one line per worker per kind, people A→Z and the
 * kinds in fix order. `failed` holds the reason an approve this session didn't
 * go through, per worker — that worker's undecided days read "didn't go
 * through" instead of plain "waiting".
 */
export function weekHoldUps(
  workers: ReadonlyArray<WeeklyWorkerHours>,
  overlay: WorkerOverlay,
  session: SessionDays,
  failed: Readonly<Record<string, string | undefined>> = {},
): HoldUpLine[] {
  const lines: HoldUpLine[] = [];
  for (const w of workers) {
    const groups = new Map<HoldUpKind, { dates: string[]; hours: number }>();
    const add = (kind: HoldUpKind, day: WeeklyHoursDay) => {
      const g = groups.get(kind) ?? { dates: [], hours: 0 };
      g.dates.push(day.date);
      g.hours += day.hours ?? 0;
      groups.set(kind, g);
    };
    for (const d of w.days) {
      const s = effectiveDayStatus(w.workerId, d, overlay, session);
      if (s === "submitted") add(failed[w.workerId] ? "failed" : "waiting", d);
      else if (s === "rejected") add("sentBack", d);
      else if (s === "draft") add("draft", d);
      else if (s === "missing") add("missing", d);
    }
    for (const kind of KIND_ORDER) {
      const g = groups.get(kind);
      if (!g) continue;
      const dates = [...g.dates].sort();
      lines.push({
        workerId: w.workerId,
        workerName: w.workerName,
        kind,
        dates,
        days: dates.map(shortDayLabel).join(", "),
        hours: Math.round(g.hours * 100) / 100,
        ...(kind === "failed" && failed[w.workerId] ? { why: failed[w.workerId] } : {}),
      });
    }
  }
  return lines.sort(
    (a, b) =>
      a.workerName.localeCompare(b.workerName) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}

/** Lines that hold the send — days mid-flight that the office can settle now. */
export function holdsTheSend(line: HoldUpLine): boolean {
  return line.kind === "failed" || line.kind === "waiting" || line.kind === "sentBack";
}

export function dayCount(lines: ReadonlyArray<HoldUpLine>): number {
  return lines.reduce((n, l) => n + l.dates.length, 0);
}

/** What the line says, after the name — the same reasons the emailed sheet's
 *  "Not on this sheet" list prints, plus the session's own "didn't go through". */
export const HOLD_UP_REASON: Record<HoldUpKind, string> = {
  failed: "approve didn't go through",
  waiting: "waiting for approval",
  sentBack: "sent back for a fix",
  draft: "saved but not sent in",
  missing: "nothing logged",
};

/** One plain sentence under the line: what's going on and what the button does. */
export function holdUpHelp(line: HoldUpLine): string {
  const first = line.workerName.split(" ")[0] || line.workerName;
  switch (line.kind) {
    case "failed":
      return `${line.why ? `${line.why} ` : ""}Nothing's lost — approve again.`;
    case "waiting":
      return "Not decided yet. Approve it, or check the days first.";
    case "sentBack":
      return `Waiting on ${first} to fix it. Take it back to approve or fix it yourself.`;
    case "draft":
      return `${first} saved it but never sent it in. Send it in for them, then approve.`;
    case "missing":
      return "No hours to pay. It's named on the sheet so Tia knows.";
  }
}

/**
 * Split a bulk-approve result into what is now approved and what really
 * failed. A day the server reports as ALREADY approved is done, not a failure:
 * that is exactly what a retry after "no answer — it may not have gone
 * through" finds when the first approve did land, and calling it an error
 * left the boss staring at a pop-up for a day that was fine (2026-10-12).
 */
export function settleApproveResult(result: {
  approved: ReadonlyArray<{ userId: string; date: string }>;
  failed: ReadonlyArray<{ userId: string | null; date: string | null; error: string; code?: unknown }>;
}): {
  done: Array<{ userId: string; date: string }>;
  failed: Array<{ userId: string | null; date: string | null; error: string; code?: unknown }>;
} {
  const done = result.approved.map((a) => ({ userId: a.userId, date: a.date }));
  const failed: Array<{ userId: string | null; date: string | null; error: string; code?: unknown }> = [];
  for (const f of result.failed) {
    if (f.userId && f.date && /status: approved\)/.test(f.error)) done.push({ userId: f.userId, date: f.date });
    else failed.push(f);
  }
  return { done, failed };
}

/**
 * Same settlement for a bulk send-back (2026-10-15): a day the server says is
 * ALREADY rejected is done — a retry after "no answer" finds exactly that —
 * never a failure the boss has to look at.
 */
export function settleRejectResult(result: {
  rejected: ReadonlyArray<{ userId: string; date: string }>;
  failed: ReadonlyArray<{ userId: string | null; date: string | null; error: string; code?: unknown }>;
}): {
  done: Array<{ userId: string; date: string }>;
  failed: Array<{ userId: string | null; date: string | null; error: string; code?: unknown }>;
} {
  const done = result.rejected.map((r) => ({ userId: r.userId, date: r.date }));
  const failed: Array<{ userId: string | null; date: string | null; error: string; code?: unknown }> = [];
  for (const f of result.failed) {
    if (f.userId && f.date && /status: rejected\)/.test(f.error)) done.push({ userId: f.userId, date: f.date });
    else failed.push(f);
  }
  return { done, failed };
}
