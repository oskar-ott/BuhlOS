"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ExternalLink, Sparkles } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { DocumentUploadButton } from "./DocumentUploadButton";
import {
  AiDrawingsError,
  acceptRooms,
  fetchCountReview,
  reviewRoom,
} from "@/domains/ai-drawings/client";
import type { AcceptRoomsResponse, CountReviewPage } from "@/domains/ai-drawings/schema";
import { diffRoomsVsAcceptedAreas, type AcceptedAreaRef } from "@/domains/ai-drawings/room-rev-diff";
import { suggestTasksFromFittings } from "@/domains/ai-drawings/tasks-from-fittings";

/**
 * Plan Studio — the Job Builder's rooms→areas surface (#206), dark behind the
 * ai_drawings flag. It does NOT re-run or duplicate the shipped analysis/overlay
 * review (that lives on the job's Documents page and is reused via a link-out);
 * it is the ACCEPT step: the reviewed rooms an admin already confirmed become
 * real areas on the job's Structure.
 *
 * Honesty (P7): every room shows the model's confidence + review status; nothing
 * becomes an area without an explicit accept; where the extraction store isn't
 * reachable (preview/dev without Supabase) the panel says so rather than
 * pretending. AI proposes, human accepts.
 *
 * This is a functional harness — the visual design is being finished separately
 * in Claude Design; the client wiring (fetch/review/accept + honest states) is
 * what a restyle plugs into.
 */

const HIGH_CONFIDENCE = 0.8;

interface PlanRoomRow {
  id: string;
  planId: string;
  name: string;
  status: "suggested" | "accepted" | "edited" | "rejected";
  confidence: number | null;
  fittingCount: number;
}

type Load =
  | { phase: "loading" }
  | { phase: "unavailable"; message: string }
  | { phase: "error"; message: string }
  | { phase: "ready"; pages: CountReviewPage[] };

/** Plain-sentence action failures. The two states an admin can actually act on
 *  (budget cap, missing API key) get explicit copy; everything else surfaces the
 *  server's honest message with the caller's fallback. */
function actionErrorText(err: unknown, fallback: string): string {
  if (err instanceof AiDrawingsError && err.code === "CAP_REACHED") {
    return "This job has reached its AI budget cap — reviewing and accepting rooms already detected still works, but new AI analysis doesn't.";
  }
  if (err instanceof AiDrawingsError && err.code === "UNCONFIGURED") {
    return err.message; // already the friendly set-the-key sentence
  }
  return err instanceof Error ? err.message : fallback;
}

interface Props {
  jobId: string;
  /** Areas already accepted from plans (with provenance) — the set the detected
   *  rooms are diffed against to surface plan-rev changes (renamed / removed). */
  acceptedAreas: AcceptedAreaRef[];
  /** ai_plan_tasks flag — gates the review-only "tasks from fittings" section. */
  planTasksEnabled: boolean;
  /** Called after areas are created so the builder can reload the job + banner. */
  onAreasCreated: (summary: AcceptRoomsResponse) => void;
  /** Bump to refetch the detected rooms (e.g. the in-builder analysis panel just
   *  mapped new rooms). Optional — omitted everywhere else, behaviour unchanged. */
  refreshToken?: number;
}

export function PlanStudioPanel({
  jobId,
  acceptedAreas,
  planTasksEnabled,
  onAreasCreated,
  refreshToken = 0,
}: Props) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedChanges, setDismissedChanges] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const res = await fetchCountReview(jobId);
      setLoad({ phase: "ready", pages: res.pages });
    } catch (err) {
      if (err instanceof AiDrawingsError && err.code === "UNCONFIGURED") {
        // Missing ANTHROPIC_API_KEY — a different problem (and fix) from the
        // store being absent; the client's message says exactly what to set.
        setLoad({ phase: "unavailable", message: err.message });
        return;
      }
      if (err instanceof AiDrawingsError && err.code === "STORE_UNAVAILABLE") {
        setLoad({
          phase: "unavailable",
          message:
            "The AI drawings store isn't available in this environment. Analyse plans on a deploy with the store, then accept rooms here.",
        });
        return;
      }
      setLoad({
        phase: "error",
        message: err instanceof Error ? err.message : "Couldn't load detected rooms.",
      });
    }
  }, [jobId]);

  useEffect(() => {
    void refresh();
    // refreshToken: the builder bumps it when the analysis panel below mints new
    // rooms, so this accept list never goes stale after an in-place analyse.
  }, [refresh, refreshToken]);

  const rooms: PlanRoomRow[] =
    load.phase === "ready"
      ? load.pages.flatMap((p) =>
          (p.rooms ?? []).map((r) => ({
            id: r.id,
            planId: p.planId,
            name: r.effectiveName,
            status: r.status,
            confidence: r.confidence,
            fittingCount: (p.byRoom ?? []).find((b) => b.roomId === r.id)?.total ?? 0,
          })),
        )
      : [];

  // #206 re-analysis — how the latest plan differs from the areas already
  // accepted (renamed / removed). Added rooms are actionable in the list below;
  // nothing here changes an accepted area automatically ("never overwrite").
  const diff = diffRoomsVsAcceptedAreas({
    rooms:
      load.phase === "ready"
        ? load.pages.flatMap((p) =>
            (p.rooms ?? []).map((r) => ({
              roomId: r.id,
              planId: p.planId,
              name: r.effectiveName,
              bbox: r.effectiveBbox,
              status: r.status,
            })),
          )
        : [],
    accepted: acceptedAreas,
  });
  const changes = [
    ...diff.renamed.map((p) => ({
      key: `ren:${p.area.areaId}`,
      label: `“${p.area.name}” may be renamed to “${p.room.name}” on the latest plan`,
    })),
    ...diff.removed.map((a) => ({
      key: `rem:${a.areaId}`,
      label: `“${a.name}” isn’t on the current plan anymore`,
    })),
  ].filter((c) => !dismissedChanges.has(c.key));
  const dismissChange = (key: string) => setDismissedChanges((s) => new Set(s).add(key));

  // #213 — review-only task suggestions from the detected fitting counts
  // (aggregated across every sheet's by-room totals). Gated on its OWN flag.
  const fittingCounts = new Map<string, number>();
  if (planTasksEnabled && load.phase === "ready") {
    for (const p of load.pages) {
      for (const br of p.byRoom ?? []) {
        for (const e of br.entries) {
          if (e.label && e.count > 0) {
            fittingCounts.set(e.label, (fittingCounts.get(e.label) ?? 0) + e.count);
          }
        }
      }
    }
  }
  const taskSuggestions = suggestTasksFromFittings(
    Array.from(fittingCounts, ([label, count]) => ({ label, count })),
  );
  const hasTaskSuggestions =
    taskSuggestions.roughIn.length + taskSuggestions.fitOff.length + taskSuggestions.unmatched.length > 0;

  const suggested = rooms.filter((r) => r.status === "suggested");
  const reviewed = rooms.filter((r) => r.status === "accepted" || r.status === "edited");
  const highConfidenceSuggested = suggested.filter(
    (r) => (r.confidence ?? 0) >= HIGH_CONFIDENCE,
  );

  const runAction = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await fn();
      } catch (err) {
        setActionError(actionErrorText(err, "That action failed."));
      } finally {
        // Refresh in FINALLY, not only on success: a bulk action (accept-all)
        // can half-apply before failing, so always re-sync to the server's
        // real state rather than leaving a stale list under an error banner.
        await refresh();
        setBusy(false);
      }
    },
    [refresh],
  );

  const reviewOne = (roomId: string, status: "accepted" | "rejected") =>
    void runAction(() => reviewRoom(jobId, roomId, status));

  const acceptAllHighConfidence = () =>
    void runAction(async () => {
      for (const r of highConfidenceSuggested) {
        await reviewRoom(jobId, r.id, "accepted");
      }
    });

  const createAreas = () =>
    void (async () => {
      setBusy(true);
      setActionError(null);
      try {
        const summary = await acceptRooms(jobId); // accept-all-reviewed mode
        await refresh();
        onAreasCreated(summary);
      } catch (err) {
        setActionError(actionErrorText(err, "Couldn't create areas — nothing was changed."));
      } finally {
        setBusy(false);
      }
    })();

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-accent-yellow" aria-hidden="true" />
              <CardTitle>Plan Studio</CardTitle>
              <Pill tone="neutral">AI — review &amp; accept</Pill>
            </div>
            <CardDescription className="mt-1">
              Upload a plan, run the analysis below, then turn the rooms the AI read into
              this job&rsquo;s areas. Nothing is created until you accept it.
            </CardDescription>
          </div>
          <DocumentUploadButton jobId={jobId} defaultCategory="plan" />
        </div>
        <div className="mt-3">
          <Link
            href={`/v2/jobs/${jobId}/documents` as Route}
            className="inline-flex items-center gap-1.5 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            Open the full plan review (analyse sheets, overlays, fittings)
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </Card>

      {changes.length > 0 ? (
        <Card className="border-state-warning" data-testid="plan-studio-changes">
          <CardTitle>Changes vs your accepted areas</CardTitle>
          <CardDescription className="mt-1">
            The latest plan differs from areas you already accepted. Nothing changes
            automatically — review, then rename or archive the area in Structure.
          </CardDescription>
          <ul className="mt-3 divide-y divide-border">
            {changes.map((c) => (
              <li key={c.key} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="text-text">{c.label}</span>
                <Button variant="ghost" size="sm" onClick={() => dismissChange(c.key)}>
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {load.phase === "loading" ? (
        <Card>
          <p className="text-sm text-text-muted" role="status">
            Loading detected rooms…
          </p>
        </Card>
      ) : null}

      {load.phase === "unavailable" ? (
        <Card className="border-state-warning">
          <CardTitle>Rooms review isn&rsquo;t available here</CardTitle>
          <CardDescription className="mt-1">{load.message}</CardDescription>
        </Card>
      ) : null}

      {load.phase === "error" ? (
        <Card className="border-state-danger" role="alert">
          <CardTitle>Couldn&rsquo;t load detected rooms</CardTitle>
          <CardDescription className="mt-1">{load.message}</CardDescription>
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        </Card>
      ) : null}

      {load.phase === "ready" ? (
        <Card data-testid="plan-studio-rooms">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Rooms detected on this job&rsquo;s plans</CardTitle>
              <CardDescription className="mt-1">
                {rooms.length === 0
                  ? "No rooms yet. Upload a plan, then run Analyse in the analysis panel below — detected rooms appear here to accept."
                  : `${reviewed.length} reviewed · ${suggested.length} awaiting review`}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refresh()}
                disabled={busy}
                aria-label="Refresh the detected rooms"
                data-testid="plan-studio-refresh"
              >
                Refresh
              </Button>
              {highConfidenceSuggested.length > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={acceptAllHighConfidence}
                  disabled={busy}
                  data-testid="plan-studio-accept-high"
                >
                  Accept all high-confidence ({highConfidenceSuggested.length})
                </Button>
              ) : null}
              {reviewed.length > 0 ? (
                <Button
                  size="sm"
                  onClick={createAreas}
                  disabled={busy}
                  data-testid="plan-studio-create-areas"
                >
                  {busy
                    ? "Creating areas…"
                    : `Create ${reviewed.length} area${reviewed.length === 1 ? "" : "s"} from reviewed rooms`}
                </Button>
              ) : null}
            </div>
          </div>

          {actionError ? (
            <p className="mt-3 rounded-card border border-state-danger px-3 py-2 text-sm text-state-danger" role="alert">
              {actionError}
            </p>
          ) : null}

          {rooms.length > 0 ? (
            <ul className="mt-3 divide-y divide-border">
              {rooms.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <span className="font-medium text-text">{r.name}</span>
                    <span className="ml-2 text-xs text-text-muted">
                      {r.confidence != null ? `${Math.round(r.confidence * 100)}% confidence` : "added by hand"}
                      {r.fittingCount > 0 ? ` · ${r.fittingCount} fitting${r.fittingCount === 1 ? "" : "s"}` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={r.status === "suggested" ? "neutral" : r.status === "rejected" ? "danger" : "success"}>
                      {r.status === "suggested"
                        ? "AI suggestion"
                        : r.status === "accepted"
                          ? "Accepted"
                          : r.status === "rejected"
                            ? "Rejected"
                            : r.status === "edited"
                              ? "Edited"
                              : r.status}
                    </Pill>
                    {r.status === "suggested" ? (
                      <>
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => reviewOne(r.id, "accepted")}>
                          Accept
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => reviewOne(r.id, "rejected")}>
                          Reject
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {planTasksEnabled && hasTaskSuggestions ? (
        <Card data-testid="plan-studio-task-suggestions">
          <CardTitle>Suggested tasks from fittings</CardTitle>
          <CardDescription className="mt-1">
            Derived from the detected fitting counts. Review-only — add the ones you want as
            job-level tasks in the Structure tab. Nothing is added automatically.
          </CardDescription>
          {taskSuggestions.roughIn.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Rough-in</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-text">
                {taskSuggestions.roughIn.map((t) => (
                  <li key={t.name}>{t.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {taskSuggestions.fitOff.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Fit-off</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-text">
                {taskSuggestions.fitOff.map((t) => (
                  <li key={t.name}>{t.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {taskSuggestions.unmatched.length > 0 ? (
            <p className="mt-3 text-xs text-text-muted">
              {taskSuggestions.unmatched.length} fitting type
              {taskSuggestions.unmatched.length === 1 ? "" : "s"} didn&rsquo;t map to a standard task — add
              those by hand.
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
