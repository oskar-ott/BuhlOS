"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";

/**
 * #171 — the office daily summary card on /reports (flag
 * ai_office_daily_summary, admin-tier, dark by default — the page only
 * renders this when the flag is on for the viewer).
 *
 * Honesty contract, rendered:
 *   - the fact lines are deterministic and each links to the records behind it
 *   - the AI narrative is garnish on top; the footer says whether AI worded it
 *     (and why it fell back when it did not)
 *   - the coverage footer states what the summary does and does NOT see,
 *     including anything it could not read
 *   - a quiet day says so — no filler activity
 */

export interface SummaryLine {
  text: string;
  href: string;
}

export interface StoredOfficeSummary {
  date: string;
  generatedAt: string;
  quietDay: boolean;
  lines: SummaryLine[];
  narrative: string | null;
  phrasing: "ai" | "deterministic" | "none";
  model: string | null;
  fallbackReason?: string | null;
  facts?: { quietJobs?: Array<{ jobId: string; jobName: string }> };
  coverage?: {
    sees: string[];
    doesNotSee: string[];
    scannedJobs: number;
    totalActiveJobs: number;
    jobsUnreadable: number;
    entriesUnreadable: number;
  };
}

interface Props {
  date: string;
  summary: StoredOfficeSummary | null;
}

export function OfficeDailySummaryCard({ date, summary }: Props) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/office-daily-summary?action=generate", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error || `Generate failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch {
      setError("Generate failed — network error");
    } finally {
      setRunning(false);
    }
  }

  const quietJobs = summary?.facts?.quietJobs ?? [];
  const unreadable =
    (summary?.coverage?.jobsUnreadable ?? 0) > 0 || (summary?.coverage?.entriesUnreadable ?? 0) > 0;

  return (
    <Card data-testid="office-daily-summary-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>Yesterday across jobs</CardTitle>
          <CardDescription className="mt-1">
            The morning recap of {summary?.date ?? date} — hours, snags, evidence
            and blockers, every line straight from the records it links to.
          </CardDescription>
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={running}
          className="shrink-0 rounded-card border border-border bg-brand-navy px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {running ? "Working…" : summary ? "Regenerate" : "Generate summary"}
        </button>
      </div>

      {error ? <p className="mt-3 text-sm text-state-danger">{error}</p> : null}

      {!summary ? (
        <p className="mt-3 text-sm text-text-muted">
          No summary generated for {date} yet.
        </p>
      ) : (
        <>
          {summary.narrative ? (
            <p className="mt-3 text-sm text-text">{summary.narrative}</p>
          ) : null}

          {summary.quietDay ? (
            <p className="mt-3 text-sm text-text-muted">
              Quiet day — no hours, snags, evidence or blockers were recorded. No filler.
            </p>
          ) : null}

          <ul className="mt-3 space-y-2">
            {summary.lines.map((l, i) => (
              <li key={`${l.href}-${i}`} className="flex items-start gap-2 text-sm text-text">
                <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-navy" />
                <span>
                  {l.text}{" "}
                  <Link
                    href={l.href as Route}
                    className="font-medium text-brand-navy underline underline-offset-2"
                  >
                    View
                  </Link>
                </span>
              </li>
            ))}
          </ul>

          {!summary.quietDay && quietJobs.length > 0 ? (
            <p className="mt-3 text-xs text-text-muted">
              No activity recorded: {quietJobs.map((j) => j.jobName).join(", ")}.
            </p>
          ) : null}

          <p className="mt-3 text-xs text-text-muted">
            {summary.phrasing === "ai"
              ? `Worded by AI (${summary.model}) from the facts — validated so every number traces back.`
              : summary.phrasing === "deterministic"
                ? `Deterministic wording${summary.fallbackReason ? ` — AI phrasing unavailable: ${summary.fallbackReason}` : ""}.`
                : "Nothing to phrase."}{" "}
            Generated {new Date(summary.generatedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}.
          </p>

          {summary.coverage ? (
            <p className="mt-2 border-t border-border pt-2 text-xs text-text-muted">
              Sees: {summary.coverage.sees.join("; ")}. Does not see:{" "}
              {summary.coverage.doesNotSee.join("; ")}. Scanned{" "}
              {summary.coverage.scannedJobs} of {summary.coverage.totalActiveJobs} active jobs.
              {unreadable ? (
                <span className="text-state-danger">
                  {" "}
                  Incomplete: {summary.coverage.jobsUnreadable} job record
                  {summary.coverage.jobsUnreadable === 1 ? "" : "s"} and{" "}
                  {summary.coverage.entriesUnreadable} timesheet
                  {summary.coverage.entriesUnreadable === 1 ? "" : "s"} could not be read.
                </span>
              ) : null}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
