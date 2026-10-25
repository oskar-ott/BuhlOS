"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  MAX_HOURS_PER_DAY,
  STANDARD_DAY_HOURS,
  STANDARD_DAY_MINUTES,
} from "@/domains/timesheets/service";
import {
  MAX_OT_HOURS,
  OT_PRESET_MINUTES,
  dayDate,
  hoursFromMinutes,
  minutesFromHours,
  otPresetLabel,
  splitLabel,
  weekdayName,
  weekdayTotalFromOt,
} from "@/domains/timesheets/hours-view";
import type { HoursProblem } from "@/domains/timesheets/problem";
import { HmField } from "./HmField";
import { HoursSheet, type SheetFooter } from "./HoursSheet";

/**
 * The hours sheet (docs/phil-hours.md), in four variants that share one body:
 *
 *   weekday   "Custom or OT": standard day + OT chips, exact OT h+m, a short
 *             day behind "Worked less than a standard day?" (kept from the
 *             old form — a half day is real), a note, then review + Send.
 *   weekend   "Set Saturday's hours": hours worked h+m — every hour is OT.
 *   change    "Change these hours" on a waiting day: the weekday body
 *             pre-filled with what was sent; the review says "instead of".
 *   leave     a waiting leave day's hours: plain hours, no OT (leave pays
 *             ordinary), same "instead of" review.
 *
 * `onSubmit` receives the DERIVED total (decimal hours, 2dp) and the note;
 * the worker never types a total they computed. In `pick` mode the sheet
 * hands the hours back to its opener (the Fix sheet) instead of sending.
 */
export type OtSheetVariant = "weekday" | "weekend" | "change" | "leave";

export interface OtSheetProps {
  open: boolean;
  onClose: () => void;
  variant: OtSheetVariant;
  date: string;
  /** "Bondi switchboard" / "Sick day" — for the subtitle and the review. */
  target: string;
  /** What was sent (change / leave variants). */
  sentHours?: number | null;
  /** Hand hours back instead of sending (the Fix sheet's hours row). */
  pick?: boolean;
  busy?: boolean;
  problem?: { problem: HoursProblem; onRetry?: (() => void) | null; retryLabel?: string } | null;
  onSubmit: (totalHours: number, note: string | null) => void;
}

const DAY_MAX_MINUTES = MAX_HOURS_PER_DAY * 60;
const MAX_OT_MINUTES = minutesFromHours(MAX_OT_HOURS);

export function OtSheet(props: OtSheetProps): ReactNode {
  const {
    open,
    onClose,
    variant,
    date,
    target,
    sentHours = null,
    pick = false,
    busy = false,
    problem,
  } = props;
  const sentMinutes = sentHours != null ? minutesFromHours(sentHours) : null;
  const weekdayLike = variant === "weekday" || variant === "change";

  // One source of truth per variant: OT minutes on a weekday-like sheet, total
  // minutes on a weekend / leave / short-day sheet. The chips and the exact
  // fields both write otMinutes; picking a chip clears exact, typing clears
  // chips — they are the same number, so there is nothing to disagree about.
  const [otMinutes, setOtMinutes] = useState<number>(() =>
    weekdayLike && sentMinutes != null ? Math.max(0, sentMinutes - STANDARD_DAY_MINUTES) : 0
  );
  const [exactOpen, setExactOpen] = useState<boolean>(
    () => weekdayLike && otMinutes > 0 && !OT_PRESET_MINUTES.includes(otMinutes as 30)
  );
  // Short day (weekday-like): a total UNDER the standard day, as hours worked.
  const [shortOpen, setShortOpen] = useState<boolean>(
    () => weekdayLike && sentMinutes != null && sentMinutes < STANDARD_DAY_MINUTES
  );
  const [shortMinutes, setShortMinutes] = useState<number>(() =>
    weekdayLike && sentMinutes != null && sentMinutes < STANDARD_DAY_MINUTES ? sentMinutes : 0
  );
  const [workedMinutes, setWorkedMinutes] = useState<number>(() =>
    !weekdayLike ? (sentMinutes ?? 0) : 0
  );
  const [note, setNote] = useState("");

  // The derived total, per variant.
  let totalHours: number;
  let overCap = false;
  let empty = false;
  if (variant === "weekend" || variant === "leave") {
    totalHours = hoursFromMinutes(workedMinutes);
    overCap = workedMinutes > DAY_MAX_MINUTES;
    empty = workedMinutes <= 0;
  } else if (shortOpen) {
    totalHours = hoursFromMinutes(shortMinutes);
    overCap = false;
    empty = shortMinutes <= 0;
  } else {
    const t = weekdayTotalFromOt(otMinutes);
    totalHours = t.totalHours;
    overCap = t.overCap;
  }
  const unchanged = sentHours != null && Math.abs(totalHours - sentHours) < 0.005;

  const day = weekdayName(date);
  const title =
    variant === "weekend"
      ? `Set ${day}'s hours`
      : variant === "change" || variant === "leave"
        ? "Change these hours"
        : "Custom or OT";
  const splitWords =
    variant === "leave" ? formatHoursLabel(totalHours) : splitLabel({ date, totalHours });
  const totalWords = formatHoursLabel(totalHours);
  const receipt =
    weekdayLike && totalHours > STANDARD_DAY_HOURS
      ? `${dayDate(date)} · ${target} · ${splitWords} · ${totalWords} total`
      : `${dayDate(date)} · ${target} · ${splitWords}`;

  const footer: SheetFooter = {
    problem: problem ?? null,
    review:
      sentHours != null
        ? { lead: `You're sending instead of ${formatHoursLabel(sentHours)}`, line: receipt }
        : { lead: "You're sending", line: receipt },
    reason: overCap
      ? variant === "weekend" || variant === "leave" || shortOpen
        ? `Most in a day: ${MAX_HOURS_PER_DAY}h. Take some off to send.`
        : `Most OT in a day: ${formatHoursLabel(MAX_OT_HOURS)} (${MAX_HOURS_PER_DAY}h day). Take some off to send.`
      : empty
        ? variant === "weekend"
          ? "Enter the hours you worked to send."
          : "Enter the hours to send."
        : unchanged
          ? `Nothing changed yet — the office already has ${formatHoursLabel(sentHours ?? 0)}.`
          : null,
    send: {
      label: pick
        ? `Use ${totalWords}`
        : sentHours != null
          ? `Send new hours · ${totalWords}`
          : variant === "weekend"
            ? `Send ${day} · ${splitWords}`
            : `Send ${day} · ${totalWords}`,
      sub: pick
        ? undefined
        : sentHours != null
          ? `${day} stays waiting on the office`
          : "Goes to the office",
      onClick: () => props.onSubmit(totalHours, note.trim() || null),
      busy,
      testId: "hours-ot-send",
    },
  };

  return (
    <HoursSheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle={`${dayDate(date)} · ${target}`}
      footer={footer}
      testId={`hours-sheet-${variant}`}
      nested={pick}
    >
      <div className="space-y-4">
        {sentHours != null ? (
          <p className="flex items-start gap-2 rounded-card bg-[#dbeafe] px-3 py-2.5 text-[14px] text-text">
            <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-state-info" />
            <span>
              {`Sent: ${formatHoursLabel(sentHours)}. The office will see the new hours instead.`}
            </span>
          </p>
        ) : null}

        {variant === "weekend" ? (
          <>
            <p className="flex items-start gap-2 rounded-card bg-[#dbeafe] px-3 py-2.5 text-[14px] text-text">
              <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-state-info" />
              <span>{`${day} — all of it counts as overtime`}</span>
            </p>
            <HmField
              label="Hours worked"
              minutes={workedMinutes}
              onChange={setWorkedMinutes}
              minuteStep={15}
              maxMinutes={DAY_MAX_MINUTES}
              hoursLabel="hours worked"
              minutesLabel="minutes worked"
              testId="hours-weekend-field"
            />
            <p
              className="font-display text-[18px] font-bold tabular-nums"
              data-testid="hours-derived"
            >
              {`→ ${splitWords}`}
            </p>
            <p className="text-[13px] text-text-muted">{`Most in a day: ${MAX_HOURS_PER_DAY}h`}</p>
          </>
        ) : variant === "leave" ? (
          <>
            <HmField
              label="Hours"
              minutes={workedMinutes}
              onChange={setWorkedMinutes}
              minuteStep={15}
              maxMinutes={DAY_MAX_MINUTES}
              testId="hours-leave-field"
            />
            <p
              className="font-display text-[18px] font-bold tabular-nums"
              data-testid="hours-derived"
            >
              {`→ ${totalWords}`}
            </p>
            <p className="text-[13px] text-text-muted">
              Leave pays ordinary hours — no overtime on a leave day.
            </p>
          </>
        ) : (
          <>
            <div>
              <p className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                Standard day plus overtime
              </p>
              <div
                role="group"
                aria-label="Overtime on top of the standard day"
                className="grid grid-cols-2 gap-2"
              >
                {OT_PRESET_MINUTES.map((mins) => {
                  const { lead, total } = otPresetLabel(mins);
                  const active = !shortOpen && otMinutes === mins;
                  return (
                    <button
                      key={mins}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setShortOpen(false);
                        setExactOpen(false);
                        setOtMinutes(mins);
                      }}
                      className={cn(
                        "flex min-h-[56px] items-center gap-2 rounded-card border px-3 py-2 text-left",
                        active
                          ? "border-brand-navy bg-brand-navy text-white"
                          : "border-border-strong bg-surface text-text active:bg-surface-subtle"
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                          active ? "border-white" : "border-border-strong"
                        )}
                      >
                        {active ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block font-display text-[16px] font-bold tabular-nums">
                          {lead}
                        </span>
                        <span
                          className={cn(
                            "block text-[13px] tabular-nums",
                            active ? "text-white/80" : "text-text-muted"
                          )}
                        >
                          {`→ ${total}`}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <Disclosure
              label="Exact overtime"
              open={exactOpen}
              onToggle={() => {
                setExactOpen((o) => !o);
                setShortOpen(false);
              }}
            >
              <HmField
                label="Overtime"
                minutes={otMinutes}
                onChange={(m) => {
                  setShortOpen(false);
                  setOtMinutes(m);
                }}
                minuteStep={5}
                maxMinutes={MAX_OT_MINUTES + 60}
                hoursLabel="overtime hours"
                minutesLabel="overtime minutes"
                testId="hours-ot-exact"
              />
              <p
                className="mt-3 font-display text-[18px] font-bold tabular-nums"
                data-testid="hours-derived"
              >
                {`→ ${totalWords} total`}
              </p>
              <p className="mt-1 text-[13px] text-text-muted">
                {`Most OT in a day: ${formatHoursLabel(MAX_OT_HOURS)} (${MAX_HOURS_PER_DAY}h day)`}
              </p>
            </Disclosure>

            <Disclosure
              label="Worked less than a standard day?"
              open={shortOpen}
              onToggle={() => {
                const next = !shortOpen;
                setShortOpen(next);
                if (next) {
                  setExactOpen(false);
                  setOtMinutes(0);
                  if (shortMinutes <= 0) setShortMinutes(STANDARD_DAY_MINUTES - 60);
                }
              }}
            >
              <HmField
                label="Hours worked"
                minutes={shortMinutes}
                onChange={(m) => setShortMinutes(Math.min(m, STANDARD_DAY_MINUTES))}
                minuteStep={15}
                maxMinutes={STANDARD_DAY_MINUTES}
                hoursLabel="hours worked"
                minutesLabel="minutes worked"
                testId="hours-short-day"
              />
              <p className="mt-3 font-display text-[18px] font-bold tabular-nums">{`→ ${totalWords}`}</p>
              <p className="mt-1 text-[13px] text-text-muted">
                {`A short day is the time worked, under the standard ${formatHoursLabel(STANDARD_DAY_HOURS)}.`}
              </p>
            </Disclosure>

            {variant === "change" ? (
              <p className="text-[13px] text-text-muted">
                Wrong job, or not a work day? Ask the office — only the hours can change here.
              </p>
            ) : null}
          </>
        )}

        <label className="block">
          <span className="mb-1 block text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            Add a note
          </span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="Optional — one line for the office"
            className="h-12 w-full rounded-card border border-border-strong bg-surface px-3 text-[15px] text-text focus:border-brand-navy focus:outline-none"
          />
        </label>
      </div>
    </HoursSheet>
  );
}

function Disclosure({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="rounded-card border border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-[48px] w-full items-center justify-between px-3 text-left font-display text-[15px] font-semibold text-text"
      >
        {label}
        <ChevronDown
          aria-hidden="true"
          className={cn("h-5 w-5 text-text-muted transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? <div className="border-t border-border px-3 pb-3 pt-3">{children}</div> : null}
    </div>
  );
}
