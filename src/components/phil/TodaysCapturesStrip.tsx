"use client";

import { useMemo, useState } from "react";
import { FileText, Image as ImageIcon, X } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import {
  kindLabel,
  statusLabel,
  statusTone,
  type EvidenceStatusTone,
} from "@/domains/evidence/format";
import type { EvidenceItem } from "@/domains/evidence/types";
import { cn } from "@/lib/cn";

type ToneClass = "info" | "success" | "danger";
const PILL_TONE_MAP: Record<EvidenceStatusTone, ToneClass> = {
  info: "info",
  success: "success",
  danger: "danger",
};

interface Props {
  /** Items the parent passes in. The server already filters to own
   *  captures for tradie role (per doc 24 §15.0 #5); admin / LH see
   *  all on the job. Client must NOT re-filter. */
  items: ReadonlyArray<EvidenceItem>;
  /** Optional banner the parent surfaces above the strip after a
   *  capture event (success or failure). */
  banner?: { tone: "info" | "success" | "danger"; message: string } | null;
}

/**
 * "Today's captures" strip on the Phil job detail.
 *
 * Horizontal scroller of recent evidence. Tap a card → drawer with the
 * full photo + note + status + rejection reason. Empty state lives in
 * the same card so workers always see what's going on.
 *
 * Cross-ref:
 *   docs/rebuild-audit/29-phase-d3-phil-capture-spec.md §7.8 + §9
 *   src/domains/evidence/format.ts — status palette
 */
export function TodaysCapturesStrip({ items, banner }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sorted = useMemo(
    () =>
      [...items].sort((a, b) =>
        String(b.capturedAt || "").localeCompare(String(a.capturedAt || ""))
      ),
    [items]
  );

  const selected = useMemo(
    () => sorted.find((it) => it.id === selectedId) ?? null,
    [sorted, selectedId]
  );

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <CardTitle>Today&rsquo;s captures</CardTitle>
        {sorted.length > 0 ? (
          <span className="text-xs text-text-muted">{sorted.length} captured</span>
        ) : null}
      </div>
      <CardDescription className="mt-1">
        Your recent evidence on this job. Tap a card for the full photo and status.
      </CardDescription>

      {banner ? (
        <p
          role={banner.tone === "danger" ? "alert" : "status"}
          className={cn(
            "mt-3 rounded-card border px-3 py-2 text-sm",
            banner.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : banner.tone === "danger"
                ? "border-rose-200 bg-rose-50 text-rose-800"
                : "border-sky-200 bg-sky-50 text-sky-800"
          )}
        >
          {banner.message}
        </p>
      ) : null}

      {sorted.length === 0 ? (
        <p className="mt-4 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
          No evidence captured for this job yet.
        </p>
      ) : (
        <ul
          className={cn(
            "mt-4 flex gap-3 overflow-x-auto pb-2",
            // Hide the native scrollbar on mobile; the cards make the
            // overflow obvious without it.
            "scrollbar-none"
          )}
          role="list"
        >
          {sorted.map((it) => (
            <li key={it.id} className="shrink-0">
              <button
                type="button"
                onClick={() => setSelectedId(it.id)}
                className={cn(
                  "flex w-40 flex-col items-stretch gap-2 rounded-card border border-border bg-surface p-2 text-left",
                  "hover:border-brand-navy focus:outline-none focus:ring-2 focus:ring-brand-navy"
                )}
                aria-label={`${kindLabel(it.kind)} captured ${formatTime(it.capturedAt)} — ${statusLabel(it.status)}`}
              >
                <CaptureThumb item={it} />
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] uppercase tracking-wider text-text-muted">
                    {formatTime(it.capturedAt)}
                  </span>
                  <Pill tone={PILL_TONE_MAP[statusTone(it.status)]}>{statusLabel(it.status)}</Pill>
                </div>
                {it.note ? (
                  <p className="line-clamp-2 text-xs text-text">{it.note}</p>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <EvidenceDrawer item={selected} onClose={() => setSelectedId(null)} />
      ) : null}
    </Card>
  );
}

function CaptureThumb({ item }: { item: EvidenceItem }) {
  if (item.kind === "photo" && item.photoUrl) {
    return (
      <div className="aspect-square overflow-hidden rounded-card bg-surface-subtle">
        {/* eslint-disable-next-line @next/next/no-img-element -- Blob URL, not optimised */}
        <img
          src={item.photoUrl}
          alt={item.note ?? "Captured photo"}
          className="block h-full w-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }
  return (
    <div className="flex aspect-square items-center justify-center rounded-card bg-surface-subtle text-text-muted">
      <FileText aria-hidden="true" className="h-8 w-8" />
    </div>
  );
}

function EvidenceDrawer({
  item,
  onClose,
}: {
  item: EvidenceItem;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Evidence detail"
      className="fixed inset-0 z-40 flex flex-col bg-surface-raised pb-[env(safe-area-inset-bottom)]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border bg-surface-raised px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-semibold text-text">
            {kindLabel(item.kind)} · {formatTime(item.capturedAt)}
          </h2>
          <p className="truncate text-xs text-text-muted">{item.capturedByName}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={cn(
            "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-card",
            "text-text-muted hover:bg-surface-subtle"
          )}
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-lg space-y-4">
          <div className="flex items-center gap-2">
            <Pill tone={PILL_TONE_MAP[statusTone(item.status)]}>{statusLabel(item.status)}</Pill>
            {item.kind === "photo" ? (
              <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                <ImageIcon aria-hidden="true" className="h-3.5 w-3.5" /> Photo
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                <FileText aria-hidden="true" className="h-3.5 w-3.5" /> Note
              </span>
            )}
          </div>

          {item.kind === "photo" && item.photoUrl ? (
            <div className="overflow-hidden rounded-card border border-border bg-surface-subtle">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.photoUrl}
                alt={item.note ?? "Captured photo"}
                className="block max-h-[60vh] w-full object-contain"
              />
            </div>
          ) : null}

          {item.note ? (
            <div>
              <p className="font-display text-xs uppercase tracking-wider text-text-muted">
                Note
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-text">{item.note}</p>
            </div>
          ) : null}

          {item.stage || item.areaId || item.taskId ? (
            <div>
              <p className="font-display text-xs uppercase tracking-wider text-text-muted">
                Target
              </p>
              <p className="mt-1 text-sm text-text">
                {formatTarget(item)}
              </p>
            </div>
          ) : null}

          {item.status === "rejected" && item.rejectionReason ? (
            <div className="rounded-card border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              <p className="font-display text-xs uppercase tracking-wider">
                Rejection reason
              </p>
              <p className="mt-1 whitespace-pre-wrap">{item.rejectionReason}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatTarget(item: EvidenceItem): string {
  const parts: string[] = [];
  if (item.stage) parts.push(item.stage === "roughIn" ? "Rough-in" : "Fit-off");
  if (item.areaId) parts.push(`Area ${item.areaId}`);
  if (item.taskId) parts.push(`Task ${item.taskId}`);
  return parts.length ? parts.join(" · ") : "Unattached";
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("en-AU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Australia/Sydney",
    });
  } catch {
    return "";
  }
}
