import { z } from "zod";

/**
 * Circuit schedule — Zod schemas for the /api/job-circuits payload.
 *
 * The legacy endpoint (api/job-circuits.js) stores `switchboards[]` +
 * `circuits[]` on the job record. This module is the typed face the rebuild
 * surfaces (Phil + BuhlOS) read and write through. The schemas are
 * deliberately lenient on the string-enum fields (`type` / `status` /
 * `device`): the server is the source of truth and already normalises them,
 * so we parse to plain strings here and narrow for display in `format.ts`.
 * That keeps an unknown future value (e.g. a new device type added
 * server-first) from blanking the whole schedule on parse.
 *
 * Cross-ref:
 *   api/job-circuits.js — GET / PUT / bulk-edit handlers + validation
 *   src/domains/circuit-schedule/format.ts — display labels / tones / grouping
 */

/** Protective device kinds — the enum the server constrains `device` to. */
export const CIRCUIT_DEVICES = [
  "mcb",
  "rcbo",
  "rcd",
  "rcd-mcb",
  "mccb",
  "fuse",
  "isolator",
  "other",
] as const;

/** Circuit purpose. Matches the server's VALID_CIRCUIT_TYPES. */
export const CIRCUIT_TYPES = [
  "power",
  "light",
  "emergency",
  "data",
  "fire",
  "mech",
  "other",
] as const;

/** Install lifecycle. Matches the server's VALID_CIRCUIT_STATUS. */
export const CIRCUIT_STATUSES = [
  "planned",
  "roughed-in",
  "energised",
  "commissioned",
] as const;

export const SwitchboardSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string().optional(),
  levelId: z.string().optional(),
  feedsFromId: z.string().optional(),
  location: z.string().optional(),
  archived: z.boolean().optional(),
  archivedAt: z.string().optional(),
  archivedBy: z.string().optional(),
  order: z.number().optional(),
});

export const CircuitSchema = z.object({
  id: z.string(),
  number: z.string(),
  switchboardId: z.string(),
  // Lenient strings — narrowed for display, never gate the parse.
  type: z.string(),
  status: z.string(),
  description: z.string().optional(),
  areaId: z.string().optional(),
  device: z.string().optional(),
  rating: z.string().optional(),
  cableSize: z.string().optional(),
  archived: z.boolean().optional(),
  archivedAt: z.string().optional(),
  archivedBy: z.string().optional(),
  order: z.number().optional(),
});

/** GET /api/job-circuits?jobId= and the PUT response both match this. */
export const CircuitScheduleResponseSchema = z.object({
  jobId: z.string().optional(),
  switchboards: z.array(SwitchboardSchema).default([]),
  circuits: z.array(CircuitSchema).default([]),
});
