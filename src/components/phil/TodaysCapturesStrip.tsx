"use client";

import { useCallback, useMemo, useState } from "react";
import { FileText, Image as ImageIcon, Link2, Link2Off, X } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { PhilNotice } from "./ui/PhilNotice";
import { PhilActionButton } from "./ui/PhilActionButton";
import {
  kindLabel,
  statusLabel,
  statusTone,
  type EvidenceStatusTone,
} from "@/domains/evidence/format";
import type { EvidenceItem } from "@/domains/evidence/types";
import { candidateBeforePhotos, resolvePair } from "@/domains/evidence/pairing";
import { linkEvidence, unlinkEvidence } from "@/domains/evidence/client";
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
  /** id→name for the job's areas. Lets a capture's "Target" line show the
   *  area NAME instead of leaking the raw area id. Ids without a name fall
   *  back to the stage only. */
  areaNames?: Record<string, string>;
  /** #263 — the job these captures belong to. Required for the link/unlink
   *  affordance. When absent, the strip degrades to read-only (no pairing). */
  jobId?: string;
  /** #263 — the current viewer's id. The "Link a before photo" affordance
   *  and the worker-owned unlink show only on the viewer's OWN captures.
   *  (The server is the authority; this keeps the UI honest pre-flight.) */
  viewerId?: string;
  /** #263 — called with the canonical AFTER item the link/unlink route
   *  returns, so the parent can merge it into its evidence state (the
   *  strip is otherwise a controlled, read-only view of `items`). */
  onItemUpdated?: (item: EvidenceItem) => void;
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
export function TodaysCapturesStrip({
  items,
  banner,
  areaNames,
  jobId,
  viewerId,
  onItemUpdated,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // #263 — local pairing UI state (independent of the parent's items).
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

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

  // The link affordance is available only when we have a jobId AND the
  // selected capture is the viewer's OWN photo (server is still the
  // authority — this just keeps the UI from offering a doomed action).
  const canPairSelected =
    !!jobId &&
    !!selected &&
    selected.kind === "photo" &&
    (!viewerId || selected.capturedById === viewerId);

  const handleLink = useCallback(
    async (afterId: string, beforeId: string) => {
      if (!jobId) return;
      setPairBusy(true);
      setPairError(null);
      const r = await linkEvidence(jobId, { afterId, beforeId });
      setPairBusy(false);
      if (r.ok) {
        onItemUpdated?.(r.data.evidenceItem);
      } else {
        setPairError(
          r.error.status === 403
            ? "You can only link your own photos."
            : "Couldn't link the photos. Try again."
        );
      }
    },
    [jobId, onItemUpdated]
  );

  const handleUnlink = useCallback(
    async (afterId: string) => {
      if (!jobId) return;
      setPairBusy(true);
      setPairError(null);
      const r = await unlinkEvidence(jobId, { afterId });
      setPairBusy(false);
      if (r.ok) {
        onItemUpdated?.(r.data.evidenceItem);
      } else {
        setPairError("Couldn't unlink. Try again.");
      }
    },
    [jobId, onItemUpdated]
  );

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <CardTitle>Today&rsquo;s captures</CardTitle>
        {sorted.length > 0 ? (
          <span className="text-xs text-text-muted">{sorted.length} captured</span>
        ) : null}
      </div>
      {sorted.length === 0 ? (
        <CardDescription className="mt-1">
          Your recent evidence on this job. Tap a card for the full photo and status.
        </CardDescription>
      ) : null}

      {banner ? (
        <PhilNotice
          tone={banner.tone}
          role={banner.tone === "danger" ? "alert" : "status"}
          className="mt-3"
        >
          {banner.message}
        </PhilNotice>
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
                  <span className="text-[12px] uppercase tracking-wider text-text-muted">
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
        <EvidenceDrawer
          item={selected}
          items={sorted}
          areaNames={areaNames}
          canPair={canPairSelected}
          pairBusy={pairBusy}
          pairError={pairError}
          onLink={(beforeId) => handleLink(selected.id, beforeId)}
          onUnlink={(afterId) => handleUnlink(afterId)}
          onClose={() => {
            setSelectedId(null);
            setPairError(null);
          }}
        />
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
          // #138 — the grid is a list: prefer the small thumbnail and fall
          // back to full-res only when the thumb is missing (mirrors the
          // PhilPhotosGallery tile). The full-res photoUrl stays on the
          // EvidenceDrawer below, where full resolution is correct.
          // `loading="lazy"` keeps off-screen captures off the cold-start
          // byte budget.
          src={item.thumbnailUrl ?? item.photoUrl}
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
  items,
  areaNames,
  canPair = false,
  pairBusy = false,
  pairError = null,
  onLink,
  onUnlink,
  onClose,
}: {
  item: EvidenceItem;
  /** Full strip list — resolves the pair partner + the candidate picker. */
  items: ReadonlyArray<EvidenceItem>;
  areaNames?: Record<string, string>;
  /** #263 — true when the viewer may pair this (own photo + jobId known). */
  canPair?: boolean;
  pairBusy?: boolean;
  pairError?: string | null;
  /** #263 — link this AFTER to the chosen BEFORE id. */
  onLink?: (beforeId: string) => void;
  /** #263 — unlink the live pair (pass the AFTER id). */
  onUnlink?: (afterId: string) => void;
  onClose: () => void;
}) {
  const target = formatTarget(item, areaNames);
  // #263 — resolve the before/after pair for this capture. Dangling →
  // unpaired (no crash). Candidates exclude self / notes / cross-job.
  const pair = resolvePair(items, item);
  const showPair = pair.paired && !!pair.before && !!pair.after;
  const candidates = useMemo(
    () => (showPair ? [] : candidateBeforePhotos(items, item, { cap: 12 })),
    [showPair, items, item]
  );
  const [picking, setPicking] = useState(false);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Evidence detail"
      className="fixed inset-0 z-40 flex flex-col bg-surface-raised pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
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

          {showPair && pair.before && pair.after ? (
            <PhilPairView before={pair.before} after={pair.after} />
          ) : item.kind === "photo" && item.photoUrl ? (
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

          {target !== "Unattached" ? (
            <div>
              <p className="font-display text-xs uppercase tracking-wider text-text-muted">
                Target
              </p>
              <p className="mt-1 text-sm text-text">{target}</p>
            </div>
          ) : null}

          {item.status === "rejected" && item.rejectionReason ? (
            <PhilNotice tone="danger" title="Rejection reason">
              <p className="whitespace-pre-wrap">{item.rejectionReason}</p>
            </PhilNotice>
          ) : null}

          {/* #263 — before/after pairing affordance. Additive, lives only
              here (never in the frozen capture sheet). Photo-kind only. */}
          {item.kind === "photo" ? (
            <div className="border-t border-border pt-4">
              {pairError ? (
                <PhilNotice tone="danger" role="alert" className="mb-3">
                  {pairError}
                </PhilNotice>
              ) : null}

              {showPair && pair.after ? (
                canPair && onUnlink ? (
                  <button
                    type="button"
                    onClick={() => onUnlink(pair.after!.id)}
                    disabled={pairBusy}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-card border border-border px-3 py-2 text-sm text-text-muted",
                      "hover:bg-surface-subtle disabled:opacity-60"
                    )}
                  >
                    <Link2Off aria-hidden="true" className="h-4 w-4" />
                    {pairBusy ? "Unlinking…" : "Unlink before photo"}
                  </button>
                ) : (
                  <p className="inline-flex items-center gap-2 text-sm text-text-muted">
                    <Link2 aria-hidden="true" className="h-4 w-4" />
                    Paired with a before photo.
                  </p>
                )
              ) : canPair && onLink ? (
                picking ? (
                  candidates.length > 0 ? (
                    <div>
                      <p className="mb-2 font-display text-xs uppercase tracking-wider text-text-muted">
                        Pick the before photo
                      </p>
                      <ul className="flex gap-3 overflow-x-auto pb-2" role="list">
                        {candidates.map((c) => (
                          <li key={c.id} className="shrink-0">
                            <button
                              type="button"
                              onClick={() => onLink(c.id)}
                              disabled={pairBusy}
                              aria-label={`Link before photo captured ${formatTime(c.capturedAt)}`}
                              className={cn(
                                "flex w-28 flex-col gap-1 rounded-card border border-border bg-surface p-1.5 text-left",
                                "hover:border-brand-navy focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:opacity-60"
                              )}
                            >
                              <CaptureThumb item={c} />
                              <span className="text-[12px] text-text-muted">
                                {formatTime(c.capturedAt)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        onClick={() => setPicking(false)}
                        className="mt-2 text-xs text-text-muted underline"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <p className="text-sm text-text-muted">
                      No earlier photos on this job.
                    </p>
                  )
                ) : (
                  <PhilActionButton
                    size="md"
                    fullWidth={false}
                    onClick={() => setPicking(true)}
                    disabled={pairBusy}
                  >
                    <Link2 aria-hidden="true" className="h-4 w-4" />
                    Link a before photo
                  </PhilActionButton>
                )
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * #263 — Phil-side before/after pair render. Both photos with both
 * timestamps and both status pills (mixed-status honesty). The before half
 * is read-only here — the worker manages the link via the after.
 */
function PhilPairView({
  before,
  after,
}: {
  before: EvidenceItem;
  after: EvidenceItem;
}) {
  return (
    <div>
      <p className="mb-2 font-display text-xs uppercase tracking-wider text-text-muted">
        Before / after
      </p>
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: "Before", it: before },
          { label: "After", it: after },
        ].map(({ label, it }) => (
          <figure key={label} className="min-w-0 space-y-1.5">
            <figcaption className="flex items-center justify-between gap-1">
              <span className="font-display text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                {label}
              </span>
              <Pill tone={PILL_TONE_MAP[statusTone(it.status)]}>{statusLabel(it.status)}</Pill>
            </figcaption>
            {it.kind === "photo" && it.photoUrl ? (
              <div className="overflow-hidden rounded-card border border-border bg-surface-subtle">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={it.photoUrl}
                  alt={it.note ?? `${label} photo`}
                  className="block max-h-[40vh] w-full object-contain"
                />
              </div>
            ) : (
              <div className="flex aspect-square items-center justify-center rounded-card border border-border bg-surface-subtle text-text-muted">
                <ImageIcon aria-hidden="true" className="h-6 w-6" />
              </div>
            )}
            <span className="block text-[12px] text-text-muted">{formatTime(it.capturedAt)}</span>
          </figure>
        ))}
      </div>
    </div>
  );
}

/**
 * Human-readable capture target. Shows the stage and, when we can resolve
 * it, the area NAME — never a raw area/task id (those are internal and read
 * as leaked data to a field worker). Task-level pins fall back to the stage.
 */
function formatTarget(
  item: EvidenceItem,
  areaNames?: Record<string, string>,
): string {
  const parts: string[] = [];
  if (item.stage) parts.push(item.stage === "roughIn" ? "Rough-in" : "Fit-off");
  const areaName = item.areaId ? areaNames?.[item.areaId] : undefined;
  if (areaName) parts.push(areaName);
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
