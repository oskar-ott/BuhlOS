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
 * Conditional points ("only-if", #293) — CLOSED VOCABULARY v1
 * ----------------------------------------------------------
 * A template point may carry an `onlyIf` condition so a check only
 * applies in the right context. v1 ships ONE condition key — `scopeType`
 * — and nothing else. The allowed keys live in `ITP_CONDITION_KEYS`
 * below; anything not in that set is a future, deferred key (e.g.
 * attach-time-attribute / job-attribute) — no real template needs them
 * yet, and they would touch AttachITPModal, so they wait for a named
 * follow-up.
 *
 * Two opposite failure stances, on purpose:
 *   - FAIL-OPEN at EVALUATION (src/domains/itp/applicability.ts +
 *     api/_lib/itp-applicability.js): an unknown / malformed condition
 *     never silently drops a check. A typo in `onlyIf` makes the point
 *     APPLY (it shows, it counts), so a real inspection is never hidden
 *     by a data error.
 *   - FAIL-CLOSED at SAVE (api/itp-templates.js validatePoint): the
 *     writer only persists `onlyIf` when it is shaped exactly as
 *     `{ scopeType: <valid scope or array of valid scopes> }`. Unknown
 *     keys and garbage are dropped, so a typo never reaches storage in
 *     the first place. (Without this, the template writer strips the
 *     whole `onlyIf` and the feature is a dead end-to-end.)
 *
 * Snapshot semantics (critical): applicability is ALWAYS evaluated
 * against the attach-time `templateSnapshot.onlyIf`, never the live
 * template — editing a template must not retro-change an existing
 * instance's checklist.
 *
 * Cross-ref:
 *   docs/rebuild-audit/32-phase-e-plan.md §3 (operational loop) + §5 (data model)
 *   docs/rebuild-audit/33-phase-e-build-prompts.md §E1a
 *   api/job-itps.js — wire-shape source of truth
 *   api/itp-templates.js — template point shape source of truth
 *   src/domains/itp/applicability.ts — TS evaluation (one source of truth)
 *   api/_lib/itp-applicability.js — CJS mirror (api/*.js can't import TS)
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

/* ---------------------------------------------------------------------
 * Conditional points — "only-if" condition keys (#293, scope-type v1)
 *
 * CLOSED vocabulary. v1 ships `scopeType` and nothing else. New keys
 * (attach-time-attribute / job-attribute …) are a named follow-up — add
 * them here AND to the evaluation fns (applicability.ts + the JS mirror)
 * AND to the save-time whitelist (api/itp-templates.js) together, or the
 * feature drifts. See the schema header for the fail-open/fail-closed
 * split + snapshot semantics.
 * -------------------------------------------------------------------*/
export const ITP_CONDITION_KEYS = ["scopeType"] as const;
export type ITPConditionKey = (typeof ITP_CONDITION_KEYS)[number];

/** `onlyIf` shape. v1: a single `scopeType` key whose value is a scope
 *  or an array of allowed scopes. `.passthrough()` is intentionally NOT
 *  used — unknown keys are not modelled here (they are dropped at save),
 *  but evaluation fails OPEN on anything it doesn't recognise so a typo
 *  never silently hides a real check. */
export const ITPPointConditionSchema = z.object({
  scopeType: z.union([ITPScopeSchema, z.array(ITPScopeSchema)]),
});

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

/** #289 — the independence-override record persisted ON the instance at
 *  sign-off time (see api/job-itps.js signoff handler). Captures the
 *  justification plus the context that forced it (the recorded-by-signer
 *  ratio, who signed, when) so the compliance pack can render it straight
 *  from the instance — no audit-log join, so it can't age out of a window.
 *  `.passthrough()` keeps future fields (e.g. a recorder breakdown) from
 *  breaking older readers. */
export const ITPSignOffOverrideSchema = z
  .object({
    justification: z.string().min(1).max(ITP_OVERRIDE_JUSTIFICATION_MAX),
    /** Recorded-by-signer ratio at sign-off — what tripped the rule. */
    ratio: z.number().min(0).max(1),
    /** Username of the signer who supplied the override. */
    by: z.string(),
    /** ISO timestamp of the sign-off moment. */
    at: z.string(),
  })
  .passthrough();

/** Independence threshold for sign-off: if the signing user recorded
 *  STRICTLY MORE than this fraction of points, an override justification
 *  is required. 0.5 = "majority" — the current, deliberately-lenient rule.
 *
 *  THE SINGLE SOURCE OF TRUTH for the threshold. service.ts imports this
 *  constant directly; api/job-itps.js mirrors it as a literal
 *  (SIGNOFF_INDEPENDENCE_THRESHOLD) under the existing comment contract —
 *  the two must stay in lockstep (itp.test.ts asserts the values match).
 *
 *  #289: tightening this to 0 (ANY self-recorded point → justification
 *  required, i.e. strict four-eyes) is an OWNER decision, not made here —
 *  see the PR proposing it. When ratified it is a one-line flip of this
 *  constant + the api mirror; every call site already reads through here. */
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
    /** #285 evidence gate. SEMANTICS (mirrored in api/job-itps.js — the
     *  server gate is the source of truth): when true, EVERY record on
     *  this point must carry a photoUrl from the ITP photo flow — any
     *  record marks a point done, so the record is the moment evidence
     *  must exist. Updates carry the existing photo forward; results
     *  recorded before the flag are never retro-blocked (the flag rides
     *  the attach-time snapshot). Absent on legacy points = off. */
    evidenceRequired: z.boolean().optional(),
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
    /** #293 conditional point — only-if (scope-type v1). When present and
     *  shaped `{ scopeType }`, the point applies only when the instance
     *  scope ∈ the allowed set. Evaluation is snapshot-driven (this rides
     *  the attach-time snapshot) and fails OPEN — see applicability.ts.
     *  `.passthrough()` on the point means an unknown-but-stored shape
     *  still parses; evaluation, not parsing, decides applicability. */
    onlyIf: ITPPointConditionSchema.nullable().optional(),
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

    /** #289 — when the sign-off tripped the independence rule and an
     *  override justification was supplied, it is PERSISTED here on the
     *  instance (not only in audit-log metadata). This is what makes the
     *  #286 compliance pack read the justification from the instance
     *  itself, so an override can never "age out" of a time-windowed
     *  audit scan. Absent = an independent (non-override) sign-off.
     *  Cleared on reopen alongside the sign-off stamps. */
    signOffOverride: ITPSignOffOverrideSchema.nullish(),

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

/** One row from GET /api/itp-templates (server already excludes archived
 *  for the default list — the attach picker never sees them, #387). */
export const ITPTemplateSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    category: z.string().optional(),
    description: z.string().optional(),
    points: z.array(z.object({ id: z.string() }).passthrough()).optional(),
    archived: z.boolean().optional(),
  })
  .passthrough();

export const ITPTemplateListResponseSchema = z.object({
  count: z.number().optional(),
  templates: z.array(ITPTemplateSummarySchema),
});

/** One authored template point (#284) — matches api/itp-templates.js
 *  validatePoint. Type-specific fields only honoured for their type
 *  (unit/min/max → value; witnessRole → signoff, defaults 'admin'). */
export const ItpTemplatePointDraftSchema = z.object({
  id: z.string().optional(),
  label: z.string().trim().min(1, "Point label required").max(200),
  type: ITPPointTypeSchema,
  required: z.boolean().optional(),
  evidenceRequired: z.boolean().optional(),
  unit: z.string().trim().max(30).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  witnessRole: ITPWitnessRoleSchema.optional(),
  /** #293 only-if (scope-type v1). Authoring surfaces send this; the
   *  writer (api/itp-templates.js) whitelists it FAIL-CLOSED — only a
   *  well-shaped `{ scopeType }` persists, garbage is dropped. */
  onlyIf: ITPPointConditionSchema.nullable().optional(),
});

export const CreateItpTemplatePayloadSchema = z.object({
  name: z.string().trim().min(1, "Name required").max(120),
  category: z.string().trim().max(80).optional(),
  description: z.string().trim().max(2000).optional(),
  points: z.array(ItpTemplatePointDraftSchema).min(1, "At least one point").max(100),
});

export const UpdateItpTemplatePayloadSchema = CreateItpTemplatePayloadSchema.partial();

export const ItpTemplateMutationResponseSchema = z.object({
  template: ITPTemplateSummarySchema,
});

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

/** POST /api/job-itps?jobId=X&action=submit body.
 *
 *  "Submit for review" — the explicit `in-progress → witnessed` step.
 *  Replaces the old implicit auto-advance that flipped to witnessed on
 *  the last record: now the worker (or office) deliberately submits a
 *  completed ITP so it surfaces in /qa as awaiting sign-off. Same
 *  minimal body shape as reopen/archive (server re-checks state). */
export const SubmitITPPayloadSchema = z.object({
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
