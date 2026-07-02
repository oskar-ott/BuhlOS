"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilNotice } from "./ui/PhilNotice";
import { deriveRowStatus } from "@/domains/test-records/derive";
import {
  REPORT_TYPES,
  TEST_TYPES,
  type ReportType,
  type TestRecordRow,
  type TestRecordRowInput,
  type TestStatus,
  type TestType,
} from "@/domains/test-records/schema";

/**
 * Phil — structured electrical test capture (#517).
 *
 * Opened from the task's "Proof needed" list when the required item is a
 * `test_result` (the photo/note CaptureSheet handles photo/note proof). The
 * worker records measured circuit readings; the SERVER re-derives pass/fail
 * authoritatively on save — the live status shown here is DISPLAY ONLY
 * (`deriveRowStatus`, the one shared rule), so the worker sees their number land
 * pass or fail before they submit, but never asserts it.
 *
 * Constitution: it enters ONE slot — the proof-capture sheet for a `test_result`
 * requirement (P10, no new job-screen section). Site language, numeric keypads,
 * no enterprise jargon (P11). It invents NO numbers — pass/fail is empty until
 * the worker types a reading and a limit (P7). Names the principle it serves in
 * this header per the Phil agent rules.
 *
 * One circuit at a time: the worker fills a row, taps "Add another circuit" to
 * start the next. The minimum is one row with a circuit name; min/max are
 * operator-entered (the office authors no per-test limit yet).
 */

const TEST_TYPE_LABEL: Record<TestType, string> = {
  continuity_r1r2: "Continuity (R1+R2)",
  continuity_r2: "Continuity (R2)",
  ring_continuity: "Ring continuity",
  insulation_resistance: "Insulation resistance",
  polarity: "Polarity",
  earth_fault_loop_zs: "Earth loop (Zs)",
  earth_electrode_resistance: "Earth electrode",
  prospective_fault_current: "Fault current (PFC)",
  rcd_trip_time: "RCD trip time",
  rcd_trip_current: "RCD trip current",
  functional: "Functional check",
  other: "Other",
};

const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  eicr: "Condition report (EICR)",
  eic: "Installation cert (EIC)",
  minor_works: "Minor works",
  other: "Other",
};

/** A unit hint per test type (a default the worker can override). Empty = unitless
 *  (e.g. polarity / functional are a yes-no, no measured value). */
const UNIT_HINT: Partial<Record<TestType, string>> = {
  continuity_r1r2: "Ω",
  continuity_r2: "Ω",
  ring_continuity: "Ω",
  insulation_resistance: "MΩ",
  earth_fault_loop_zs: "Ω",
  earth_electrode_resistance: "Ω",
  prospective_fault_current: "kA",
  rcd_trip_time: "ms",
  rcd_trip_current: "mA",
};

/** A row in the capture form (strings — the worker is typing). */
interface RowState {
  circuit: string;
  testType: TestType;
  value: string;
  unit: string;
  min: string;
  max: string;
}

export interface TestRecordDraft {
  reportType: ReportType;
  tester: string;
  testedAt: string;
  /** Submit-shape rows (the server re-derives each row's status on save). */
  rows: TestRecordRowInput[];
}

function emptyRow(): RowState {
  return { circuit: "", testType: "insulation_resistance", value: "", unit: "MΩ", min: "", max: "" };
}

/** Parse a typed number field — empty/garbage → null (never a coerced 0 that
 *  could read as a real measurement, mirroring the server criteria rule). */
function num(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Build the submit draft from the form rows (only rows with a circuit name). */
function toDraft(reportType: ReportType, tester: string, testedAt: string, rows: RowState[]): TestRecordDraft {
  return {
    reportType,
    tester: tester.trim(),
    testedAt,
    rows: rows
      .filter((r) => r.circuit.trim() !== "")
      .map((r) => ({
        circuit: r.circuit.trim(),
        testType: r.testType,
        value: num(r.value),
        unit: r.unit.trim() || null,
        min: num(r.min),
        max: num(r.max),
      })),
  };
}

const STATUS_LABEL: Record<TestStatus, string> = {
  pass: "Pass",
  fail: "Fail",
  na: "Not judged",
};

export function PhilTestRecordCard({
  open,
  jobName,
  requirementLabel,
  defaultTester,
  saving = false,
  errorMessage,
  savedResult = null,
  onClose,
  onSubmit,
  onReportDefect,
}: {
  open: boolean;
  jobName: string;
  /** The required-evidence label this test satisfies (e.g. "Circuit test result"). */
  requirementLabel?: string;
  /** Pre-fill the tester from the signed-in worker's name (editable). */
  defaultTester?: string;
  /** True while the parent's submit→mint→link round-trip is in flight. */
  saving?: boolean;
  /** A worker-facing error from the parent (save/link failure). */
  errorMessage?: string | null;
  /** #520: set by the parent AFTER a successful save when the SERVER-derived
   *  record has failed circuits — the card shows the failed rows and offers
   *  "Report defect" instead of silently closing. Null = close as before. */
  savedResult?: { recordId: string; failedRows: TestRecordRow[] } | null;
  onClose: () => void;
  onSubmit: (draft: TestRecordDraft) => void;
  /** #520: raise the defect a failed circuit implies (parent opens the
   *  existing Report snag sheet pre-filled with these real readings). */
  onReportDefect?: (prefill: { title: string; description: string }) => void;
}) {
  const [reportType, setReportType] = useState<ReportType>("eicr");
  const [tester, setTester] = useState(defaultTester ?? "");
  const [rows, setRows] = useState<RowState[]>([emptyRow()]);
  // testedAt defaults to now, captured once when the sheet opens.
  const openedAtRef = useRef<string>(new Date().toISOString());

  useEffect(() => {
    if (!open) return;
    openedAtRef.current = new Date().toISOString();
    setReportType("eicr");
    setTester(defaultTester ?? "");
    setRows([emptyRow()]);
  }, [open, defaultTester]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // #520: post-submit result view — the record saved but the server derived
  // failed circuits. Shown ONLY when there is a real fail (P10 — a clean pass
  // closes exactly as before, zero new chrome). One tap raises the defect.
  if (savedResult && savedResult.failedRows.length > 0) {
    return (
      <SavedFailView
        jobName={jobName}
        failedRows={savedResult.failedRows}
        onClose={onClose}
        onReportDefect={onReportDefect}
      />
    );
  }

  function setRow(i: number, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }
  function removeRow(i: number) {
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  const namedRows = rows.filter((r) => r.circuit.trim() !== "");
  const canSubmit = !saving && tester.trim() !== "" && namedRows.length > 0;

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit(toDraft(reportType, tester, openedAtRef.current, rows));
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Record test results"
      data-testid="test-record-card"
      className="fixed inset-0 z-50 flex flex-col bg-surface-raised pb-[env(safe-area-inset-bottom)]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border bg-surface-raised px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-semibold text-text">Record test results</h2>
          <p className="truncate text-xs text-text-muted">
            {requirementLabel ? `${requirementLabel} · ` : ""}
            {jobName}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={cn(
            "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-card",
            "text-text-muted hover:bg-surface-subtle",
          )}
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-lg space-y-5">
          {errorMessage ? (
            <PhilNotice tone="danger" role="alert">
              {errorMessage}
            </PhilNotice>
          ) : null}

          {/* Who + what report. */}
          <div className="grid grid-cols-1 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-text">Who tested</span>
              <input
                value={tester}
                onChange={(e) => setTester(e.target.value)}
                placeholder="Your name"
                data-testid="test-record-tester"
                className="w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-text">Report</span>
              <select
                value={reportType}
                onChange={(e) => setReportType(e.target.value as ReportType)}
                className="w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
              >
                {REPORT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {REPORT_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Circuits — one at a time. */}
          <ul className="space-y-3">
            {rows.map((row, i) => {
              // DISPLAY-ONLY derivation — the server re-derives on save. Shows the
              // worker whether their reading lands pass/fail against the limit they
              // entered, before they submit.
              const status = deriveRowStatus({
                circuit: row.circuit || "x",
                testType: row.testType,
                value: num(row.value),
                min: num(row.min),
                max: num(row.max),
              });
              return (
                <li
                  key={i}
                  data-testid="test-record-row"
                  className="space-y-3 rounded-card border border-border bg-surface p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-[12px] uppercase tracking-wider text-text-muted">
                      Circuit {i + 1}
                    </span>
                    {rows.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => removeRow(i)}
                        className="min-h-[36px] rounded-pill px-2 text-xs font-semibold text-text-muted hover:bg-surface-subtle"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>

                  <label className="block text-sm">
                    <span className="mb-1 block font-medium text-text">Circuit</span>
                    <input
                      value={row.circuit}
                      onChange={(e) => setRow(i, { circuit: e.target.value })}
                      placeholder="e.g. Ring final — kitchen sockets"
                      data-testid="test-record-circuit"
                      className="w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
                    />
                  </label>

                  <label className="block text-sm">
                    <span className="mb-1 block font-medium text-text">Test</span>
                    <select
                      value={row.testType}
                      onChange={(e) => {
                        const next = e.target.value as TestType;
                        setRow(i, { testType: next, unit: UNIT_HINT[next] ?? "" });
                      }}
                      className="w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
                    >
                      {TEST_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {TEST_TYPE_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block text-sm">
                      <span className="mb-1 block font-medium text-text">Reading</span>
                      <input
                        inputMode="decimal"
                        value={row.value}
                        onChange={(e) => setRow(i, { value: e.target.value })}
                        placeholder="—"
                        data-testid="test-record-value"
                        className="w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
                      />
                    </label>
                    <label className="block text-sm">
                      <span className="mb-1 block font-medium text-text">Unit</span>
                      <input
                        value={row.unit}
                        onChange={(e) => setRow(i, { unit: e.target.value })}
                        placeholder="e.g. MΩ"
                        className="w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block text-sm">
                      <span className="mb-1 block font-medium text-text">Pass at least</span>
                      <input
                        inputMode="decimal"
                        value={row.min}
                        onChange={(e) => setRow(i, { min: e.target.value })}
                        placeholder="min"
                        data-testid="test-record-min"
                        className="w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
                      />
                    </label>
                    <label className="block text-sm">
                      <span className="mb-1 block font-medium text-text">Pass at most</span>
                      <input
                        inputMode="decimal"
                        value={row.max}
                        onChange={(e) => setRow(i, { max: e.target.value })}
                        placeholder="max"
                        data-testid="test-record-max"
                        className="w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
                      />
                    </label>
                  </div>

                  {/* Live derived status — DISPLAY ONLY. Hidden until there is
                      something to judge, so the worker never sees a fake verdict. */}
                  {status !== "na" ? (
                    <p
                      data-testid="test-record-row-status"
                      className={cn(
                        "inline-flex items-center rounded-pill px-2.5 py-1 text-sm font-semibold",
                        status === "pass"
                          ? "bg-state-success/15 text-state-success"
                          : "bg-state-danger/15 text-state-danger",
                      )}
                    >
                      {STATUS_LABEL[status]}
                    </p>
                  ) : (
                    <p className="text-xs text-text-muted">
                      Enter a reading and a pass limit to see pass or fail.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            onClick={addRow}
            className="min-h-[44px] w-full rounded-card border border-dashed border-border px-4 text-sm font-semibold text-text hover:bg-surface-subtle"
          >
            + Add another circuit
          </button>
        </div>
      </div>

      <footer className="border-t border-border bg-surface-raised px-4 py-3">
        <div className="mx-auto max-w-lg">
          <PhilActionButton onClick={handleSubmit} disabled={!canSubmit} data-testid="test-record-submit">
            {saving ? "Saving…" : "Save test"}
          </PhilActionButton>
          {!canSubmit && !saving ? (
            <p className="mt-2 text-center text-xs text-text-muted">
              Add who tested and at least one circuit to save.
            </p>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

/* ---------------------------------------------------------------------
 * #520 — saved-with-failures view + defect prefill
 * -------------------------------------------------------------------*/

/** One plain-language line per failed circuit — the ACTUAL reading vs. the
 *  limits the worker entered, nothing invented (P7). */
function failedRowLine(row: TestRecordRow): string {
  const label = TEST_TYPE_LABEL[row.testType] ?? row.testType;
  const unit = row.unit ? ` ${row.unit}` : "";
  const reading = row.value == null ? "no reading" : `${row.value}${unit}`;
  const limits: string[] = [];
  if (row.min != null) limits.push(`≥ ${row.min}`);
  if (row.max != null) limits.push(`≤ ${row.max}`);
  const limitText = limits.length ? ` (pass ${limits.join(", ")}${unit})` : "";
  return `${row.circuit} — ${label}: ${reading}${limitText}`;
}

/** Build the snag prefill from the failed rows. The Report snag sheet caps
 *  title/description and keeps both editable. */
export function defectPrefillFromFailedRows(
  failedRows: TestRecordRow[],
): { title: string; description: string } {
  const first = failedRows[0];
  const extra = failedRows.length - 1;
  return {
    title: `Failed test: ${first?.circuit ?? "circuit"}${extra > 0 ? ` +${extra} more` : ""}`,
    description: failedRows.map(failedRowLine).join("\n"),
  };
}

function SavedFailView({
  jobName,
  failedRows,
  onClose,
  onReportDefect,
}: {
  jobName: string;
  failedRows: TestRecordRow[];
  onClose: () => void;
  onReportDefect?: (prefill: { title: string; description: string }) => void;
}) {
  const n = failedRows.length;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Test saved — failed circuits"
      data-testid="test-record-card"
      className="fixed inset-0 z-50 flex flex-col bg-surface-raised pb-[env(safe-area-inset-bottom)]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border bg-surface-raised px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-semibold text-text">Test saved</h2>
          <p className="truncate text-xs text-text-muted">{jobName}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={cn(
            "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-card",
            "text-text-muted hover:bg-surface-subtle",
          )}
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-lg space-y-4">
          <PhilNotice tone="danger" role="alert">
            {n === 1 ? "1 circuit failed." : `${n} circuits failed.`} A failed
            reading usually means something to fix — you can raise it now.
          </PhilNotice>

          <ul className="space-y-2" data-testid="test-record-failed-rows">
            {failedRows.map((row, i) => (
              <li
                key={i}
                className="rounded-card border border-border bg-surface p-3 text-sm text-text"
              >
                {failedRowLine(row)}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <footer className="border-t border-border bg-surface-raised px-4 py-3">
        <div className="mx-auto max-w-lg space-y-2">
          {onReportDefect ? (
            <PhilActionButton
              onClick={() => onReportDefect(defectPrefillFromFailedRows(failedRows))}
              data-testid="test-record-report-defect"
            >
              Report defect
            </PhilActionButton>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] w-full rounded-card border border-border px-4 text-sm font-semibold text-text hover:bg-surface-subtle"
          >
            Done
          </button>
        </div>
      </footer>
    </div>
  );
}
