import { z } from "zod";

/**
 * Zod schemas for the services-locations domain (#230).
 *
 * A "service location" is a per-job record of WHERE a key service is on
 * site — the pit, the main switchboard, the meter, the temporary supply —
 * so anyone on the job can find the board/pit/meter without ringing
 * around. Description is MANDATORY (the worker has to say where it is in
 * words); photos are OPTIONAL (a text-only location is allowed — "main
 * board: in the garage behind the door").
 *
 * Storage: a per-job sibling blob jobs/<jobId>/services-locations.json
 *   { locations: [ServiceLocationRecord, ...] }
 * Chosen embedded in the per-job sibling blob (matching contacts/tags/
 * data conventions) — NOT in jobs.json — so the global jobs registry
 * stays small and an edit here never races a jobs.json mutation.
 *
 * THE LOAD-BEARING DECISION — denormalised photo URLs (P7 honesty).
 * The api/evidence.js GET filters to capturedById === user.id (own
 * captures only). If this card re-fetched /api/evidence it would show
 * NOTHING to a second worker. So photoUrl/thumbnailUrl/capturedByName are
 * DENORMALISED into the record AT LINK TIME (copied off the EvidenceItem
 * the CaptureSheet returns) and served from the services endpoint — every
 * reader on the job sees them, regardless of who captured the photo.
 *
 * NAMED STALENESS (P7): a later evidence rejection does NOT retract the
 * copied URL. Office QA is not a publish gate here — the field worker
 * pointed at "the board" with a real photo, and that pointer stands even
 * if the office later rejects the underlying evidence row. The copied URL
 * is a snapshot at link time, not a live mirror of the evidence lifecycle.
 *
 * Schemas use .passthrough() so future fields don't break parsing for
 * clients compiled against an older schema — same convention as the
 * snags / evidence / contacts schemas.
 *
 * Cross-ref:
 *   src/domains/snags/schema.ts — precedent (.passthrough + caps + list response)
 *   src/domains/evidence/schema.ts — the EvidenceItem we denormalise from
 *   api/services-locations.js — the server that enforces the same caps
 */

/** Closed type enum. `other` is the escape hatch (e.g. an antenna point,
 *  a generator) so the four common services don't have to cover the world. */
export const SERVICE_LOCATION_TYPES = [
  "pit",
  "switchboard",
  "meter",
  "tempSupply",
  "other",
] as const;
export const ServiceLocationTypeSchema = z.enum(SERVICE_LOCATION_TYPES);

/** Field length caps — enforced client-side AND server-side. The label is
 *  a short row heading ("Main board"); the description is the where-is-it
 *  body the worker types on a phone (same 1000 cap as the snag description
 *  so the two behave consistently). */
export const SERVICE_LOCATION_LABEL_MAX = 120;
export const SERVICE_LOCATION_DESCRIPTION_MAX = 1000;

/** How many locations one job can hold, and how many photos one location
 *  can carry. Bounds a runaway client without getting in a real job's way:
 *  a big site has a handful of boards + a pit + a meter, not 30. */
export const SERVICE_LOCATION_MAX_PER_JOB = 30;
export const SERVICE_LOCATION_PHOTO_MAX = 5;

/**
 * One denormalised photo on a service location. The evidenceId points back
 * at the source EvidenceItem (for traceability); photoUrl/thumbnailUrl/
 * photoId/capturedByName are COPIED off that item at link time and served
 * from here so every reader on the job sees the photo — never re-fetched
 * from /api/evidence (which is own-captures-only). See the file header for
 * the named-staleness rule (a later evidence rejection does not retract
 * the copied URL).
 */
export const ServiceLocationPhotoSchema = z
  .object({
    /** Source evidence row id (this job's data.json evidence[]). */
    evidenceId: z.string(),
    /** Denormalised at link time — the full-size photo URL. */
    photoUrl: z.string(),
    /** Denormalised at link time — the thumbnail URL (may equal photoUrl). */
    thumbnailUrl: z.string().nullable().optional(),
    /** Denormalised at link time — the underlying blob photo id. */
    photoId: z.string().nullable().optional(),
    /** Denormalised at link time — who captured it ("Sam"), so the card can
     *  credit the photo without re-resolving the user. */
    capturedByName: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Full ServiceLocationRecord as persisted on
 * jobs/<jobId>/services-locations.json locations[] and as returned by
 * GET / POST /api/services-locations.
 *
 * Server fills: id, createdBy{,Id}, createdAt, updatedBy{,Id}, updatedAt,
 * and the denormalised photos[] (built from the posted evidenceIds at link
 * time). Description is required; photos may be empty (text-only allowed).
 */
export const ServiceLocationRecordSchema = z
  .object({
    id: z.string(),

    type: ServiceLocationTypeSchema,
    /** Short heading. Optional — when blank the card falls back to the type
     *  label ("Main switchboard"). */
    label: z.string().nullable().optional(),
    /** MANDATORY — where is it, in words. The whole point of the record. */
    description: z.string(),

    /** Denormalised photo snapshots (see ServiceLocationPhotoSchema). Always
     *  an array (possibly empty) — never null/absent on a server record. */
    photos: z.array(ServiceLocationPhotoSchema),

    createdBy: z.string(),
    createdById: z.string(),
    createdAt: z.string(),
    updatedBy: z.string(),
    updatedById: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/**
 * Payload the client POSTs to /api/services-locations?jobId=<id> to create.
 *
 * Validation rules (mirrored server-side in api/services-locations.js):
 *   - type required, in the enum
 *   - description required, trimmed, ≤ SERVICE_LOCATION_DESCRIPTION_MAX
 *   - label optional, ≤ SERVICE_LOCATION_LABEL_MAX
 *   - evidenceIds optional array ≤ SERVICE_LOCATION_PHOTO_MAX, each id must
 *     resolve to a real evidence row on this job (server enforces + copies
 *     the photoUrl/thumbnailUrl off it at link time)
 *
 * Client cannot set createdBy / photos — the server stamps identity and
 * builds the denormalised photos from the resolved evidence rows.
 */
export const CreateServiceLocationPayloadSchema = z
  .object({
    type: ServiceLocationTypeSchema,
    label: z
      .string()
      .max(
        SERVICE_LOCATION_LABEL_MAX,
        `Label must be ${SERVICE_LOCATION_LABEL_MAX} characters or fewer`,
      )
      .nullable()
      .optional(),
    description: z
      .string()
      .trim()
      .min(1, "description is required")
      .max(
        SERVICE_LOCATION_DESCRIPTION_MAX,
        `Description must be ${SERVICE_LOCATION_DESCRIPTION_MAX} characters or fewer`,
      ),
    evidenceIds: z
      .array(z.string())
      .max(
        SERVICE_LOCATION_PHOTO_MAX,
        `evidenceIds may not exceed ${SERVICE_LOCATION_PHOTO_MAX} photos`,
      )
      .optional(),
  })
  .passthrough();

/**
 * Payload the client PATCHes to /api/services-locations?jobId=<id>&id=<rid>.
 * Every field is optional — only the supplied fields change. evidenceIds,
 * when present, REPLACES the photo set (the server re-resolves + re-copies
 * the denormalised URLs).
 */
export const UpdateServiceLocationPayloadSchema = z
  .object({
    type: ServiceLocationTypeSchema.optional(),
    label: z
      .string()
      .max(
        SERVICE_LOCATION_LABEL_MAX,
        `Label must be ${SERVICE_LOCATION_LABEL_MAX} characters or fewer`,
      )
      .nullable()
      .optional(),
    description: z
      .string()
      .trim()
      .min(1, "description is required")
      .max(
        SERVICE_LOCATION_DESCRIPTION_MAX,
        `Description must be ${SERVICE_LOCATION_DESCRIPTION_MAX} characters or fewer`,
      )
      .optional(),
    evidenceIds: z
      .array(z.string())
      .max(
        SERVICE_LOCATION_PHOTO_MAX,
        `evidenceIds may not exceed ${SERVICE_LOCATION_PHOTO_MAX} photos`,
      )
      .optional(),
  })
  .passthrough();

/** GET /api/services-locations?jobId=X response. */
export const ServiceLocationListResponseSchema = z.object({
  locations: z.array(ServiceLocationRecordSchema),
});

/** POST / PATCH /api/services-locations response — returns the canonical
 *  written record so the client never round-trips a Blob read-after-write. */
export const ServiceLocationResponseSchema = z.object({
  location: ServiceLocationRecordSchema,
});
