"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Camera, Loader2, MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { listJobs } from "@/domains/jobs/client";
import { captureHref, launcherDecision, type LauncherDecision } from "./philCapture";

interface Props {
  open: boolean;
  onClose: () => void;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; decision: LauncherDecision };

/**
 * Global Capture launcher — opened by the centre FAB in PhilTabBar so a
 * field worker can start a photo capture from anywhere in Phil (Today,
 * Gear, the jobs list) in one or two taps, instead of opening a job and
 * scrolling to the mid-page Capture block.
 *
 * Flow once the worker's jobs load (see philCaptureLauncher.ts):
 *   - no live jobs   → empty state
 *   - one live job   → skip the picker, deep-link straight to capture
 *   - many           → short job picker → deep-link
 *
 * The deep link is `/phil/jobs/<id>?capture=<token>`; the job detail
 * page reads the token and auto-opens the existing (fully wired,
 * persisted) CaptureSheet. No new persistence path is introduced.
 */
export function PhilCaptureLauncher({ open, onClose }: Props) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });
  // Guards against a stale fetch resolving after the sheet re-opens.
  const reqRef = useRef(0);

  const go = useCallback(
    (jobId: string) => {
      onClose();
      // `as Route` — captureHref builds a dynamic path string; Next's
      // typedRoutes can't statically verify it (same cast the admin
      // sidebar uses for dynamic hrefs).
      router.push(captureHref(jobId) as Route);
    },
    [onClose, router],
  );

  const load = useCallback(async () => {
    reqRef.current += 1;
    const seq = reqRef.current;
    setState({ kind: "loading" });
    const r = await listJobs();
    if (seq !== reqRef.current) return; // superseded by a newer open/retry
    if (!r.ok) {
      setState({
        kind: "error",
        message:
          r.error.status === 0
            ? "No connection. Check your signal and try again."
            : `Couldn't load your jobs (${r.error.status}). Try again.`,
      });
      return;
    }
    const decision = launcherDecision(r.data.jobs);
    if (decision.kind === "single") {
      go(decision.job.id);
      return;
    }
    setState({ kind: "ready", decision });
  }, [go]);

  useEffect(() => {
    if (open) {
      void load();
    } else {
      setState({ kind: "idle" });
    }
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Capture"
      className="fixed inset-0 z-50 flex items-end justify-center bg-accent-ink/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Camera aria-hidden="true" className="h-5 w-5 text-brand-navy" />
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

        <div className="px-4 py-4">
          {state.kind === "idle" || state.kind === "loading" ? (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-text-muted">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Loading your jobs…
            </p>
          ) : null}

          {state.kind === "error" ? (
            <div className="space-y-3">
              <p
                role="alert"
                className="rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
              >
                {state.message}
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

          {state.kind === "ready" && state.decision.kind === "empty" ? (
            <p className="rounded-card border border-dashed border-border bg-surface-subtle p-4 text-center text-sm text-text-muted">
              No jobs assigned to you yet. Ask your PM to add you to a job, then
              you can capture against it.
            </p>
          ) : null}

          {state.kind === "ready" && state.decision.kind === "choose" ? (
            <>
              <p className="text-sm text-text-muted">Which job is this for?</p>
              <ul className="mt-3 space-y-2">
                {state.decision.jobs.map((j) => (
                  <li key={j.id}>
                    <button
                      type="button"
                      onClick={() => go(j.id)}
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
                      <Camera aria-hidden="true" className="h-5 w-5 shrink-0 text-brand-navy" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
