"use client";

import { useCallback, useState } from "react";
import { ChevronDown, MapPin, Plus } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilNotice } from "./ui/PhilNotice";
import {
  SERVICE_LOCATION_DESCRIPTION_MAX,
  SERVICE_LOCATION_LABEL_MAX,
  SERVICE_LOCATION_PHOTO_MAX,
  SERVICE_LOCATION_TYPES,
} from "@/domains/services-locations/schema";
import { displayHeading, sortForDisplay, typeLabel } from "@/domains/services-locations/format";
import { createServiceLocation } from "@/domains/services-locations/client";
import type {
  ServiceLocationRecord,
  ServiceLocationType,
} from "@/domains/services-locations/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import { cn } from "@/lib/cn";

/**
 * Phil — "Services on site" card (#230).
 *
 * Where the pit / main switchboard / meter / temporary supply are on this job,
 * so anyone on site can find the board/pit/meter without ringing around. A
 * worker can add a location (description mandatory, photos optional) and the
 * photos are shown to EVERY reader on the job — they're served from the
 * denormalised URLs the link step copied, never re-fetched from /api/evidence
 * (which is own-captures-only), so worker B sees worker A's board photo.
 *
 * Phil constitution: additive reference card (P10 — bottom reference zone,
 * collapsible, render-null when the job has no records AND the viewer can't
 * write). P7 — real photos (denormalised) + description-mandatory honest text;
 * no fake counts. P11 — site language ("Services on site", "Main switchboard").
 * No capture-flow change: the "Add a photo" path reuses the existing
 * CaptureSheet via the parent-provided `onCapturePhoto` callback (the same sheet
 * the job's "Capture evidence" button opens — never a new upload path).
 *
 * Owns its own anchor id="phil-job-services" (does NOT touch #phil-job-site).
 *
 * The presentation is a pure prop-driven sub-component so the empty / populated
 * / error / loading states are SSR-render-testable without mocking fetch.
 */

const STATE_PHOTO_THUMB = "h-16 w-16 rounded-card object-cover";

export interface PhilJobServicesCardProps {
  jobId: string;
  /** Initial records fetched server-side (page Promise.all). May be empty. */
  initialRecords?: ReadonlyArray<ServiceLocationRecord>;
  /** Non-blocking error from the server fetch — surfaces a quiet notice but
   *  still lets the worker add. Null when the fetch succeeded. */
  loadError?: string | null;
  /** Whether the viewer may add a location (admin + assigned LH/field). When
   *  false and there are no records, the card renders null (P10). */
  canWrite?: boolean;
  /** Opens the EXISTING CaptureSheet and resolves with the captured
   *  EvidenceItem (or null if the worker cancelled / it failed). Wired by
   *  PhilJobDetail to the single CaptureSheet instance — this card never opens
   *  its own capture path. Absent ⇒ photo-add is hidden (text-only still works). */
  onCapturePhoto?: () => Promise<EvidenceItem | null>;
  /** Force the body expanded on first render (tests / a caller that wants it
   *  open). Overrides the default collapsed-when-populated behaviour. */
  defaultOpen?: boolean;
}

/** Pure, prop-only render of the populated list (testable without effects). */
export function PhilJobServicesList({
  records,
}: {
  records: ReadonlyArray<ServiceLocationRecord>;
}) {
  const sorted = sortForDisplay(records);
  return (
    <ul className="mt-3 divide-y divide-border">
      {sorted.map((r) => (
        <li key={r.id} className="py-3">
          <div className="flex items-start gap-2">
            <MapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text">{displayHeading(r)}</p>
              <p className="mt-0.5 whitespace-pre-line break-words text-sm text-text-muted">
                {r.description}
              </p>
              {r.photos.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {r.photos.map((p) => (
                    <a
                      key={p.evidenceId}
                      href={p.photoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={p.thumbnailUrl || p.photoUrl}
                        alt={`Photo of ${displayHeading(r)}`}
                        className={STATE_PHOTO_THUMB}
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function PhilJobServicesCard({
  jobId,
  initialRecords,
  loadError,
  canWrite = false,
  onCapturePhoto,
  defaultOpen = false,
}: PhilJobServicesCardProps) {
  const [records, setRecords] = useState<ReadonlyArray<ServiceLocationRecord>>(
    initialRecords ?? [],
  );
  // Collapsible bottom-reference card: collapsed by default when there ARE
  // records (quiet, like the Site card — the worker opens it on arrival), but
  // OPEN when the job has none yet and the worker can add — so an empty card
  // isn't a dead end (the add affordance is visible without an extra tap).
  const startEmptyWritable = (initialRecords?.length ?? 0) === 0 && canWrite;
  const [open, setOpen] = useState<boolean>(defaultOpen || startEmptyWritable);
  const [adding, setAdding] = useState(false);

  // Add-form state.
  const [type, setType] = useState<ServiceLocationType>("switchboard");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [pendingPhoto, setPendingPhoto] = useState<EvidenceItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  const resetForm = useCallback(() => {
    setType("switchboard");
    setLabel("");
    setDescription("");
    setPendingPhoto(null);
    setFormError(null);
  }, []);

  const handleCapture = useCallback(async () => {
    if (!onCapturePhoto) return;
    setCapturing(true);
    setFormError(null);
    try {
      const item = await onCapturePhoto();
      if (item) setPendingPhoto(item);
    } finally {
      setCapturing(false);
    }
  }, [onCapturePhoto]);

  const handleSave = useCallback(async () => {
    const trimmed = description.trim();
    if (!trimmed) {
      setFormError("Add a short description — where is it?");
      return;
    }
    setSaving(true);
    setFormError(null);
    const result = await createServiceLocation(jobId, {
      type,
      label: label.trim() || null,
      description: trimmed,
      ...(pendingPhoto ? { evidenceIds: [pendingPhoto.id] } : {}),
    });
    setSaving(false);
    if (!result.ok) {
      setFormError(result.error.message || "Couldn't save. Check your signal and try again.");
      return;
    }
    setRecords((prev) => [result.data.location, ...prev]);
    setAdding(false);
    setOpen(true);
    resetForm();
  }, [jobId, type, label, description, pendingPhoto, resetForm]);

  // P10: hidden when there's nothing to show and the viewer can't add.
  if (records.length === 0 && !canWrite) return null;

  const descLen = description.length;

  return (
    <section
      id="phil-job-services"
      aria-labelledby="phil-job-services-h"
      className="scroll-mt-16"
    >
      <Card>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left"
          aria-expanded={open}
          aria-controls="phil-job-services-body"
        >
          <CardTitle className="m-0">
            <span id="phil-job-services-h">Services on site</span>
          </CardTitle>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-5 w-5 shrink-0 text-text-muted transition-transform",
              open ? "rotate-180" : "",
            )}
          />
        </button>

        {open ? (
          <div id="phil-job-services-body">
            {loadError ? (
              <PhilNotice tone="warning" role="status" title="Couldn’t load services" className="mt-3">
                The pit/board/meter list may be out of date until you refresh.
              </PhilNotice>
            ) : null}

            {records.length > 0 ? (
              <PhilJobServicesList records={records} />
            ) : (
              <p className="mt-3 text-sm text-text-muted">
                No services marked yet. Add where the board, pit or meter is so the
                next person can find it.
              </p>
            )}

            {canWrite ? (
              adding ? (
                <div className="mt-4 space-y-3 rounded-card border border-border bg-surface-subtle p-3">
                  <div>
                    <label htmlFor="svc-type" className="font-display text-sm font-semibold text-text">
                      What is it?
                    </label>
                    <select
                      id="svc-type"
                      value={type}
                      onChange={(e) => setType(e.target.value as ServiceLocationType)}
                      disabled={saving}
                      className="mt-1 block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text focus:border-brand-navy focus:outline-none"
                    >
                      {SERVICE_LOCATION_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {typeLabel(t)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="svc-label" className="font-display text-sm font-semibold text-text">
                      Name <span className="text-text-muted">(optional)</span>
                    </label>
                    <input
                      id="svc-label"
                      type="text"
                      value={label}
                      maxLength={SERVICE_LOCATION_LABEL_MAX}
                      onChange={(e) => setLabel(e.target.value)}
                      disabled={saving}
                      placeholder="e.g. Main board"
                      className="mt-1 block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted/70 focus:border-brand-navy focus:outline-none"
                    />
                  </div>

                  <div>
                    <label htmlFor="svc-desc" className="font-display text-sm font-semibold text-text">
                      Where is it?
                    </label>
                    <textarea
                      id="svc-desc"
                      value={description}
                      rows={2}
                      maxLength={SERVICE_LOCATION_DESCRIPTION_MAX}
                      onChange={(e) => setDescription(e.target.value)}
                      disabled={saving}
                      placeholder="In the garage, behind the roller door."
                      className="mt-1 block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted/70 focus:border-brand-navy focus:outline-none"
                    />
                    <p className="mt-1 text-right text-xs text-text-muted">
                      {descLen} / {SERVICE_LOCATION_DESCRIPTION_MAX}
                    </p>
                  </div>

                  {onCapturePhoto ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleCapture}
                        disabled={saving || capturing || !!pendingPhoto}
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-card border border-border bg-surface px-3 text-sm font-medium text-text disabled:opacity-60"
                      >
                        <Plus aria-hidden="true" className="h-4 w-4" />
                        {capturing ? "Opening camera…" : pendingPhoto ? "Photo added" : "Add a photo (optional)"}
                      </button>
                      {pendingPhoto ? (
                        <button
                          type="button"
                          onClick={() => setPendingPhoto(null)}
                          disabled={saving}
                          className="text-xs text-text-muted underline"
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="text-xs text-text-muted">
                    Up to {SERVICE_LOCATION_PHOTO_MAX} photos per service. A text-only
                    location is fine.
                  </p>

                  {formError ? (
                    <p role="alert" className="text-sm text-state-danger">
                      {formError}
                    </p>
                  ) : null}

                  <div className="flex gap-2">
                    <PhilActionButton
                      size="md"
                      fullWidth={false}
                      onClick={handleSave}
                      disabled={saving}
                      className="flex-1"
                    >
                      {saving ? "Saving…" : "Save"}
                    </PhilActionButton>
                    <button
                      type="button"
                      onClick={() => {
                        setAdding(false);
                        resetForm();
                      }}
                      disabled={saving}
                      className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-card border border-border bg-surface px-4 text-sm font-medium text-text disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-4">
                  <PhilActionButton
                    size="md"
                    onClick={() => {
                      resetForm();
                      setAdding(true);
                    }}
                  >
                    <Plus aria-hidden="true" className="h-5 w-5" />
                    Add a service location
                  </PhilActionButton>
                </div>
              )
            ) : null}
          </div>
        ) : null}
      </Card>
    </section>
  );
}
