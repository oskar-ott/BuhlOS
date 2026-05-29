"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { ArrowLeft, Camera, CheckCircle2, ChevronRight, Loader2, MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { listJobs } from "@/domains/jobs/client";
import { createObservation } from "@/domains/observations/client";
import {
  WORKER_CAPTURE_OPTIONS,
  requiresActionForOption,
  type WorkerCaptureOption,
} from "@/domains/observations/service";
import {
  buildObservationPayload,
  captureHref,
  launcherDecision,
  type LaunchableJob,
} from "./philCapture";

interface Props {
  open: boolean;
  onClose: () => void;
  /** When the FAB is tapped on a job home we already know the job — skip the
   *  picker and go straight to the capture chooser for that job. */
  initialJobId?: string | null;
}

type Job0 = { id: string; name: string | null };

type View =
  | { v: "loading" }
  | { v: "error"; message: string }
  | { v: "empty" }
  | { v: "pick"; jobs: LaunchableJob[] }
  | { v: "chooser"; job: Job0 }
  | { v: "note"; job: Job0; option: WorkerCaptureOption }
  | { v: "done"; requiresAction: boolean };

const TITLE_MAX = 140;

/**
 * Global Capture launcher — opened by the centre FAB in PhilTabBar so a field
 * worker can capture site truth from anywhere in Phil in a couple of taps.
 *
 * Flow (capture-first, classify-simple):
 *   1. Resolve the job — known if launched from a job home, else pick from the
 *      worker's live jobs (one job auto-advances; none → empty state).
 *   2. Choose what it is:
 *        • Take a photo / evidence → deep-links to the existing, fully wired
 *          CaptureSheet (the evidence path is unchanged — no new persistence).
 *        • A plain-English classification (note, blocker, issue, need material,
 *          plan mismatch, builder said, safety, question, variation, not sure)
 *          → a quick note → POST /api/observations.
 *   3. Confirmation: "Sent to BuhlOS" (office review required) or "Saved to job
 *      history" (record-only), with an honest failure + retry on error.
 *
 * The worker never sees the internal observation type taxonomy — only the
 * WORKER_CAPTURE_OPTIONS labels (src/domains/observations/service.ts).
 */
export function PhilCaptureLauncher({ open, onClose, initialJobId }: Props) {
  const router = useRouter();
  // Derive the first view from initialJobId so a known job goes straight to the
  // chooser (no loading flash); the open-toggle effect below resets it on
  // re-open. The picker path starts on "loading" until listJobs resolves.
  const [view, setView] = useState<View>(
    initialJobId ? { v: "chooser", job: { id: initialJobId, name: null } } : { v: "loading" },
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Guards against a stale jobs fetch resolving after the sheet re-opens.
  const reqRef = useRef(0);

  const goEvidence = useCallback(
    (jobId: string) => {
      onClose();
      // `as Route` — captureHref builds a dynamic path string Next's
      // typedRoutes can't statically verify (same cast the admin sidebar uses).
      router.push(captureHref(jobId) as Route);
    },
    [onClose, router],
  );

  const load = useCallback(async () => {
    reqRef.current += 1;
    const seq = reqRef.current;
    setView({ v: "loading" });
    const r = await listJobs();
    if (seq !== reqRef.current) return; // superseded by a newer open/retry
    if (!r.ok) {
      setView({
        v: "error",
        message:
          r.error.status === 0
            ? "No connection. Check your signal and try again."
            : `Couldn't load your jobs (${r.error.status}). Try again.`,
      });
      return;
    }
    const decision = launcherDecision(r.data.jobs);
    if (decision.kind === "empty") setView({ v: "empty" });
    else if (decision.kind === "single") {
      setView({ v: "chooser", job: { id: decision.job.id, name: decision.job.name } });
    } else setView({ v: "pick", jobs: decision.jobs });
  }, []);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setSubmitError(null);
    setSubmitting(false);
    if (initialJobId) {
      setView({ v: "chooser", job: { id: initialJobId, name: null } });
    } else {
      void load();
    }
  }, [open, initialJobId, load]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const chooseOption = useCallback((job: Job0, option: WorkerCaptureOption) => {
    setTitle("");
    setDescription("");
    setSubmitError(null);
    setView({ v: "note", job, option });
  }, []);

  const submitNote = useCallback(
    async (job: Job0, option: WorkerCaptureOption) => {
      if (!title.trim()) return;
      setSubmitting(true);
      setSubmitError(null);
      const r = await createObservation(job.id, buildObservationPayload(option, title, description));
      setSubmitting(false);
      if (!r.ok) {
        setSubmitError(
          r.error.status === 0
            ? "No connection — your note wasn't sent. Try again when you've got signal."
            : `Couldn't send (${r.error.status}). Try again.`,
        );
        return;
      }
      setView({ v: "done", requiresAction: requiresActionForOption(option) });
    },
    [title, description],
  );

  if (!open) return null;

  const headerBack = view.v === "note" ? () => setView({ v: "chooser", job: view.job }) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Capture"
      className="fixed inset-0 z-50 flex items-end justify-center bg-accent-ink/40"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-t-2xl border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            {headerBack ? (
              <button
                type="button"
                onClick={headerBack}
                aria-label="Back"
                className="inline-flex h-9 w-9 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle"
              >
                <ArrowLeft aria-hidden="true" className="h-5 w-5" />
              </button>
            ) : (
              <Camera aria-hidden="true" className="h-5 w-5 text-brand-navy" />
            )}
            <h2 className="font-display text-lg text-text">Capture</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-11 w-11 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {view.v === "loading" ? (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-text-muted">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Loading your jobs…
            </p>
          ) : null}

          {view.v === "error" ? (
            <div className="space-y-3">
              <p
                role="alert"
                className="rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
              >
                {view.message}
              </p>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={() => void load()}
                className="w-full"
              >
                Try again
              </Button>
            </div>
          ) : null}

          {view.v === "empty" ? (
            <p className="rounded-card border border-dashed border-border bg-surface-subtle p-4 text-center text-sm text-text-muted">
              No jobs assigned to you yet. Ask your PM to add you to a job, then you can capture
              against it.
            </p>
          ) : null}

          {view.v === "pick" ? (
            <>
              <p className="text-sm text-text-muted">Which job is this for?</p>
              <ul className="mt-3 space-y-2">
                {view.jobs.map((j) => (
                  <li key={j.id}>
                    <button
                      type="button"
                      onClick={() => setView({ v: "chooser", job: { id: j.id, name: j.name } })}
                      className="flex w-full items-center gap-3 rounded-card border border-border bg-surface p-3 text-left hover:bg-surface-subtle"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-display text-sm font-semibold text-text">
                          {j.name}
                        </span>
                        {j.siteAddress ? (
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-text-muted">
                            <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{j.siteAddress}</span>
                          </span>
                        ) : null}
                      </span>
                      <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {view.v === "chooser" ? (
            <>
              {view.job.name ? (
                <p className="text-xs text-text-muted">
                  For <span className="font-semibold text-text">{view.job.name}</span>
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => goEvidence(view.job.id)}
                className="mt-2 flex w-full items-center gap-3 rounded-card border-2 border-brand-navy bg-brand-navy p-3 text-left text-text-inverse"
              >
                <Camera aria-hidden="true" className="h-5 w-5 shrink-0 text-accent-yellow" />
                <span className="min-w-0 flex-1">
                  <span className="block font-display text-sm font-semibold">
                    Take a photo / evidence
                  </span>
                  <span className="block text-xs text-text-inverse/80">
                    Proof of work — rough-in, fit-off, damage
                  </span>
                </span>
              </button>

              <p className="mt-4 text-xs uppercase tracking-wider text-text-muted">
                Or log something
              </p>
              <ul className="mt-2 space-y-2">
                {WORKER_CAPTURE_OPTIONS.map((o) => (
                  <li key={o.key}>
                    <button
                      type="button"
                      onClick={() => chooseOption(view.job, o)}
                      className="flex w-full items-center gap-3 rounded-card border border-border bg-surface p-3 text-left hover:bg-surface-subtle"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-display text-sm font-semibold text-text">
                          {o.label}
                        </span>
                        <span className="block text-xs text-text-muted">{o.hint}</span>
                      </span>
                      <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {view.v === "note" ? (
            <div className="space-y-3">
              <div>
                <p className="font-display text-base font-semibold text-text">{view.option.label}</p>
                <p className="text-xs text-text-muted">{view.option.hint}</p>
              </div>
              <label className="block">
                <span className="text-xs uppercase tracking-wider text-text-muted">
                  What&rsquo;s the gist?
                </span>
                <input
                  type="text"
                  value={title}
                  maxLength={TITLE_MAX}
                  autoFocus
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Short summary (e.g. cable path blocked at riser)"
                  className="mt-1 w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
                />
              </label>
              <label className="block">
                <span className="text-xs uppercase tracking-wider text-text-muted">
                  More detail (optional)
                </span>
                <textarea
                  value={description}
                  rows={3}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Anything the office needs to know"
                  className="mt-1 w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
                />
              </label>
              {requiresActionForOption(view.option) ? (
                <p className="text-xs text-text-muted">This goes to the office for review.</p>
              ) : (
                <p className="text-xs text-text-muted">This is saved to the job&rsquo;s history.</p>
              )}
              {submitError ? (
                <p
                  role="alert"
                  className="rounded-card border border-rose-200 bg-rose-50 p-2 text-sm text-rose-900"
                >
                  {submitError}
                </p>
              ) : null}
              <Button
                type="button"
                variant="primary"
                size="lg"
                className="w-full"
                disabled={!title.trim() || submitting}
                onClick={() => void submitNote(view.job, view.option)}
              >
                {submitting ? (
                  <>
                    <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  "Send to BuhlOS"
                )}
              </Button>
            </div>
          ) : null}

          {view.v === "done" ? (
            <div className="space-y-4 py-4 text-center">
              <CheckCircle2 aria-hidden="true" className="mx-auto h-12 w-12 text-emerald-500" />
              <div>
                <p className="font-display text-lg text-text">Sent to BuhlOS</p>
                <p className="mt-1 text-sm text-text-muted">
                  {view.requiresAction
                    ? "The office will review this — it's in their Observations inbox now."
                    : "Saved to this job's history."}
                </p>
              </div>
              <Button type="button" variant="primary" size="lg" className="w-full" onClick={onClose}>
                Done
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
