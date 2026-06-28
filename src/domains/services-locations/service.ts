import {
  SERVICE_LOCATION_DESCRIPTION_MAX,
  SERVICE_LOCATION_LABEL_MAX,
  SERVICE_LOCATION_PHOTO_MAX,
  SERVICE_LOCATION_TYPES,
} from "./schema";
import type { ServiceLocationPhoto, ServiceLocationType } from "./types";

/**
 * Pure helpers for the services-locations domain (#230). Lives separately
 * from format.ts (display) and the server handler (api/services-locations.js,
 * plain JS) so the validation + denormalisation logic is unit-testable
 * without a network or a blob store.
 *
 * The server (api/services-locations.js) mirrors `validateInput` and
 * `denormalisePhoto` in plain JS — the same caps + the same copy-at-link-
 * time shape — so the client and server can never disagree on what a valid
 * record looks like.
 *
 * Cross-ref:
 *   src/domains/snags/service.ts — precedent (pure logic mirrored in the JS handler)
 *   src/domains/evidence/schema.ts — the EvidenceItem shape we denormalise from
 */

const TYPE_SET: ReadonlySet<string> = new Set(SERVICE_LOCATION_TYPES);

export function isServiceLocationType(v: unknown): v is ServiceLocationType {
  return typeof v === "string" && TYPE_SET.has(v);
}

/** The subset of an EvidenceItem we copy when denormalising a photo. Kept
 *  structural (not the full EvidenceItem type) so this helper has no import
 *  coupling to the evidence domain and the server's plain-JS mirror matches. */
export interface DenormalisableEvidence {
  id: string;
  kind?: string | null;
  photoId?: string | null;
  photoUrl?: string | null;
  thumbnailUrl?: string | null;
  capturedByName?: string | null;
}

/**
 * Copy the display-relevant fields off an evidence item into a denormalised
 * service-location photo. This is THE load-bearing step (#230): the URL is
 * snapshotted here so the services endpoint can serve it to ANY reader on
 * the job, sidestepping /api/evidence's own-captures-only GET filter.
 *
 * Returns null when the item carries no photoUrl (a note-only evidence row
 * has nothing to show) — the caller drops it rather than persisting a photo
 * with no image.
 *
 * NAMED STALENESS (P7): the copied URL is a point-in-time snapshot. A later
 * evidence rejection does NOT retract it — office QA is not a publish gate
 * for "where's the board". See schema.ts header.
 */
export function denormalisePhoto(
  ev: DenormalisableEvidence,
): ServiceLocationPhoto | null {
  const photoUrl = (ev.photoUrl ?? "").trim();
  if (!photoUrl) return null;
  return {
    evidenceId: ev.id,
    photoUrl,
    thumbnailUrl: ev.thumbnailUrl ?? null,
    photoId: ev.photoId ?? null,
    capturedByName: ev.capturedByName ?? null,
  };
}

export interface ValidateInput {
  type?: unknown;
  label?: unknown;
  description?: unknown;
  evidenceIds?: unknown;
}

export interface ValidatedInput {
  type: ServiceLocationType;
  label: string | null;
  description: string;
  evidenceIds: string[];
}

export type ValidateResult =
  | { ok: true; value: ValidatedInput }
  | { ok: false; error: string };

/**
 * Validate + normalise a create/update input. Trims, caps, dedupes
 * evidenceIds, and enforces the description-mandatory rule. Mirrored in the
 * JS handler so the server rejects the same bodies with the same messages.
 *
 * `requireDescription` is true for create and false for update (a PATCH may
 * omit description to leave it unchanged) — but when description IS present
 * it must still be non-empty after trimming.
 */
export function validateInput(
  input: ValidateInput,
  opts: { requireDescription: boolean } = { requireDescription: true },
): ValidateResult {
  if (!isServiceLocationType(input.type)) {
    return { ok: false, error: "type must be one of pit, switchboard, meter, tempSupply, other" };
  }
  const type = input.type;

  let label: string | null = null;
  if (input.label !== undefined && input.label !== null) {
    const t = String(input.label).trim();
    if (t.length > SERVICE_LOCATION_LABEL_MAX) {
      return { ok: false, error: `label must be ${SERVICE_LOCATION_LABEL_MAX} characters or fewer` };
    }
    label = t || null;
  }

  let description = "";
  const hasDescription = input.description !== undefined && input.description !== null;
  if (hasDescription) {
    description = String(input.description).trim();
    if (description.length > SERVICE_LOCATION_DESCRIPTION_MAX) {
      return {
        ok: false,
        error: `description must be ${SERVICE_LOCATION_DESCRIPTION_MAX} characters or fewer`,
      };
    }
  }
  if (opts.requireDescription || hasDescription) {
    if (!description) return { ok: false, error: "description is required" };
  }

  let evidenceIds: string[] = [];
  if (input.evidenceIds !== undefined && input.evidenceIds !== null) {
    if (!Array.isArray(input.evidenceIds)) {
      return { ok: false, error: "evidenceIds must be an array" };
    }
    evidenceIds = Array.from(new Set(input.evidenceIds.map((id) => String(id))));
    if (evidenceIds.length > SERVICE_LOCATION_PHOTO_MAX) {
      return { ok: false, error: `evidenceIds may not exceed ${SERVICE_LOCATION_PHOTO_MAX} photos` };
    }
  }

  return { ok: true, value: { type, label, description, evidenceIds } };
}
