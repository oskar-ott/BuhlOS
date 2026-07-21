"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Image as ImageIcon, Link2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import {
  kindLabel,
  statusLabel,
  statusTone,
  type EvidenceStatusTone,
} from "@/domains/evidence/format";
import {
  flagAsBuiltEvidence,
  reviewEvidence,
  unlinkEvidence,
} from "@/domains/evidence/client";
import type { EvidenceItem } from "@/domains/evidence/types";
import { defectSuggestionFor } from "@/domains/evidence/defect-suggestions";
import { pairedIdSet } from "@/domains/evidence/pairing";
import { resolveEvidenceTargetParts } from "@/domains/evidence/target-label";
import type { Job } from "@/domains/jobs/types";
import { createSnag } from "@/domains/snags/client";
import type { CreateSnagPayload, SnagItem } from "@/domains/snags/types";
import {
  DEFAULT_FILTER,
  EvidenceFilterBar,
  matchesFilter,
  type FilterState,
} from "./EvidenceFilterBar";
import { EvidenceContextChips } from "./EvidenceContextChips";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { EvidenceLabelChips } from "./EvidenceLabelChips";
import { EvidenceRejectModal } from "./EvidenceRejectModal";
import { EvidenceUnreviewModal } from "./EvidenceUnreviewModal";
import {
  CLASSIFY_BATCH_MAX,
  apiErrorMessage,
  classifyEvidencePhotos,
  correctEvidenceLabels,
  dismissDefectSuggestion,
} from "./evidence-ai-client";
import { cn } from "@/lib/cn";

const PILL_TONE_MAP: Record<EvidenceStatusTone, "info" | "success" | "danger"> = {
  info: "info",
  success: "success",
  danger: "danger",
};

interface Props {
  job: Job;
  initialEvidence: ReadonlyArray<EvidenceItem>;
  fetchError: string | null;
  /** True when the viewer is an admin. False for LH (read-only). */
  isAdmin: boolean;
  /** Display name for banners ("Reviewed by Anna") — server fills the
   *  authoritative reviewedByName in the canonical response, so this
   *  is only used for in-flight optimistic copy. */
  viewerName: string;
  /** #233 — the viewer's user id. Used to detect whether they captured a
   *  given row so the as-built toggle can be offered to the capturer.
   *  Default-safe: absent = never the capturer. */
  viewerId?: string;
  /** #233 — true when the viewer can manage this job (admin, or a leading
   *  hand assigned to it). Gates the FLAG half of the as-built toggle for
   *  non-capturers, mirroring the server's `canManageJob`. */
  viewerCanManageJob?: boolean;
  /** #262 — true when the viewer is an admin AND the ai_photo_labels flag
   *  is on. Gates the "Suggest labels (AI)" toolbar, the Label filter axis
   *  and the drawer's correction controls. Label chips DISPLAY regardless
   *  (harmless). Default-safe: absent = dark. */
  aiLabelsEnabled?: boolean;
  /** #267 — true when the viewer is an admin AND ai_snag_suggestions is
   *  on. Gates the row indicator + drawer suggestion panel. */
  snagSuggestionsEnabled?: boolean;
  /** #267 — the job's snagsV2 rows, fetched server-side when suggestions
   *  are on. Drives the suggested/linked projection. */
  initialSnags?: ReadonlyArray<SnagItem>;
}

type ActionState =
  | { kind: "idle" }
  | { kind: "in_flight"; evidenceId: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

type SelectionMap = Record<string, boolean>;

/**
 * Phase D4 admin evidence review queue.
 *
 * Server component (page.tsx) fetches the initial evidence list; this
 * client component owns filtering, selection, drawer state, and the
 * review / reject mutations. Mirrors HoursApprovalsQueue's pattern.
 *
 * Doc 30 §6.1 + §6.5:
 *   - Status-first rows: pill, thumb, note excerpt, target, captured-by,
 *     captured-at, primary action buttons (admin only).
 *   - Bulk-select column → "Mark N reviewed" CTA in the bar.
 *   - Bulk = N parallel POSTs; per-row failures don't roll back successes.
 *   - LH sees rows but no action buttons (read-only).
 *   - Click row → drawer.
 *   - Reject opens a small modal with required reason.
 *
 * RSC manifest rule (doc 24 D-26): this file lives in
 * src/components/admin/, NOT under src/app/v2/jobs/[jobId]/evidence/.
 */
export function EvidenceQueue({
  job,
  initialEvidence,
  fetchError,
  isAdmin,
  viewerName,
  viewerId,
  viewerCanManageJob,
  aiLabelsEnabled = false,
  snagSuggestionsEnabled = false,
  initialSnags,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [items, setItems] = useState<ReadonlyArray<EvidenceItem>>(initialEvidence);
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER);
  const [selected, setSelected] = useState<SelectionMap>({});
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [unreviewId, setUnreviewId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [bulkBusy, setBulkBusy] = useState(false);
  // #267 — local snags mirror; grows when a suggestion is accepted so the
  // 'linked' projection flips without a reload.
  const [snags, setSnags] = useState<SnagItem[]>(() => [...(initialSnags ?? [])]);
  // #262 — classification run state + the honest post-run summary.
  const [classifyBusy, setClassifyBusy] = useState(false);
  const [classifySummary, setClassifySummary] = useState<{
    text: string;
    failed: boolean;
  } | null>(null);

  const visible = useMemo(
    () => items.filter((it) => matchesFilter(it, filter)),
    [items, filter]
  );

  // #263 — paired ids from the UNFILTERED initial list, computed once. The
  // badge then shows on a paired row even when its partner is filtered out
  // (AC). Recomputed only when the source identity changes.
  const pairedIds = useMemo(
    () => pairedIdSet(initialEvidence),
    [initialEvidence]
  );

  // #262 — VISIBLE photo rows the AI hasn't run on yet (no aiLabelRuns).
  // The server also enforces idempotency per (photo, modelVersion); this is
  // just the honest client-side candidate count for the toolbar.
  const classifyCandidateIds = useMemo(
    () =>
      visible
        .filter(
          (it) =>
            it.kind === "photo" &&
            !!it.photoUrl &&
            (!Array.isArray(it.aiLabelRuns) || it.aiLabelRuns.length === 0)
        )
        .map((it) => it.id),
    [visible]
  );

  // #267 — ids whose defect suggestion is live (state='suggested'), from the
  // UNFILTERED list so the drawer + row indicator agree.
  const suggestedDefectIds = useMemo(() => {
    const set = new Set<string>();
    if (!snagSuggestionsEnabled) return set;
    for (const it of items) {
      if (defectSuggestionFor(it, snags).state === "suggested") set.add(it.id);
    }
    return set;
  }, [items, snags, snagSuggestionsEnabled]);

  const selectedSubmittedIds = useMemo(
    () =>
      visible
        .filter((it) => it.status === "submitted" && selected[it.id])
        .map((it) => it.id),
    [visible, selected]
  );

  const drawerItem = useMemo(
    () => items.find((it) => it.id === drawerId) ?? null,
    [items, drawerId]
  );
  const rejectItem = useMemo(
    () => items.find((it) => it.id === rejectId) ?? null,
    [items, rejectId]
  );
  const unreviewItem = useMemo(
    () => items.find((it) => it.id === unreviewId) ?? null,
    [items, unreviewId]
  );

  const applyServerItem = useCallback((next: EvidenceItem) => {
    setItems((prev) => prev.map((it) => (it.id === next.id ? next : it)));
  }, []);

  const markReviewed = useCallback(
    async (id: string) => {
      setAction({ kind: "in_flight", evidenceId: id });
      const r = await reviewEvidence(job.id, {
        evidenceId: id,
        status: "reviewed",
      });
      if (r.ok) {
        applyServerItem(r.data.evidenceItem);
        setAction({
          kind: "success",
          message: `Reviewed — ${viewerName} on ${formatNow()}.`,
        });
        // Re-fetch server-side so server-derived counts (e.g. future
        // Command Centre cards) refresh on next visit.
        startTransition(() => router.refresh());
      } else {
        setAction({
          kind: "error",
          message:
            r.error.status === 403
              ? "Admin only — you can't mark this reviewed."
              : r.error.status === 400
                ? "Couldn't mark reviewed (state already changed)."
                : r.error.message || "Couldn't mark reviewed. Try again.",
        });
      }
    },
    [job.id, viewerName, applyServerItem, router]
  );

  const reject = useCallback(
    async (id: string, reason: string) => {
      setAction({ kind: "in_flight", evidenceId: id });
      const r = await reviewEvidence(job.id, {
        evidenceId: id,
        status: "rejected",
        rejectionReason: reason,
      });
      if (r.ok) {
        applyServerItem(r.data.evidenceItem);
        setAction({
          kind: "success",
          message: `Rejected with reason — worker sees it on next refresh.`,
        });
        setRejectId(null);
        startTransition(() => router.refresh());
      } else {
        setAction({
          kind: "error",
          message:
            r.error.status === 403
              ? "Admin only — you can't reject this."
              : r.error.status === 400
                ? "Couldn't reject (reason missing or state already changed)."
                : r.error.message || "Couldn't reject. Try again.",
        });
      }
    },
    [job.id, applyServerItem, router]
  );

  const unreview = useCallback(
    async (id: string, reason: string) => {
      setAction({ kind: "in_flight", evidenceId: id });
      const r = await reviewEvidence(job.id, {
        evidenceId: id,
        status: "submitted",
        reason: reason || null,
      });
      if (r.ok) {
        applyServerItem(r.data.evidenceItem);
        setAction({
          kind: "success",
          message: `Un-reviewed — sent back to the submitted queue.`,
        });
        setUnreviewId(null);
        startTransition(() => router.refresh());
      } else {
        setAction({
          kind: "error",
          message:
            r.error.status === 403
              ? "Admin only — you can't un-review this."
              : r.error.status === 400
                ? "Couldn't un-review (state already changed)."
                : r.error.message || "Couldn't un-review. Try again.",
        });
      }
    },
    [job.id, applyServerItem, router]
  );

  // #263 — admin unlink of a before/after pair. The link lives on the
  // AFTER row; pass that id. The server returns the canonical (now
  // unpaired) after item, which we merge in and refresh.
  const unlinkPair = useCallback(
    async (afterId: string) => {
      setAction({ kind: "in_flight", evidenceId: afterId });
      const r = await unlinkEvidence(job.id, { afterId });
      if (r.ok) {
        applyServerItem(r.data.evidenceItem);
        setAction({ kind: "success", message: "Unlinked the before/after pair." });
        startTransition(() => router.refresh());
      } else {
        setAction({
          kind: "error",
          message:
            r.error.status === 403
              ? "You can't unlink this pair."
              : r.error.message || "Couldn't unlink. Try again.",
        });
      }
    },
    [job.id, applyServerItem, router]
  );

  // #233 — flag / unflag a capture as part of the as-built handover record.
  // Reuses the shipped `flag-asbuilt` endpoint; the server enforces the
  // capturer-own-OR-canManageJob (flag) / capturer-own-OR-admin (unflag)
  // asymmetry, so a 403 here is a defensive fallback (the drawer only
  // surfaces the control to a viewer who can use it). The canonical item is
  // merged into local state so the As-built pill flips without a reload; the
  // gallery + summary count pick it up on their next load.
  const toggleAsBuilt = useCallback(
    async (id: string, next: boolean) => {
      setAction({ kind: "in_flight", evidenceId: id });
      const r = await flagAsBuiltEvidence(job.id, {
        evidenceId: id,
        asBuilt: next,
      });
      if (r.ok) {
        applyServerItem(r.data.evidenceItem);
        setAction({
          kind: "success",
          message: next
            ? "Flagged as-built — it'll show on the gallery's as-built filter."
            : "Cleared the as-built flag.",
        });
        startTransition(() => router.refresh());
      } else {
        setAction({
          kind: "error",
          message:
            r.error.status === 403
              ? "You can't change the as-built flag on this capture."
              : r.error.status === 400
                ? "Couldn't update the as-built flag (photos only)."
                : r.error.message || "Couldn't update the as-built flag. Try again.",
        });
      }
    },
    [job.id, applyServerItem, router]
  );

  // #262 — batch-classify the visible unclassified photos (cap 8 per go).
  // The summary is honest per-outcome ("3 labelled · 1 failed: …"); a 503
  // UNCONFIGURED shows the server's plain error text, never a fake result.
  const suggestLabels = useCallback(async () => {
    const ids = classifyCandidateIds.slice(0, CLASSIFY_BATCH_MAX);
    if (ids.length === 0 || classifyBusy) return;
    setClassifyBusy(true);
    setClassifySummary(null);
    const r = await classifyEvidencePhotos(job.id, ids);
    if (r.ok) {
      for (const ev of r.data.evidence) applyServerItem(ev);
      const counts = { labelled: 0, "no-labels": 0, skipped: 0, failed: 0 };
      let failReason: string | null = null;
      for (const result of r.data.results) {
        counts[result.outcome] += 1;
        if (result.outcome === "failed" && !failReason && result.reason) {
          failReason = result.reason;
        }
      }
      const parts: string[] = [];
      if (counts.labelled) parts.push(`${counts.labelled} labelled`);
      if (counts["no-labels"]) parts.push(`${counts["no-labels"]} no labels`);
      if (counts.skipped) parts.push(`${counts.skipped} skipped`);
      if (counts.failed) {
        parts.push(
          `${counts.failed} failed${failReason ? `: ${failReason}` : ""}`
        );
      }
      setClassifySummary({
        text: parts.length > 0 ? parts.join(" · ") : "Nothing classified.",
        failed: counts.failed > 0,
      });
      startTransition(() => router.refresh());
    } else {
      setClassifySummary({
        text: apiErrorMessage(r.error, "Couldn't suggest labels. Try again."),
        failed: true,
      });
    }
    setClassifyBusy(false);
  }, [classifyCandidateIds, classifyBusy, job.id, applyServerItem, router]);

  // #262 — human label correction (accept / remove / add) from the drawer.
  const correctLabels = useCallback(
    async (
      evidenceId: string,
      correction: { add?: string[]; accept?: string[]; remove?: string[] }
    ) => {
      setAction({ kind: "in_flight", evidenceId });
      const r = await correctEvidenceLabels(job.id, {
        evidenceId,
        ...correction,
      });
      if (r.ok) {
        applyServerItem(r.data.evidenceItem);
        setAction({ kind: "success", message: "Labels updated." });
        startTransition(() => router.refresh());
      } else {
        setAction({
          kind: "error",
          message:
            r.error.status === 403
              ? "Admin only — you can't change labels."
              : apiErrorMessage(r.error, "Couldn't update the labels. Try again."),
        });
      }
    },
    [job.id, applyServerItem, router]
  );

  // #267 — sticky dismissal of the defect suggestion. Quiet on success:
  // the card itself flips to its muted dismissed line, no banner needed.
  const dismissSuggestion = useCallback(
    async (evidenceId: string) => {
      setAction({ kind: "in_flight", evidenceId });
      const r = await dismissDefectSuggestion(job.id, evidenceId);
      if (r.ok) {
        applyServerItem(r.data.evidenceItem);
        setAction({ kind: "idle" });
        startTransition(() => router.refresh());
      } else {
        setAction({
          kind: "error",
          message:
            r.error.status === 403
              ? "Admin only — you can't dismiss this suggestion."
              : apiErrorMessage(
                  r.error,
                  "Couldn't dismiss the suggestion. Try again."
                ),
        });
      }
    },
    [job.id, applyServerItem, router]
  );

  // #267 — accept a defect suggestion by raising a snag through the
  // EXISTING snag-create path. Returns an error message for the card's
  // inline display, or null on success (the new snag flips the projection
  // to 'linked' via local snags state).
  const raiseSnag = useCallback(
    async (
      evidenceId: string,
      payload: CreateSnagPayload
    ): Promise<string | null> => {
      setAction({ kind: "in_flight", evidenceId });
      const r = await createSnag(job.id, payload);
      if (r.ok) {
        setSnags((prev) => [...prev, r.data.snagItem]);
        setAction({
          kind: "success",
          message: "Snag raised and linked to this photo.",
        });
        startTransition(() => router.refresh());
        return null;
      }
      setAction({ kind: "idle" });
      return r.error.status === 403
        ? "You can't raise snags on this job."
        : apiErrorMessage(r.error, "Couldn't raise the snag. Try again.");
    },
    [job.id, router]
  );

  // Resolve the AFTER id for the drawer's unlink button: if the drawer item
  // IS the after it carries pairedWithId; if it's the before, find the row
  // pointing at it. Returns null when the item isn't part of a live pair.
  const drawerAfterId = useMemo(() => {
    if (!drawerItem) return null;
    if (drawerItem.pairedWithId && items.some((it) => it.id === drawerItem.pairedWithId)) {
      return drawerItem.id;
    }
    const after = items.find((it) => it.pairedWithId === drawerItem.id);
    return after ? after.id : null;
  }, [drawerItem, items]);

  const bulkMarkReviewed = useCallback(async () => {
    if (selectedSubmittedIds.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setAction({ kind: "idle" });
    // Per doc 30 §6.5: parallel per-row POSTs. Per-row failures don't
    // roll back successes — failed rows stay submitted with an inline
    // pill (visible on the row after).
    const results = await Promise.all(
      selectedSubmittedIds.map((id) =>
        reviewEvidence(job.id, { evidenceId: id, status: "reviewed" })
      )
    );
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      const id = selectedSubmittedIds[i];
      if (r && r.ok) {
        applyServerItem(r.data.evidenceItem);
        ok += 1;
      } else {
        fail += 1;
        if (id) {
          // Keep the row as-is but stamp a per-row inline error.
          setItems((prev) =>
            prev.map((it) =>
              it.id === id
                ? Object.assign({}, it, { __rowError: "Couldn't mark reviewed" })
                : it
            )
          );
        }
      }
    }
    setSelected({});
    setBulkBusy(false);
    setAction({
      kind: fail === 0 ? "success" : "error",
      message:
        fail === 0
          ? `Marked ${ok} reviewed.`
          : `Marked ${ok} reviewed; ${fail} failed — they stayed submitted.`,
    });
    startTransition(() => router.refresh());
  }, [selectedSubmittedIds, bulkBusy, job.id, applyServerItem, router]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const toggleSelectAllVisible = useCallback(() => {
    const visibleSubmittedIds = visible
      .filter((it) => it.status === "submitted")
      .map((it) => it.id);
    const allSelected =
      visibleSubmittedIds.length > 0 &&
      visibleSubmittedIds.every((id) => selected[id]);
    setSelected((prev) => {
      const next = { ...prev };
      for (const id of visibleSubmittedIds) {
        if (allSelected) delete next[id];
        else next[id] = true;
      }
      return next;
    });
  }, [visible, selected]);

  const visibleSubmittedCount = useMemo(
    () => visible.filter((it) => it.status === "submitted").length,
    [visible]
  );
  const headerCheckChecked =
    visibleSubmittedCount > 0 &&
    visible
      .filter((it) => it.status === "submitted")
      .every((it) => selected[it.id]);

  const busyMap = useMemo<Record<string, boolean>>(() => {
    if (action.kind === "in_flight") {
      return { [action.evidenceId]: true };
    }
    return {};
  }, [action]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <CardTitle>Evidence review · {job.name}</CardTitle>
            <CardDescription className="mt-1">
              Submitted captures from the site land here. Mark reviewed to
              close the loop, or reject with a reason so the worker can
              re-capture.
            </CardDescription>
          </div>
          {!isAdmin ? (
            <Pill tone="neutral">Read-only — leading hand</Pill>
          ) : null}
        </div>
      </Card>

      {fetchError ? (
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardTitle>Couldn&rsquo;t load the queue</CardTitle>
          <CardDescription className="text-amber-900">
            {fetchError}. Try refreshing in a moment.
          </CardDescription>
        </Card>
      ) : null}

      <ActionFeedback state={action} />

      <EvidenceFilterBar
        job={job}
        items={items}
        value={filter}
        onChange={(next) => {
          setFilter(next);
          setSelected({});
        }}
        visibleCount={visible.length}
        aiLabelsEnabled={isAdmin && aiLabelsEnabled}
      />

      {isAdmin && aiLabelsEnabled ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface-raised px-3 py-2.5 shadow-card">
          <Button
            size="sm"
            variant="secondary"
            onClick={suggestLabels}
            disabled={classifyBusy || classifyCandidateIds.length === 0}
          >
            <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
            {classifyBusy ? "Suggesting…" : "Suggest labels (AI)"}
          </Button>
          <p className="text-xs text-text-muted">
            {classifyCandidateIds.length === 0
              ? "Nothing to classify — the AI has looked at every visible photo."
              : classifyCandidateIds.length > CLASSIFY_BATCH_MAX
                ? `${classifyCandidateIds.length} visible photos the AI hasn't looked at — does ${CLASSIFY_BATCH_MAX} at a time.`
                : `${classifyCandidateIds.length} visible photo${classifyCandidateIds.length === 1 ? "" : "s"} the AI hasn't looked at.`}
          </p>
          {classifySummary ? (
            <p
              role="status"
              aria-live="polite"
              className={cn(
                "text-xs font-medium",
                classifySummary.failed ? "text-rose-700" : "text-emerald-800"
              )}
            >
              {classifySummary.text}
            </p>
          ) : null}
        </div>
      ) : null}

      {isAdmin && selectedSubmittedIds.length > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-card border border-brand-navy bg-brand-navy px-4 py-3 text-text-inverse">
          <p className="text-sm">
            {selectedSubmittedIds.length} selected for review
          </p>
          <Button
            variant="primary"
            onClick={bulkMarkReviewed}
            disabled={bulkBusy}
            className="bg-accent-yellow text-brand-navy hover:bg-accent-yellow"
          >
            {bulkBusy
              ? "Reviewing…"
              : `Mark ${selectedSubmittedIds.length} reviewed`}
          </Button>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          title={
            items.length === 0
              ? "No evidence captured for this job yet."
              : "No evidence matches these filters."
          }
          description={
            items.length === 0
              ? "When workers capture evidence in the field, it lands here for you to review."
              : "Adjust the filters above or clear them to see everything."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface-raised">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-surface-subtle text-left">
              <tr>
                {isAdmin ? (
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={headerCheckChecked}
                      onChange={toggleSelectAllVisible}
                      disabled={visibleSubmittedCount === 0}
                      aria-label="Select all visible submitted"
                      className="h-4 w-4 accent-brand-navy"
                    />
                  </th>
                ) : null}
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  Status
                </th>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  Evidence
                </th>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  Target
                </th>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  Captured by
                </th>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  When
                </th>
                {isAdmin ? (
                  <th className="px-3 py-2.5 text-right font-display text-xs uppercase tracking-wider text-text-muted">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((it) => (
                <EvidenceRow
                  key={it.id}
                  item={it}
                  job={job}
                  isAdmin={isAdmin}
                  isPaired={pairedIds.has(it.id)}
                  hasDefectSuggestion={suggestedDefectIds.has(it.id)}
                  isSelected={!!selected[it.id]}
                  busy={!!busyMap[it.id] || bulkBusy}
                  onToggleSelect={() => toggleSelect(it.id)}
                  onOpen={() => setDrawerId(it.id)}
                  onMarkReviewed={() => markReviewed(it.id)}
                  onOpenReject={() => setRejectId(it.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EvidenceDrawer
        item={drawerItem}
        job={job}
        allEvidence={items}
        open={drawerItem !== null}
        isAdmin={isAdmin}
        busy={
          drawerItem
            ? !!busyMap[drawerItem.id] ||
              rejectId === drawerItem.id ||
              unreviewId === drawerItem.id
            : false
        }
        viewerId={viewerId}
        viewerCanManageJob={viewerCanManageJob}
        onClose={() => setDrawerId(null)}
        onMarkReviewed={() => {
          if (drawerItem) markReviewed(drawerItem.id);
        }}
        onOpenReject={() => {
          if (drawerItem) setRejectId(drawerItem.id);
        }}
        onOpenUnreview={
          isAdmin
            ? () => {
                if (drawerItem) setUnreviewId(drawerItem.id);
              }
            : undefined
        }
        onUnlink={
          isAdmin && drawerAfterId
            ? () => unlinkPair(drawerAfterId)
            : undefined
        }
        onToggleAsBuilt={
          drawerItem
            ? () => toggleAsBuilt(drawerItem.id, !(drawerItem.asBuilt === true))
            : undefined
        }
        aiLabelsEnabled={isAdmin && aiLabelsEnabled}
        onCorrectLabels={
          isAdmin && aiLabelsEnabled && drawerItem
            ? (correction) => correctLabels(drawerItem.id, correction)
            : undefined
        }
        snagSuggestionsEnabled={isAdmin && snagSuggestionsEnabled}
        snags={snags}
        onDismissDefectSuggestion={
          isAdmin && snagSuggestionsEnabled && drawerItem
            ? () => dismissSuggestion(drawerItem.id)
            : undefined
        }
        onRaiseSnag={
          isAdmin && snagSuggestionsEnabled && drawerItem
            ? (payload) => raiseSnag(drawerItem.id, payload)
            : undefined
        }
      />

      <EvidenceRejectModal
        open={rejectItem !== null}
        item={rejectItem}
        busy={rejectItem ? !!busyMap[rejectItem.id] : false}
        onClose={() => setRejectId(null)}
        onSubmit={(reason) => {
          if (rejectItem) reject(rejectItem.id, reason);
        }}
      />

      <EvidenceUnreviewModal
        open={unreviewItem !== null}
        item={unreviewItem}
        busy={unreviewItem ? !!busyMap[unreviewItem.id] : false}
        onClose={() => setUnreviewId(null)}
        onSubmit={(reason) => {
          if (unreviewItem) unreview(unreviewItem.id, reason);
        }}
      />
    </div>
  );
}

interface RowProps {
  item: EvidenceItem;
  job: Job;
  isAdmin: boolean;
  /** #263 — true when this row participates in a before/after pair (set
   *  computed from the UNFILTERED list, so the badge shows even when the
   *  partner is filtered out). */
  isPaired: boolean;
  /** #267 — true when the defect-suggestion projection says 'suggested'
   *  for this row (only ever true when ai_snag_suggestions is on). */
  hasDefectSuggestion: boolean;
  isSelected: boolean;
  busy: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onMarkReviewed: () => void;
  onOpenReject: () => void;
}

function EvidenceRow({
  item,
  job,
  isAdmin,
  isPaired,
  hasDefectSuggestion,
  isSelected,
  busy,
  onToggleSelect,
  onOpen,
  onMarkReviewed,
  onOpenReject,
}: RowProps) {
  const tone = PILL_TONE_MAP[statusTone(item.status)];
  const rowError = (item as unknown as { __rowError?: string }).__rowError;
  const targetParts = resolveEvidenceTargetParts(job, item);
  const hasContext = Boolean(targetParts.stage || targetParts.area || targetParts.task);
  const reviewed = item.status === "reviewed";
  const rejected = item.status === "rejected";
  const immutable = reviewed || rejected;
  return (
    <tr className={cn("text-sm", busy ? "opacity-70" : "")}>
      {isAdmin ? (
        <td className="w-10 px-3 py-3 align-top">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            disabled={busy || item.status !== "submitted"}
            aria-label={`Select ${item.kind} captured ${formatWhen(item.capturedAt)}`}
            className="h-4 w-4 accent-brand-navy"
          />
        </td>
      ) : null}
      <td className="px-3 py-3 align-top">
        <Pill tone={tone}>{statusLabel(item.status)}</Pill>
        {rowError ? (
          <p className="mt-1 text-xs text-rose-700" role="alert">
            {rowError}
          </p>
        ) : null}
      </td>
      <td className="px-3 py-3 align-top">
        <button
          type="button"
          onClick={onOpen}
          className="flex items-start gap-3 text-left hover:underline focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          <Thumb item={item} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
              {kindLabel(item.kind)}
              {isPaired ? (
                <span
                  className="inline-flex items-center gap-1 rounded-pill bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700"
                  title="Linked before/after pair"
                >
                  <Link2 aria-hidden="true" className="h-3 w-3" />
                  Paired
                </span>
              ) : null}
            </span>
            <span className="block max-w-xs truncate text-sm text-text">
              {item.note ? item.note : "—"}
            </span>
            {/* #262 — label chips display whenever the row carries labels;
                mutation stays behind the flag-gated controls. */}
            <EvidenceLabelChips item={item} className="mt-1 max-w-xs" />
            {hasDefectSuggestion ? (
              // #267 — opens the drawer (this whole cell is the open button)
              // where the suggestion panel holds the raise/dismiss decision.
              <span className="mt-1 inline-flex items-center gap-1 rounded-pill border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
                <Sparkles aria-hidden="true" className="h-3 w-3" />
                Possible defect — suggestion
              </span>
            ) : null}
            {rejected && item.rejectionReason ? (
              <span className="mt-1 block max-w-xs truncate text-xs text-rose-700">
                Reason: {item.rejectionReason}
              </span>
            ) : null}
          </span>
        </button>
      </td>
      <td className="px-3 py-3 align-top text-sm">
        {hasContext ? (
          <EvidenceContextChips parts={targetParts} />
        ) : (
          <Pill tone="neutral">Unattached</Pill>
        )}
      </td>
      <td className="px-3 py-3 align-top text-sm text-text">
        {item.capturedByName}
        {item.capturedByRole ? (
          <span className="ml-1 text-xs text-text-muted">({item.capturedByRole})</span>
        ) : null}
      </td>
      <td className="px-3 py-3 align-top text-sm">
        <time
          dateTime={item.capturedAt}
          title={item.capturedAt}
          className="text-text-muted"
        >
          {formatWhen(item.capturedAt)}
        </time>
      </td>
      {isAdmin ? (
        <td className="px-3 py-3 align-top text-right">
          {immutable ? (
            <span className="text-xs text-text-muted">No actions</span>
          ) : (
            <div className="flex flex-col items-end gap-2 sm:flex-row sm:justify-end">
              <Button
                size="sm"
                variant="primary"
                onClick={onMarkReviewed}
                disabled={busy}
                className="bg-brand-navy text-text-inverse hover:bg-accent-ink"
              >
                {busy ? "…" : "Review"}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={onOpenReject}
                disabled={busy}
              >
                Reject
              </Button>
            </div>
          )}
        </td>
      ) : null}
    </tr>
  );
}

function Thumb({ item }: { item: EvidenceItem }) {
  if (item.kind === "photo" && item.photoUrl) {
    return (
      <span className="block h-12 w-12 shrink-0 overflow-hidden rounded-card bg-surface-subtle">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.photoUrl}
          alt=""
          className="block h-full w-full object-cover"
          loading="lazy"
        />
      </span>
    );
  }
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-card bg-surface-subtle text-text-muted">
      {item.kind === "photo" ? (
        <ImageIcon aria-hidden="true" className="h-5 w-5" />
      ) : (
        <FileText aria-hidden="true" className="h-5 w-5" />
      )}
    </span>
  );
}

function ActionFeedback({ state }: { state: ActionState }) {
  if (state.kind === "success") {
    return (
      <Card className="border-emerald-200 bg-emerald-50" role="status" aria-live="polite">
        <CardDescription className="text-emerald-900">{state.message}</CardDescription>
      </Card>
    );
  }
  if (state.kind === "error") {
    return (
      <Card className="border-rose-200 bg-rose-50" role="alert" aria-live="assertive">
        <CardDescription className="text-rose-900">{state.message}</CardDescription>
      </Card>
    );
  }
  return null;
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return d.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      timeZone: "Australia/Sydney",
    });
  } catch {
    return "";
  }
}

function formatNow(): string {
  try {
    return new Date().toLocaleTimeString("en-AU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Australia/Sydney",
    });
  } catch {
    return "";
  }
}
