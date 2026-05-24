"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Image as ImageIcon } from "lucide-react";
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
import { reviewEvidence } from "@/domains/evidence/client";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { Job } from "@/domains/jobs/types";
import {
  DEFAULT_FILTER,
  EvidenceFilterBar,
  matchesFilter,
  type FilterState,
} from "./EvidenceFilterBar";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { EvidenceRejectModal } from "./EvidenceRejectModal";
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
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [items, setItems] = useState<ReadonlyArray<EvidenceItem>>(initialEvidence);
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER);
  const [selected, setSelected] = useState<SelectionMap>({});
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [bulkBusy, setBulkBusy] = useState(false);

  const visible = useMemo(
    () => items.filter((it) => matchesFilter(it, filter)),
    [items, filter]
  );

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
        items={items}
        value={filter}
        onChange={(next) => {
          setFilter(next);
          setSelected({});
        }}
        visibleCount={visible.length}
      />

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
              ? "When workers capture evidence from Phil, it lands here for you to review."
              : "Adjust the filters above or clear them to see everything."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-surface-raised">
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
                  isAdmin={isAdmin}
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
        open={drawerItem !== null}
        isAdmin={isAdmin}
        busy={
          drawerItem
            ? !!busyMap[drawerItem.id] || rejectId === drawerItem.id
            : false
        }
        onClose={() => setDrawerId(null)}
        onMarkReviewed={() => {
          if (drawerItem) markReviewed(drawerItem.id);
        }}
        onOpenReject={() => {
          if (drawerItem) setRejectId(drawerItem.id);
        }}
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
    </div>
  );
}

interface RowProps {
  item: EvidenceItem;
  isAdmin: boolean;
  isSelected: boolean;
  busy: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onMarkReviewed: () => void;
  onOpenReject: () => void;
}

function EvidenceRow({
  item,
  isAdmin,
  isSelected,
  busy,
  onToggleSelect,
  onOpen,
  onMarkReviewed,
  onOpenReject,
}: RowProps) {
  const tone = PILL_TONE_MAP[statusTone(item.status)];
  const rowError = (item as unknown as { __rowError?: string }).__rowError;
  const target = formatTarget(item);
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
            <span className="block text-xs font-medium text-text-muted">
              {kindLabel(item.kind)}
            </span>
            <span className="block max-w-xs truncate text-sm text-text">
              {item.note ? item.note : "—"}
            </span>
            {rejected && item.rejectionReason ? (
              <span className="mt-1 block max-w-xs truncate text-xs text-rose-700">
                Reason: {item.rejectionReason}
              </span>
            ) : null}
          </span>
        </button>
      </td>
      <td className="px-3 py-3 align-top text-sm">
        {target.length === 0 ? (
          <Pill tone="neutral">Unattached</Pill>
        ) : (
          <span className="text-text">{target}</span>
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

function formatTarget(item: EvidenceItem): string {
  const parts: string[] = [];
  if (item.stage) parts.push(item.stage === "roughIn" ? "Rough-in" : "Fit-off");
  if (item.areaId) parts.push(`Area ${item.areaId}`);
  if (item.taskId) parts.push(`Task ${item.taskId}`);
  return parts.join(" · ");
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
