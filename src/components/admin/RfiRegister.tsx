"use client";

import { useState, type FormEvent } from "react";
import { answerRfi, closeRfi, fetchRfis, raiseRfi, sendRfi } from "@/domains/rfi/client";
import { isOverdue, sortForRegister } from "@/domains/rfi/logic";
import { RFI_STATUS_LABEL, type Rfi, type RfiStatus } from "@/domains/rfi/schema";

/**
 * The per-job RFI register (#276): raise a question, send it to the builder,
 * chase overdue ones, record the answer, close. Overdue RFIs sort first.
 */
type Filter = "all" | RfiStatus | "overdue";

export function RfiRegister({
  jobId,
  initialRfis,
  fetchError,
}: {
  jobId: string;
  initialRfis: Rfi[];
  fetchError: string | null;
}) {
  const [rfis, setRfis] = useState<Rfi[]>(initialRfis);
  const [error, setError] = useState<string | null>(fetchError);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const [subject, setSubject] = useState("");
  const [question, setQuestion] = useState("");
  const [askedOf, setAskedOf] = useState("");
  const [responseDue, setResponseDue] = useState("");

  // Inline per-RFI action input ({id, kind} + the text being typed).
  const [active, setActive] = useState<{ id: string; kind: "answer" | "close" } | null>(null);
  const [draft, setDraft] = useState("");

  const today = new Date().toISOString().slice(0, 10);

  async function refresh() {
    setRfis((await fetchRfis(jobId)).rfis);
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function onRaise(e: FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !question.trim()) return;
    await run(async () => {
      await raiseRfi(jobId, {
        subject: subject.trim(),
        question: question.trim(),
        askedOf: askedOf.trim(),
        responseDue,
      });
      setSubject("");
      setQuestion("");
      setAskedOf("");
      setResponseDue("");
    });
  }

  const sorted = sortForRegister(rfis, today);
  const counts = {
    overdue: rfis.filter((r) => isOverdue(r, today)).length,
  };
  const shown = sorted.filter((r) =>
    filter === "all" ? true : filter === "overdue" ? isOverdue(r, today) : r.status === filter
  );

  const FILTERS: Filter[] = ["all", "open", "sent", "answered", "closed", "overdue"];

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">RFIs</h1>
        <p className="text-sm text-slate-500">
          Every question to the builder — logged, sent and chased from one place, so an unanswered
          RFI can&rsquo;t silently stall the job and every answer is on record.
        </p>
      </header>

      {error && (
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Raise */}
      <form onSubmit={onRaise} className="space-y-3 rounded-lg border border-slate-200 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Meter panel location"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Ask of (builder email)</span>
            <input
              value={askedOf}
              onChange={(e) => setAskedOf(e.target.value)}
              placeholder="pm@builder.com.au"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Question</span>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            placeholder="Drawing A-101 doesn't show where the main meter panel goes…"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Response due (optional)</span>
            <input
              type="date"
              value={responseDue}
              onChange={(e) => setResponseDue(e.target.value)}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !subject.trim() || !question.trim()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Raise RFI
          </button>
        </div>
      </form>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={
              "rounded-full px-3 py-1 text-xs font-medium " +
              (filter === f ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700")
            }
          >
            {f === "all"
              ? "All"
              : f === "overdue"
                ? `Overdue (${counts.overdue})`
                : RFI_STATUS_LABEL[f]}
          </button>
        ))}
      </div>

      {/* List */}
      {shown.length === 0 ? (
        <p className="text-sm text-slate-500">
          No RFIs{filter === "all" ? " on this job yet" : " in this view"}.
        </p>
      ) : (
        <ul className="space-y-3">
          {shown.map((r) => {
            const overdue = isOverdue(r, today);
            return (
              <li key={r.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-slate-900">
                    <span className="font-mono text-xs text-slate-500">{r.ref}</span> {r.subject}
                  </div>
                  <div className="flex items-center gap-2">
                    {overdue && (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                        Overdue
                      </span>
                    )}
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                      {RFI_STATUS_LABEL[r.status]}
                    </span>
                  </div>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{r.question}</p>
                <div className="mt-1 text-xs text-slate-500">
                  {r.askedOf ? `Asked of ${r.askedOf}` : "No recipient set"}
                  {r.responseDue ? ` · due ${r.responseDue}` : ""}
                  {r.sentAt ? " · sent" : ""}
                </div>
                {r.answer && (
                  <p className="mt-2 rounded bg-emerald-50 p-2 text-sm text-emerald-900">
                    <span className="font-medium">Answer:</span> {r.answer}
                  </p>
                )}

                {/* Actions */}
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.status === "open" && (
                    <button
                      type="button"
                      disabled={busy || !r.askedOf}
                      onClick={() => run(() => sendRfi(jobId, r.id))}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800 disabled:opacity-50"
                      title={r.askedOf ? "" : "Set a builder email first"}
                    >
                      Send to builder
                    </button>
                  )}
                  {r.status !== "closed" && (
                    <button
                      type="button"
                      onClick={() => {
                        setActive({ id: r.id, kind: "answer" });
                        setDraft("");
                      }}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800"
                    >
                      Record answer
                    </button>
                  )}
                  {r.status !== "closed" && (
                    <button
                      type="button"
                      onClick={() => {
                        if (r.answer) run(() => closeRfi(jobId, r.id));
                        else {
                          setActive({ id: r.id, kind: "close" });
                          setDraft("");
                        }
                      }}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800"
                    >
                      Close
                    </button>
                  )}
                </div>

                {active && active.id === r.id && (
                  <div className="mt-2 space-y-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={2}
                      placeholder={
                        active.kind === "answer"
                          ? "The builder's answer…"
                          : "Why it's no longer required…"
                      }
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy || !draft.trim()}
                        onClick={() =>
                          run(async () => {
                            if (active.kind === "answer")
                              await answerRfi(jobId, r.id, draft.trim());
                            else await closeRfi(jobId, r.id, { reason: draft.trim() });
                            setActive(null);
                            setDraft("");
                          })
                        }
                        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      >
                        {active.kind === "answer" ? "Save answer" : "Close RFI"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setActive(null)}
                        className="rounded-md px-3 py-1.5 text-sm text-slate-600"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
