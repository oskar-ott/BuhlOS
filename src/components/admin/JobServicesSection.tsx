"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  SERVICE_LOCATION_DESCRIPTION_MAX,
  SERVICE_LOCATION_LABEL_MAX,
  SERVICE_LOCATION_TYPES,
} from "@/domains/services-locations/schema";
import { displayHeading, sortForDisplay, typeLabel } from "@/domains/services-locations/format";
import {
  deleteServiceLocation,
  updateServiceLocation,
} from "@/domains/services-locations/client";
import type {
  ServiceLocationRecord,
  ServiceLocationType,
} from "@/domains/services-locations/types";

/**
 * Services-locations section (#230) on the admin job hub (/v2/jobs/[jobId]).
 *
 * Read of the same per-job register the field uses — where the pit / board /
 * meter / temp supply are, with the denormalised photos (so the office sees the
 * field's photos without an /api/evidence round-trip, which is own-captures-only
 * anyway). Lives IN the hub (no new admin route → no route-ownership change).
 *
 * Records are fetched server-side in the hub's parallel load and passed in as
 * `initialRecords` (with `loadError` when that read failed) — mirroring
 * CertificatesPanel — so the section is SSR-render-testable and never adds a
 * client mount-fetch. Edit / remove mutate client-side from there.
 *
 * Manage = edit / remove, gated to admins + the leading hand server-side
 * (canManageJob). The card passes `canManage` from the page's viewer role so an
 * LH viewer who can't manage just sees the read-only list.
 */

export function JobServicesSection({
  jobId,
  initialRecords = [],
  loadError = null,
  canManage = false,
}: {
  jobId: string;
  /** Records loaded server-side in the hub's parallel fetch. May be empty. */
  initialRecords?: ReadonlyArray<ServiceLocationRecord>;
  /** Non-blocking error from that fetch — surfaces a quiet notice. */
  loadError?: string | null;
  /** Whether the viewer may edit/remove (admin + LH). Read-only otherwise. */
  canManage?: boolean;
}) {
  const [records, setRecords] = useState<ServiceLocationRecord[]>([...initialRecords]);

  // Hide entirely when there's nothing to show, no error, and the viewer can't
  // manage — an empty section on a read-only viewer is noise (P10 mirrors the
  // field card).
  if (records.length === 0 && !loadError && !canManage) return null;

  return (
    <Card>
      <CardTitle className="flex items-center gap-2">
        <MapPin aria-hidden="true" className="h-4 w-4 text-text-muted" />
        Services on site
      </CardTitle>
      <CardDescription className="mt-1">
        Where the pit, switchboard, meter and temporary supply are — added by the
        crew in the field, photos and all.
      </CardDescription>

      {loadError ? (
        <p className="mt-3 text-sm text-text-muted" role="status">
          Couldn&rsquo;t load the services list. Try refreshing the page.
        </p>
      ) : records.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          No services marked on this job yet. The crew add these from the field.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {sortForDisplay(records).map((r) => (
            <ServiceRow
              key={r.id}
              jobId={jobId}
              record={r}
              canManage={canManage}
              onChanged={(next) =>
                setRecords((prev) => prev.map((x) => (x.id === next.id ? next : x)))
              }
              onRemoved={(id) => setRecords((prev) => prev.filter((x) => x.id !== id))}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ServiceRow({
  jobId,
  record,
  canManage,
  onChanged,
  onRemoved,
}: {
  jobId: string;
  record: ServiceLocationRecord;
  canManage: boolean;
  onChanged: (next: ServiceLocationRecord) => void;
  onRemoved: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [type, setType] = useState<ServiceLocationType>(record.type);
  const [label, setLabel] = useState(record.label ?? "");
  const [description, setDescription] = useState(record.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = description.trim();
    if (!trimmed) {
      setError("Description is required.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await updateServiceLocation(jobId, record.id, {
      type,
      label: label.trim() || null,
      description: trimmed,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message || "Couldn't save.");
      return;
    }
    onChanged(res.data.location);
    setEditing(false);
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await deleteServiceLocation(jobId, record.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message || "Couldn't remove.");
      setConfirmingRemove(false);
      return;
    }
    onRemoved(record.id);
  }

  if (editing) {
    return (
      <li className="space-y-2 py-3">
        <select
          aria-label="Service type"
          value={type}
          onChange={(e) => setType(e.target.value as ServiceLocationType)}
          disabled={busy}
          className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text"
        >
          {SERVICE_LOCATION_TYPES.map((t) => (
            <option key={t} value={t}>
              {typeLabel(t)}
            </option>
          ))}
        </select>
        <input
          aria-label="Name"
          type="text"
          value={label}
          maxLength={SERVICE_LOCATION_LABEL_MAX}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy}
          placeholder="Name (optional)"
          className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text"
        />
        <textarea
          aria-label="Where is it?"
          value={description}
          rows={2}
          maxLength={SERVICE_LOCATION_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
          className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text"
        />
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditing(false);
              setType(record.type);
              setLabel(record.label ?? "");
              setDescription(record.description);
              setError(null);
            }}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text">{displayHeading(record)}</p>
        <p className="mt-0.5 whitespace-pre-line break-words text-sm text-text-muted">
          {record.description}
        </p>
        {record.photos.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {record.photos.map((p) => (
              <a key={p.evidenceId} href={p.photoUrl} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.thumbnailUrl || p.photoUrl}
                  alt={`Photo of ${displayHeading(record)}`}
                  className="h-14 w-14 rounded-card object-cover"
                  loading="lazy"
                />
              </a>
            ))}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1 text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </div>
      {canManage ? (
        confirmingRemove ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-text-muted">Remove?</span>
            <Button type="button" variant="danger" size="sm" onClick={remove} disabled={busy}>
              {busy ? "Removing…" : "Yes, remove"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirmingRemove(false)}
              disabled={busy}
            >
              Keep
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={busy}>
              Edit
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingRemove(true)}
              disabled={busy}
            >
              Remove
            </Button>
          </div>
        )
      ) : null}
    </li>
  );
}
