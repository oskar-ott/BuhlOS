import { z } from "zod";

/**
 * Zod schemas for the ITP (Inspection / Test Plan) domain — Phase E1.
 *
 * E1a binds the rebuild surface to the legacy api/job-itps.js +
 * api/itp-templates.js on-disk shapes. The endpoints are reused
 * unchanged for the state machine; this domain layer wraps them with
 * a typed client + Zod-validated wire shapes + a state-machine /
 * role-gate service module that the Phil (E1b) and Admin (E1c) UIs
 * will consume.
 *
 * Why mirror legacy verbatim? The legacy endpoints already work — they
 * power the v1 /admin/itp.html flow that's been in production for over
 * a year. E1 ships a new rebuild surface (Phil panel + admin queue) on
 * top of the same writer, not a parallel writer. A divergent schema
 * would either re-shape the on-disk blob (data migration, risk) or
 * force a translation layer (duplication, drift).
 *
 * .passthrough() everywhere — legacy fields we don't yet model (e.g.
 * `archivedBy`, `archivedAt`) flow through untouched, and future
 * additions don't break parsing. Same convention as snags + evidence.
 *
 * Storage shape mirrors api/job-itps.js header comment:
 *   jobs/<jobId>/itps.json
 *     { instances: [{
 *         id, templateId, templateSnapshot: { name, category, points: [...] },
 *         scope, scopeId?, status, results: { [pointId]: {...} },
 *         signedOffBy?, signedOffAt?, archived?, archivedAt?, archivedBy?,
 *         createdAt, createdBy, updatedAt
 *     }] }
 *
 * Cross-ref:
 *   docs/rebuild-audit/32-phase-e-plan.md §3 (operational loop) + §5 (data model)
 *   docs/rebuild-audit/33-phase-e-build-prompts.md §E1a
 *   api/job-itps.js — wire-shape source of truth
 *   api/itp-templates.js — template point shape source of truth
 *   src/domains/snags/schema.ts — precedent (.passthrough + superRefine)
 */

/* ---------------------------------------------------------------------
 * Point types + witness roles (mirrors api/itp-templates.js)
 * -------------------------------------------------------------------*/

/** Point types — see api/itp-templates.js:49 VALID_POINT_TYPES. */
export const ITP_POINT_TYPES = ["photo", "value", "signoff", "note"] as const;
export const ITPPointTypeSchema = z.enum(ITP_POINT_TYPES);

/** Witness roles for `type='signoff'` points — see api/itp-templates.js:50
 *  VALID_WITNESS. Defaults to 'admin' on the writer side. */
export const ITP_WITNESS_ROLES = ["builder", "admin", "lh"] as const;
export const ITPWitnessRoleSchema = z.enum(ITP_WITNESS_ROLES);

/* ---------------------------------------------------------------------
 * Instance scope + status (mirrors api/job-itps.js)
 * -------------------------------------------------------------------*/

/** Instance scope — what part of the job this ITP covers. See
 *  api/job-itps.js:57 VALID_SCOPE. */
export const ITP_SCOPES = ["job", "level", "area", "switchboard"] as const;
export const ITPScopeSchema = z.enum(ITP_SCOPES);

/** Instance status — see api/job-itps.js:58 VALID_STATUS. Kebab-case,
 *  not snake_case (legacy convention; do NOT normalise). */
export const ITP_STATUSES = [
  "pending",
  "in-progress",
  "witnessed",
  "signed-off",
] as const;
export const ITPStatusSchema = z.enum(ITP_STATUSES);

/* ---------------------------------------------------------------------
 * Field length caps
 * -------------------------------------------------------------------*/

/** Notes captured per point — see api/job-itps.js:131 (slice 500). */
export const ITP_RESULT_NOTE_MAX = 500;

/** Photo URLs captured per point — see api/job-itps.js:132 (slice 400). */
export const ITP_RESULT_PHOTO_URL_MAX = 400;

/** Sign-off override justification when the independence rule triggers.
 *  Same cap as snag rejection reason (PR #26) so the admin drawer
 *  textarea sizing stays consistent. */
export const ITP_OVERRIDE_JUSTIFICATION_MAX = 500;

/** Independence threshold for sign-off: if the signing user recorded
 *  more than this fraction of points, an override justification is
 *  required. 0.5 = "majority". Configurable here so a future field
 *  observation can tune it without touching service.ts call sites. */
export const ITP_SIGNOFF_INDEPENDENCE_THRESHOLD = 0.5;

/* ---------------------------------------------------------------------
 * Template + template-point schemas
 *
 * Schemas describe the SNAPSHOT shape persisted on the instance, not
 * the live template that lives in itp-templates.json. The on-disk
 * snapshot drops `archived` points and copies fields verbatim at
 * attach-time — see api/job-itps.js:161.
 * -------------------------------------------------------------------*/

export const ITPTemplatePointSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    type: ITPPointTypeSchema,
    /** Defaults to true on the writer side. Always present on
     *  api/itp-templates.js output (validatePoint sets it). */
    required: z.boolean().optional(),
    /** Only meaningful for type='value' — unit string for the input
     *  label (e.g. "V", "Ω", "mm"). */
    unit: z.string().nullable().optional(),
    /** Only meaningful for type='value' — pass criterion lower bound. */
    min: z.number().nullable().optional(),
    /** Only meaningful for type='value' — pass criterion upper bound. */
    max: z.number().nullable().optional(),
    /** Only meaningful for type='signoff' — which role can witness. */
    witnessRole: ITPWitnessRoleSchema.optional(),
    /** Soft-archive marker. api/job-itps.js drops archived points from
     *  the snapshot, so a snapshot point should not have archived=true,
     *  but the schema tolerates the field for forward-compat reads of
     *  older snapshots. */
    archived: z.boolean().optional(),
    archivedAt: z.string().nullable().optional(),
    archivedBy: z.string().nullable().optional(),
    /** Optional sort key — see api/itp-templates.js validatePoint. */
    order: z.number().optional(),
  })
  .passthrough();

/** Template snapshot persisted on the instance at attach-time. Captures
 *  the template's identity + ordered points so editing the global
 *  template later doesn't rewrite history on this job. See
 *  api/job-itps.js:157-163. */
export const ITPTemplateSnapshotSchema = z
  .object({
    name: z.string(),
    /** Optional bucket — "Compliance" / "Energisation" / "Final test". */
    category: z.string().nullable().optional(),
    points: z.array(ITPTemplatePointSchema),
  })
  .passthrough();

/**
 * Full live template shape — what /api/itp-templates returns. Mirrored
 * here for client surfaces that show "pick a template to attach" — the
 * Phil UI never sees this, but later admin UIs might. E1a does not
 * touch /api/itp-templates, so this is read-only.
 *
 * Cross-ref: api/itp-templates.js:13-19 storage shape.
 */
export const ITPTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    category: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    points: z.array(ITPTemplatePointSchema),
    archived: z.boolean().optional(),
    createdAt: z.string().optional(),
    createdBy: z.string().nullable().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

/* ---------------------------------------------------------------------
 * Per-point result (what the worker / LH records)
 * -------------------------------------------------------------------*/

/**
 * Single point result — see api/job-itps.js:129-136.
 *
 * `value` is intentionally typed as `unknown` because the legacy
 * endpoint accepts whatever the client sends: number for value-points,
 * boolean for signoff-points, string for note-points. A stricter type
 * would force a narrowing branch in every consumer; clients should
 * inspect the point's `type` and cast accordingly.
 *
 * `byUserId` / `byUsername` / `at` are required server stamps — a
 * result row without them indicates a writer bug, so we don't make
 * them optional here.
 */
export const ITPInstanceResultSchema = z
  .object({
    value: z.unknown().nullable().optional(),
    note: z.string().optional(),
    photoUrl: z.string().optional(),
    byUserId: z.string(),
    byUsername: z.string(),
    at: z.string(),
  })
  .passthrough();

/* ---------------------------------------------------------------------
 * ITP instance — persisted on jobs/<jobId>/itps.json instances[]
 * -------------------------------------------------------------------*/

/**
 * Full ITP instance shape as returned by GET /api/job-itps?jobId=X
 * and written by attach / record / signoff / reopen / archive.
 *
 * Refinements:
 *   - status='signed-off' requires signedOffBy + signedOffAt stamps.
 *     The legacy writer always sets both together (api/job-itps.js:193-195),
 *     so a row that has one without the other is a writer bug.
 *
 * Reverse rule (signoff/reopen clears stamps) is enforced server-side
 * but not refined here — older snapshots may carry stamps after a
 * reopen and we want to read them without parse failures.
 */
export const ITPInstanceSchema = z
  .object({
    id: z.string(),

    templateId: z.string(),
    templateSnapshot: ITPTemplateSnapshotSchema,

    scope: ITPScopeSchema,
    scopeId: z.string().optional(),

    status: ITPStatusSchema,

    /** Keyed by pointId. Absent points = "not yet recorded". */
    results: z.record(z.string(), ITPInstanceResultSchema),

    signedOffBy: z.string().optional(),
    signedOffAt: z.string().optional(),

    archived: z.boolean().optional(),
    archivedAt: z.string().optional(),
    archivedBy: z.string().optional(),

    createdAt: z.string(),
    createdBy: z.string(),
    updatedAt: z.string(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (data.status === "signed-off") {
      if (!data.signedOffBy || !String(data.signedOffBy).trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "signedOffBy required when status='signed-off'",
          path: ["signedOffBy"],
        });
      }
      if (!data.signedOffAt || !String(data.signedOffAt).trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "signedOffAt required when status='signed-off'",
          path: ["signedOffAt"],
        });
      }
    }
  });

/* ---------------------------------------------------------------------
 * Request payload schemas (client → server)
 *
 * The server validates these too — api/job-itps.js applies its own
 * checks. The client schemas catch obvious shape errors before fetch
 * so invalid payloads never hit the network.
 * -------------------------------------------------------------------*/

/** POST /api/job-itps?jobId=X&action=attach body. */
export const AttachITPPayloadSchema = z.object({
  templateId: z.string().min(1, "templateId required"),
  scope: ITPScopeSchema,
  scopeId: z.string().optional(),
});

/** POST /api/job-itps?jobId=X&action=record body.
 *
 *  `value` is `unknown` because legacy accepts number / boolean /
 *  string depending on the point's type. Server narrows it. */
export const RecordITPPointPayloadSchema = z.object({
  instanceId: z.string().min(1, "instanceId required"),
  pointId: z.string().min(1, "pointId required"),
  value: z.unknown().optional(),
  note: z
    .string()
    .max(
      ITP_RESULT_NOTE_MAX,
      `note must be ${ITP_RESULT_NOTE_MAX} characters or fewer`,
    )
    .optional(),
  photoUrl: z
    .string()
    .max(
      ITP_RESULT_PHOTO_URL_MAX,
      `photoUrl must be ${ITP_RESULT_PHOTO_URL_MAX} characters or fewer`,
    )
    .optional(),
});

/** POST /api/job-itps?jobId=X&action=signoff body. */
export const SignOffITPPayloadSchema = z.object({
  instanceId: z.string().min(1, "instanceId required"),
  /** Required when the independence rule trips — server enforces.
   *  Capped to ITP_OVERRIDE_JUSTIFICATION_MAX to keep the audit row
   *  metadata blob bounded. */
  overrideJustification: z
    .string()
    .max(
      ITP_OVERRIDE_JUSTIFICATION_MAX,
      `overrideJustification must be ${ITP_OVERRIDE_JUSTIFICATION_MAX} characters or fewer`,
    )
    .optional(),
});

/** POST /api/job-itps?jobId=X&action=reopen body. */
export const ReopenITPPayloadSchema = z.object({
  instanceId: z.string().min(1, "instanceId required"),
});

/** DELETE /api/job-itps?jobId=X&id=Y query (no body). */
export const ArchiveITPPayloadSchema = z.object({
  instanceId: z.string().min(1, "instanceId required"),
});

/* ---------------------------------------------------------------------
 * Response shapes
 * -------------------------------------------------------------------*/

/** GET /api/job-itps?jobId=X response. */
export const ITPListResponseSchema = z.object({
  jobId: z.string(),
  instances: z.array(ITPInstanceSchema),
});

/** POST /api/job-itps?action=attach response (201). */
export const ITPAttachResponseSchema = z.object({
  instance: ITPInstanceSchema,
});

/** Shared shape for record / signoff / reopen — every mutating write
 *  returns the canonical updated instance so the client never has to
 *  round-trip Blob read-after-write (same precedent as snags + evidence). */
export const ITPTransitionResponseSchema = z.object({
  instance: ITPInstanceSchema,
});

/** DELETE archive response. */
export const ITPArchiveResponseSchema = z.object({
  ok: z.literal(true),
});
