"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  amendDiaryEntry,
  createDiaryEntry,
  fetchAttendancePrefill,
  type AttendancePrefillRow,
} from "@/domains/diary/client";
import { sydneyToday } from "@/domains/diary/date-key";
import {
  amendmentChangeLabel,
  attendanceSummary,
  isAmended,
  latestValue,
} from "@/domains/diary/format";
import type { DiaryEntry } from "@/domains/diary/types";

/**
 * Site diary (#210) — the job's daily record. The office's contemporaneous
 * record (delay-claim evidence), so the integrity rules are visible AND honoured
 * in the UI: a date with no entry renders "No diary entry" (never fabricated);
 * weekends are NOT auto-filled; delay-flagged + amended entries are styled; the
 * original fields of an amended entry stay visible WITH the amendment beneath.
 *
 * The editor pre-fills the day's attendance from the documented lookup
 * (GET /api/site-visits) — if that pre-fetch fails we show a NAMED
 * "attendance pre-fill unavailable" warning rather than a silent empty list (P7).
 *
 * Archived job → read-only (no create / amend). Phil write is deferred — there
 * is no field create path.
 */

interface Props {
  jobId: string;
  jobName: string;
  initialEntries: DiaryEntry[];
  fetchError: string | null;
  /** Archived job → the diary is read-only (history only). */
  readOnly?: boolean;
}

interface DraftAttendanceRow extends AttendancePrefillRow {
  /** Unticked rows are excluded from the saved snapshot (e.g. wrong allocation). */
  included: boolean;
}

export function JobDiary({ jobId, jobName, initialEntries, fetchError, readOnly = false }: Props) {
  const [entries, setEntries] = useState<DiaryEntry[]>(initialEntries);
  const [error, setError] = useState<string | null>(fetchError);

  // Sorted newest-date first (the server already sorts; re-sort defensively).
  const sorted = useMemo(
    () => entries.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [entries],
  );

  function upsertEntry(next: DiaryEntry) {
    setEntries((prev) => {
      const i = prev.findIndex((e) => e.id === next.id);
      if (i === -1) return [next, ...prev];
      const copy = prev.slice();
      copy[i] = next;
      return copy;
    });
  }

  return (
    <div className="space-y-5" data-testid="job-diary">
      <header className="space-y-1">
        <h2 className="font-display text-lg font-semibold text-text">
          Site diary &mdash; {jobName}
        </h2>
        <p className="text-sm text-text-muted">
          The day-by-day record of what happened on site &mdash; weather, who was on, what
          got done, and any delay. This is the office&rsquo;s contemporaneous record and
          doubles as delay-claim evidence, so each day is written once and amended in
          the open (never overwritten).
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {error}
        </p>
      ) : null}

      {readOnly ? (
        <p className="rounded-card border border-dashed border-border bg-surface-subtle p-3 text-sm text-text-muted">
          This job is archived &mdash; the diary is read-only.
        </p>
      ) : (
        <NewEntryForm
          jobId={jobId}
          existingDates={new Set(entries.map((e) => e.date))}
          onSaved={(entry) => {
            upsertEntry(entry);
            setError(null);
          }}
          onError={setError}
        />
      )}

      <section className="space-y-3" aria-label="Diary entries">
        {sorted.length === 0 ? (
          <p
            data-testid="diary-empty"
            className="rounded-card border border-dashed border-border bg-surface p-6 text-sm text-text-muted"
          >
            No diary entries yet. A day with no entry shows as &ldquo;No diary
            entry&rdquo; &mdash; nothing is filled in for you.
          </p>
        ) : (
          <ul className="space-y-3">
            {sorted.map((entry) => (
              <li key={entry.id}>
                <EntryCard
                  entry={entry}
                  jobId={jobId}
                  readOnly={readOnly}
                  onAmended={(next) => {
                    upsertEntry(next);
                    setError(null);
                  }}
                  onError={setError}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * New entry form (attendance pre-fill + happenings + delay + weather)
 * -------------------------------------------------------------------------- */

function NewEntryForm({
  jobId,
  existingDates,
  onSaved,
  onError,
}: {
  jobId: string;
  existingDates: Set<string>;
  onSaved: (entry: DiaryEntry) => void;
  onError: (msg: string | null) => void;
}) {
  const today = sydneyToday();
  const [date, setDate] = useState(today);
  const [happenings, setHappenings] = useState("");
  const [weatherNote, setWeatherNote] = useState("");
  const [delayFlagged, setDelayFlagged] = useState(false);
  const [delayReason, setDelayReason] = useState("");
  const [rows, setRows] = useState<DraftAttendanceRow[]>([]);
  const [prefillUnavailable, setPrefillUnavailable] = useState(false);
  const [prefillFetchedAt, setPrefillFetchedAt] = useState<string | null>(null);
  const [adjusted, setAdjusted] = useState(false);
  const [busy, setBusy] = useState(false);

  const duplicate = existingDates.has(date);
  const future = date > today;

  async function loadAttendance(forDate: string) {
    setPrefillUnavailable(false);
    try {
      const prefill = await fetchAttendancePrefill(jobId, forDate);
      setRows(prefill.map((r) => ({ ...r, included: true })));
      setPrefillFetchedAt(new Date().toISOString());
      setAdjusted(false);
    } catch {
      // P7: NAMED warning, never a silent empty list.
      setRows([]);
      setPrefillFetchedAt(null);
      setPrefillUnavailable(true);
    }
  }

  function onChangeDate(next: string) {
    setDate(next);
    if (next && !existingDates.has(next) && next <= today) {
      void loadAttendance(next);
    } else {
      setRows([]);
      setPrefillFetchedAt(null);
      setPrefillUnavailable(false);
    }
  }

  function toggleRow(userId: string) {
    setRows((prev) =>
      prev.map((r) => (r.userId === userId ? { ...r, included: !r.included } : r)),
    );
    setAdjusted(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!happenings.trim()) {
      onError("Write what happened on site before saving.");
      return;
    }
    if (delayFlagged && !delayReason.trim()) {
      onError("A flagged delay needs a reason.");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const entry = await createDiaryEntry(jobId, {
        date,
        happenings: happenings.trim(),
        weatherNote: weatherNote.trim() || null,
        delay: { flagged: delayFlagged, reason: delayFlagged ? delayReason.trim() : null },
        attendance: rows
          .filter((r) => r.included)
          .map(({ userId, userName, hours, status }) => ({ userId, userName, hours, status })),
        attendanceSource: { fetchedAt: prefillFetchedAt, adjusted },
      });
      onSaved(entry);
      // Reset to a fresh blank form.
      setHappenings("");
      setWeatherNote("");
      setDelayFlagged(false);
      setDelayReason("");
      setRows([]);
      setPrefillFetchedAt(null);
      setAdjusted(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't save the diary entry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      data-testid="diary-new-form"
      className="space-y-4 rounded-card border border-border bg-surface p-4"
    >
      <h3 className="font-display text-base font-semibold text-text">Add today&rsquo;s entry</h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-text">Date</span>
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => onChangeDate(e.target.value)}
            className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-text">Weather</span>
          <input
            type="text"
            value={weatherNote}
            onChange={(e) => setWeatherNote(e.target.value)}
            placeholder="e.g. Fine, 22°C; rain after 2pm"
            className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
      </div>

      {future ? (
        <p role="alert" className="text-sm text-amber-900">
          A diary entry can&rsquo;t be dated in the future.
        </p>
      ) : null}
      {duplicate ? (
        <p role="alert" className="text-sm text-amber-900">
          There&rsquo;s already a diary entry for {date}. Amend that entry below instead of
          writing a new one.
        </p>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text">Attendance</legend>
        {prefillUnavailable ? (
          <p
            data-testid="attendance-prefill-unavailable"
            role="alert"
            className="rounded-card border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900"
          >
            Attendance pre-fill unavailable &mdash; we couldn&rsquo;t reach the
            attendance lookup. You can still write the entry; add who was on site by hand
            from your records.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-text-muted">
            No attendance found for this day. Pick a date to pre-fill from the hours
            already logged.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-card border border-border">
            {rows.map((r) => (
              <li key={r.userId} className="flex items-center gap-3 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={r.included}
                  onChange={() => toggleRow(r.userId)}
                  aria-label={`Include ${r.userName}`}
                />
                <span className="flex-1 text-text">{r.userName}</span>
                <span className="text-text-muted">{r.hours}h</span>
                <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-xs text-text-muted">
                  {r.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-text">What happened on site</span>
        <textarea
          value={happenings}
          onChange={(e) => setHappenings(e.target.value)}
          rows={4}
          maxLength={5000}
          placeholder="Work done, deliveries, visitors, instructions, anything notable."
          className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm"
        />
      </label>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium text-text">
          <input
            type="checkbox"
            checked={delayFlagged}
            onChange={(e) => setDelayFlagged(e.target.checked)}
          />
          Flag a delay
        </label>
        {delayFlagged ? (
          <textarea
            value={delayReason}
            onChange={(e) => setDelayReason(e.target.value)}
            rows={2}
            placeholder="What caused the delay? (required)"
            className="w-full rounded-input border border-amber-300 bg-amber-50 px-3 py-2 text-sm"
            aria-label="Delay reason"
          />
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-3">
        <button
          type="submit"
          disabled={busy || duplicate || future}
          className="rounded-button bg-brand-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save diary entry"}
        </button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------------------
 * One entry card (original fields visible, amendments appended beneath)
 * -------------------------------------------------------------------------- */

function EntryCard({
  entry,
  jobId,
  readOnly,
  onAmended,
  onError,
}: {
  entry: DiaryEntry;
  jobId: string;
  readOnly: boolean;
  onAmended: (next: DiaryEntry) => void;
  onError: (msg: string | null) => void;
}) {
  const [amending, setAmending] = useState(false);
  const amended = isAmended(entry);
  const delayFlagged = Boolean(entry.delay?.flagged);

  return (
    <article
      data-testid="diary-entry"
      data-delay={delayFlagged ? "true" : "false"}
      data-amended={amended ? "true" : "false"}
      className={`rounded-card border bg-surface p-4 ${
        delayFlagged ? "border-amber-300" : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold text-text">{entry.date}</span>
        {delayFlagged ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
            Delay flagged
          </span>
        ) : null}
        {amended ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
            Amended
          </span>
        ) : null}
        <span className="ml-auto text-xs text-text-muted">{attendanceSummary(entry)}</span>
      </div>

      {entry.weatherNote ? (
        <p className="mt-2 text-xs text-text-muted">Weather: {entry.weatherNote}</p>
      ) : null}

      {/* The ORIGINAL happenings — never mutated, always visible. */}
      <p className="mt-2 whitespace-pre-wrap text-sm text-text">{entry.happenings}</p>

      {delayFlagged && entry.delay?.reason ? (
        <p className="mt-2 rounded-card bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-semibold">Delay: </span>
          {entry.delay.reason}
        </p>
      ) : null}

      {entry.attendance && entry.attendance.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2 text-xs text-text-muted">
          {entry.attendance.map((r) => (
            <li
              key={r.userId}
              className="rounded-full bg-surface-subtle px-2 py-0.5"
              data-testid="diary-attendance-row"
            >
              {r.userName} · {r.hours}h · {r.status}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-2 text-xs text-text-muted">
        Written by {entry.createdByName} · {String(entry.createdAt).slice(0, 10)}
        {entry.attendanceSource?.adjusted ? " · attendance adjusted by hand" : ""}
      </p>

      {/* Amendments appended BENEATH the original — append-only, original intact. */}
      {amended ? (
        <ol className="mt-3 space-y-2 border-t border-dashed border-border pt-3">
          {entry.amendments.map((a) => (
            <li key={a.id} data-testid="diary-amendment" className="text-sm">
              <p className="text-xs font-semibold text-text-muted">
                Amendment ({amendmentChangeLabel(a)}) · {a.createdByName} ·{" "}
                {String(a.createdAt).slice(0, 10)}
              </p>
              {typeof a.changes.happenings === "string" ? (
                <p className="mt-1 whitespace-pre-wrap text-text">
                  {a.changes.happenings as string}
                </p>
              ) : null}
              {Object.prototype.hasOwnProperty.call(a.changes, "weatherNote") ? (
                <p className="mt-1 text-text-muted">
                  Weather: {(a.changes.weatherNote as string | null) ?? "—"}
                </p>
              ) : null}
              {a.changes.delay ? (
                <p className="mt-1 text-amber-900">
                  Delay {(a.changes.delay as { flagged?: boolean }).flagged ? "flagged" : "cleared"}
                  {(a.changes.delay as { reason?: string | null }).reason
                    ? `: ${(a.changes.delay as { reason?: string | null }).reason}`
                    : ""}
                </p>
              ) : null}
              {a.note ? <p className="mt-1 text-xs text-text-muted">Note: {a.note}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}

      {!readOnly ? (
        amending ? (
          <AmendForm
            entry={entry}
            jobId={jobId}
            onDone={(next) => {
              if (next) onAmended(next);
              setAmending(false);
            }}
            onError={onError}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAmending(true)}
            className="mt-3 text-sm font-semibold text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            Amend this entry
          </button>
        )
      ) : null}
    </article>
  );
}

function AmendForm({
  entry,
  jobId,
  onDone,
  onError,
}: {
  entry: DiaryEntry;
  jobId: string;
  onDone: (next: DiaryEntry | null) => void;
  onError: (msg: string | null) => void;
}) {
  const current = latestValue(entry, "happenings") as string;
  const [happenings, setHappenings] = useState(current);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!happenings.trim() || happenings.trim() === current.trim()) {
      onError("Change the happenings text to amend the entry.");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const next = await amendDiaryEntry(jobId, {
        id: entry.id,
        note: note.trim() || null,
        changes: { happenings: happenings.trim() },
      });
      onDone(next);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't amend the entry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-2 border-t border-dashed border-border pt-3">
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-text">Amended happenings</span>
        <textarea
          value={happenings}
          onChange={(e) => setHappenings(e.target.value)}
          rows={3}
          maxLength={5000}
          className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm"
        />
      </label>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why are you amending? (optional)"
        className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm"
        aria-label="Amendment note"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => onDone(null)}
          className="rounded-button px-3 py-1.5 text-sm text-text-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded-button bg-brand-navy px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Amending…" : "Save amendment"}
        </button>
      </div>
    </form>
  );
}
