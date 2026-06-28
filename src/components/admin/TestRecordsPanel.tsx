"use client";

import { useEffect, useState } from "react";
import {
  overallStatusWord,
  summariseTestRecord,
} from "@/domains/test-records/derive";
import {
  TestRecordStoreSchema,
  type TestRecord,
  type TestStatus,
} from "@/domains/test-records/schema";

/**
 * Office review of structured electrical test records (#517 — AC2).
 *
 * Read-only: an admin sees the circuits, the measured values, the SERVER-DERIVED
 * pass/fail, and who tested when. Records are immutable + supersede-by-revision —
 * a correction is a new record naming the one it replaces; the panel marks a
 * superseded record so the history reads honestly. The proof tick on /qa already
 * reflects at the requirement-met level via the shared rule (no /qa change): a
 * TestRecord satisfies its `test_result` requirement by minting a companion
 * EvidenceItem, so the existing met rule is untouched.
 */

const TEST_TYPE_LABEL: Record<string, string> = {
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

function StatusBadge({ status }: { status: TestStatus }) {
  const cls =
    status === "pass"
      ? "bg-emerald-100 text-emerald-800"
      : status === "fail"
        ? "bg-red-100 text-red-800"
        : "bg-slate-100 text-slate-600";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status === "na" ? "not judged" : status}
    </span>
  );
}

function valueText(row: TestRecord["rows"][number]): string {
  if (row.value == null) return "—";
  return `${row.value}${row.unit ? ` ${row.unit}` : ""}`;
}

function limitText(row: TestRecord["rows"][number]): string {
  const parts: string[] = [];
  if (row.min != null) parts.push(`≥ ${row.min}`);
  if (row.max != null) parts.push(`≤ ${row.max}`);
  return parts.length ? parts.join(", ") : "no limit set";
}

async function fetchTestRecords(jobId: string): Promise<TestRecord[]> {
  const res = await fetch(`/api/job-control/test-records?jobId=${encodeURIComponent(jobId)}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`Test records ${res.status}`);
  const body = await res.json();
  const parsed = TestRecordStoreSchema.safeParse({ records: body?.records ?? [] });
  return parsed.success ? parsed.data.records : [];
}

export function TestRecordsPanel({ jobId }: { jobId: string }) {
  const [records, setRecords] = useState<TestRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchTestRecords(jobId)
      .then((r) => {
        if (alive) setRecords(r);
      })
      .catch(() => {
        if (alive) setError("Couldn't load test records.");
      });
    return () => {
      alive = false;
    };
  }, [jobId]);

  // The set of records that have been superseded by a later correction.
  const supersededIds = new Set(
    (records ?? []).map((r) => r.supersedesId).filter((id): id is string => Boolean(id)),
  );

  return (
    <section className="space-y-4" data-testid="test-records-panel">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-slate-900">Electrical test results</h2>
        <p className="text-sm text-slate-500">
          Structured circuit results captured in the field. Read-only — pass/fail is derived from the
          measured values against their limits; a correction is a new record that supersedes the one it
          replaces (the original is kept).
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      {records == null && !error ? (
        <p className="text-sm text-slate-500" aria-busy="true">
          Loading test records…
        </p>
      ) : null}

      {records != null && records.length === 0 ? (
        <p className="text-sm text-slate-500">No test results recorded on this job yet.</p>
      ) : null}

      {records != null && records.length > 0 ? (
        <ul className="space-y-3">
          {records.map((rec) => {
            const superseded = supersededIds.has(rec.id);
            return (
              <li
                key={rec.id}
                data-testid="test-record"
                className={`rounded-lg border p-3 ${
                  superseded ? "border-slate-200 bg-slate-50 opacity-80" : "border-slate-200"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-medium text-slate-900">{summariseTestRecord(rec)}</span>{" "}
                    <span className="text-slate-500">
                      · {rec.tester} · {new Date(rec.testedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {rec.supersedesId ? (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                        correction
                      </span>
                    ) : null}
                    {superseded ? (
                      <span className="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-600">
                        superseded
                      </span>
                    ) : null}
                    <StatusBadge status={rec.overallStatus} />
                  </div>
                </div>

                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[36rem] text-left text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wide text-slate-400">
                        <th className="py-1 pr-3 font-medium">Circuit</th>
                        <th className="py-1 pr-3 font-medium">Test</th>
                        <th className="py-1 pr-3 font-medium">Reading</th>
                        <th className="py-1 pr-3 font-medium">Limit</th>
                        <th className="py-1 font-medium">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rec.rows.map((row, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="py-1.5 pr-3 text-slate-900">{row.circuit}</td>
                          <td className="py-1.5 pr-3 text-slate-600">
                            {TEST_TYPE_LABEL[row.testType] ?? row.testType}
                          </td>
                          <td className="py-1.5 pr-3 text-slate-900">{valueText(row)}</td>
                          <td className="py-1.5 pr-3 text-slate-500">{limitText(row)}</td>
                          <td className="py-1.5">
                            <StatusBadge status={row.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="mt-2 text-xs text-slate-400">
                  Overall {overallStatusWord(rec.overallStatus)}
                  {rec.note ? ` · ${rec.note}` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
