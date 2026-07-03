"use client";

import { useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  citations,
  factNumbers,
  summariseJob,
  type JobSummaryResponse,
} from "@/domains/jobs/summary-client";

/**
 * "Where is this job at?" — the #173 AI summary affordance on the admin job hub.
 *
 * The FIRST UI consumer of the shipped #170 assistant endpoint. One click POSTs
 * to /api/ai-assistant?action=summarise-job and renders the model's prose plus
 * the REAL numbers it was shown (P7 — the prose never stands alone as the
 * source of a figure) and citation chips linking to the live hub panels.
 *
 * Flag-dark: the whole card renders only when the server resolved
 * `ai_assistant` on (the page passes `enabled`); when off the surface is
 * invisible — no button, no shell. This component assumes the flag is ON.
 *
 * Honest states (never a fake/fallback summary):
 *   - idle    → the Summarise button, nothing generated yet
 *   - loading → the button is busy; no stale content shown as fresh
 *   - ready   → prose + verbatim numbers + citations
 *   - error   → a real message keyed to the endpoint's status:
 *       503 → "AI isn't configured yet"
 *       502 → "couldn't generate a summary — try again"
 *       else → generic unavailable (403/404 shouldn't reach here — the card is
 *              flag-gated — but if the gate flips mid-session we fail honestly).
 */

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: JobSummaryResponse }
  | { kind: "error"; message: string };

function messageForStatus(status: number, code: unknown): string {
  if (status === 503 || code === "UNCONFIGURED") {
    return "AI isn't configured yet. Ask the office to add the assistant key, then try again.";
  }
  if (status === 502 || code === "PROVIDER_FAILED") {
    return "The assistant couldn't generate a summary. Try again in a moment.";
  }
  if (status === 403 || status === 404) {
    return "The assistant isn't available right now.";
  }
  return "Couldn't reach the assistant. Try again in a moment.";
}

export function JobSummaryCard({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function generate() {
    setState({ kind: "loading" });
    const res = await summariseJob(jobId);
    if (!res.ok) {
      const code =
        res.error.body && typeof res.error.body === "object"
          ? (res.error.body as { code?: unknown }).code
          : undefined;
      setState({ kind: "error", message: messageForStatus(res.error.status, code) });
      return;
    }
    setState({ kind: "ready", data: res.data });
  }

  const busy = state.kind === "loading";

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-1.5">
            <Sparkles aria-hidden="true" className="h-4 w-4 text-brand-navy" />
            Where is this job at?
          </CardTitle>
          <CardDescription className="mt-1">
            A one-tap AI summary from this job&rsquo;s real records — progress,
            labour, snags and observations. The figures below the summary are the
            actual counts, not the model&rsquo;s wording.
          </CardDescription>
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-ink focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Sparkles aria-hidden="true" className="h-4 w-4" />
          {busy
            ? "Summarising…"
            : state.kind === "ready"
              ? "Regenerate"
              : "Summarise"}
        </button>
      </div>

      {state.kind === "loading" ? (
        <p className="mt-4 text-sm text-text-muted" role="status">
          Reading this job&rsquo;s records and writing the summary…
        </p>
      ) : null}

      {state.kind === "error" ? (
        <div
          role="alert"
          className="mt-4 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {state.message}
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <SummaryBody data={state.data} jobId={jobId} />
      ) : null}
    </Card>
  );
}

function SummaryBody({ data, jobId }: { data: JobSummaryResponse; jobId: string }) {
  const facts = factNumbers(data.toolData, formatHoursLabel);
  const cites = citations(data.toolData, jobId);
  const generatedAt = new Date(data.generatedAt);

  return (
    <div className="mt-4 space-y-4">
      {/* The model's prose — a phrasing of the fact pack, never the source of a
          number on its own. */}
      <p className="whitespace-pre-line text-sm leading-relaxed text-text">
        {data.summary}
      </p>

      {/* P7: the REAL numbers, verbatim from the deterministic projections the
          model was shown. Empty domains are stated honestly, not faked to 0. */}
      <div>
        <h3 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          From the records
        </h3>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          {facts.map((f) => (
            <div key={f.label}>
              <dt className="text-xs text-text-muted">{f.label}</dt>
              <dd className={f.empty ? "text-text-muted" : "font-semibold text-text"}>
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Citations → the live hub panels the reader can open to verify. */}
      {cites.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Sources
          </span>
          {cites.map((c) =>
            c.href ? (
              <Link
                key={c.label}
                href={c.href}
                className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-text transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
              >
                {c.label}
              </Link>
            ) : (
              <Pill key={c.label} tone="neutral">
                {c.label}
              </Pill>
            ),
          )}
        </div>
      ) : null}

      <p className="text-xs text-text-muted">
        Generated{" "}
        {generatedAt.toLocaleString("en-AU", {
          timeZone: "Australia/Sydney",
          dateStyle: "medium",
          timeStyle: "short",
        })}{" "}
        · {data.model}. Hours shown are approved + awaiting-approval on this job,
        not a total ledger. AI can make mistakes — check the linked records.
      </p>
    </div>
  );
}
