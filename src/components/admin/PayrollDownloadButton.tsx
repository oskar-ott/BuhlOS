"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { ProblemDialog } from "@/components/ui/ProblemDialog";
import type { HoursProblem } from "@/domains/timesheets/problem";
import {
  allSkippable,
  unreadableDayLabel,
  type UnreadableDay,
} from "@/domains/timesheets/payroll-refusal";
import { downloadPayrollFile, payrollSheetUrl } from "./payrollDownload";

/**
 * One payroll download that can't dead-end (owner pull 2026-10-12). Replaces a
 * plain link: a refused download used to open a page of JSON. Now:
 *   - hours still saving → "Waiting for the hours to save — it downloads by
 *     itself", then it does;
 *   - a day that can't be read (PDF) → names it and offers "Download without
 *     it" — the sheet prints it under "Not on this sheet";
 *   - anything else → the plain-words pop-up, the same words left inline, and
 *     the button stays live (a download stamps nothing, so trying again is safe).
 */
export function PayrollDownloadButton({
  fromDate,
  toDate,
  format,
  shape,
  label,
  fallbackFilename,
  testId,
  className,
}: {
  fromDate: string;
  toDate: string;
  format: "pdf" | "csv";
  shape?: "review" | "xero";
  label: string;
  fallbackFilename: string;
  testId?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [settleWaitMs, setSettleWaitMs] = useState<number | null>(null);
  const [problem, setProblem] = useState<HoursProblem | null>(null);
  const [problemOpen, setProblemOpen] = useState(false);
  const [unreadable, setUnreadable] = useState<UnreadableDay[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = async (skip: string[] = []) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setProblemOpen(false);
    setSettleWaitMs(null);
    const out = await downloadPayrollFile({
      url: payrollSheetUrl({ fromDate, toDate, format, shape, skip }),
      fallbackFilename,
      onSettling: (ms) => {
        if (alive.current) setSettleWaitMs(ms);
      },
      isActive: () => alive.current,
    });
    if (!alive.current || !out) return;
    setBusy(false);
    setSettleWaitMs(null);
    if (out.ok) {
      setUnreadable([]);
      return;
    }
    setProblem(out.problem);
    setProblemOpen(true);
    // Only the PDF can leave a day off — it's the sheet that names it.
    setUnreadable(format === "pdf" ? out.unreadable : []);
  };

  const canLeaveOff = allSkippable(unreadable);

  return (
    <div className="space-y-1.5">
      {/* A real link (works without script, can be opened in a new tab); a
          normal click goes through the fetch above so a refusal is explained,
          never a page of JSON. */}
      <a
        href={payrollSheetUrl({ fromDate, toDate, format, shape })}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          void run();
        }}
        aria-disabled={busy || undefined}
        data-testid={testId}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-card border border-border px-3 py-2 text-sm font-medium text-text hover:border-brand-navy aria-disabled:opacity-70",
          className,
        )}
      >
        {busy ? (
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <Download aria-hidden="true" className="h-4 w-4" />
        )}
        {label}
      </a>
      {settleWaitMs != null ? (
        <p role="status" data-testid={testId ? `${testId}-settling` : undefined} className="text-xs text-text-muted">
          Waiting for just-approved hours to save — it downloads by itself in about{" "}
          {Math.ceil(settleWaitMs / 1000)} seconds.
        </p>
      ) : null}
      {problem && !busy ? (
        <div
          role="status"
          data-testid={testId ? `${testId}-problem` : undefined}
          className="max-w-md rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          <p className="font-semibold">{problem.title}.</p>
          <p className="mt-0.5">{problem.todo}</p>
          {unreadable.length > 0 ? (
            <ul className="mt-1 list-disc pl-4">
              {unreadable.map((d) => (
                <li key={d.key}>{unreadableDayLabel(d)}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {problem.canRetry ? (
              <button
                type="button"
                onClick={() => void run()}
                className="rounded-card border border-amber-300 bg-surface px-2.5 py-1 font-medium text-text"
              >
                Try again
              </button>
            ) : null}
            {canLeaveOff ? (
              <button
                type="button"
                data-testid={testId ? `${testId}-without` : undefined}
                onClick={() => void run(unreadable.map((d) => d.key))}
                className="rounded-card border border-amber-300 bg-surface px-2.5 py-1 font-medium text-text"
              >
                Download without {unreadable.length === 1 ? "it" : "them"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <ProblemDialog
        problem={problemOpen ? problem : null}
        onClose={() => setProblemOpen(false)}
        onRetry={() => void run()}
      />
    </div>
  );
}
