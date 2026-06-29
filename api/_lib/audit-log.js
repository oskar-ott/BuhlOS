// Cross-surface audit log storage (Phase D2 bootstrap).
//
// Monthly rollover blobs at  audit/<yyyy-mm>.json
//   { entries: [{ id, ts, action, actorId, actorName, actorRole, jobId,
//                  targetType, targetId, summary, metadata? }] }
//
// Append-only — this module exposes only `append()` and a read helper.
// No update / delete API.
//
// Doc 28 §A.5 calls for this to live alongside the legacy
// `api/_lib/job-audit.js` per-job log, not replace it. Both fire on
// every evidence write so the legacy admin audit tab keeps working
// while this new cross-job journal accumulates.
//
// Trim policy: the monthly blob caps at 5000 entries. Once breached we
// roll a hard cut (trim oldest 1000 — same FIFO discipline as the
// legacy per-job log in api/_lib/job-audit.js). In practice each
// month should sit well below that — evidence captures only land here
// for now — but the cap is defence-in-depth against runaway writes.

const { readBlob, writeBlob } = require('./blob');
const { nanoid } = require('./validation');

const VALID_ACTIONS = new Set([
  'evidence.captured',
  'evidence.reviewed',
  'evidence.rejected',
  'evidence.unreviewed',
  // #263: before/after pairing. linked/unlinked fire on the AFTER row only
  // (the BEFORE row is never mutated). Kept in sync with
  // src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'evidence.linked',
  'evidence.unlinked',
  // #233: as-built designation. flagged/unflagged fire on the designated row.
  // Kept in sync with src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'evidence.flagged_asbuilt',
  'evidence.unflagged_asbuilt',
  // Phase D.5 (snags). One verb covers every status change; the
  // metadata.from / metadata.to fields carry the direction.
  'snag.created',
  'snag.transitioned',
  // Phase E1a (ITPs). One verb per api/job-itps.js mutating action:
  // attach (admin attaches a template), point.recorded (worker records a
  // point — still covers the pending → in-progress auto-advance),
  // submitted (worker/office taps "Submit for review", the explicit
  // in-progress → witnessed handoff), signed_off (admin signs off —
  // terminal), reopened (admin reverses signoff), archived (admin/LH
  // soft-archives an instance).
  // Kept in sync with src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'itp.attached',
  'itp.point.recorded',
  'itp.submitted',
  'itp.signed_off',
  'itp.reopened',
  'itp.archived',
  // #503 — office proof sign-off (the admin approve/send-back surface).
  'proof.approved',
  'proof.sent_back',
  // Onboarding (O1). One verb per admin action the bible §10 S11 requires
  // auditing: create / update / role-change / disable / invite-issue /
  // invite-revoke. `invite.issued` covers both first send and resend; the
  // metadata.resentCount carries which. Kept in sync with
  // src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'employee.created',
  'employee.updated',
  'employee.role_changed',
  'employee.disabled',
  'invite.issued',
  'invite.revoked',
  // O2: provider send failure (metadata only — reason category, never token).
  'invite.send_failed',
  // O3: worker opens the invite + completes setup (metadata only — never
  // token/PIN). Kept in sync with src/domains/audit-log/schema.ts.
  'invite.opened',
  'invite.accepted',
  'employee.activated',
  // PR 6: observation triage conversion. Records the office decision to
  // promote an observation (defect/safety/blocker) into a real Snag — the
  // snag itself also emits its own snag.created entry in the same write
  // path, so the timeline shows both events. metadata.snagId carries the
  // created snag's id. Kept in sync with src/domains/audit-log/schema.ts.
  'observation.converted_to_snag',
  // PR 10: observation lifecycle. Mirrors the snag.{created,transitioned}
  // pattern. observation.created is emitted on POST /api/observations.
  // observation.transitioned is emitted on PATCH whenever status, priority,
  // or assignedToId changes (one row per PATCH; metadata.changedFields
  // carries the list of fields and metadata.from/to capture status flips
  // so a downstream timeline reads "needs_action → in_review" without
  // re-fetching). Kept in sync with src/domains/audit-log/schema.ts.
  'observation.created',
  'observation.transitioned',
  // PR 11: Material Request module. Mirrors the snag pattern (created +
  // transitioned). material_request.created is emitted on POST /api/material-
  // requests and on the convert-from-observation action. material_request.
  // transitioned is emitted on PATCH whenever status, urgency, supplier,
  // approvedById, orderRef, or cancellation fields change.
  // observation.converted_to_material_request mirrors PR 6's snag conversion
  // verb — emitted by the convert action attributing the office decision to
  // the observation (the material request itself also emits its own
  // material_request.created entry so the per-job timeline shows both).
  'material_request.created',
  'material_request.transitioned',
  // #151: the scheduled blob backup writes one entry per run (ok or failed)
  // so a quiet cron can't hide a broken backup. targetType 'system'.
  'backup.completed',
  // #157: a write guard refused a destructive/conflicting store write.
  'storage.write_rejected',
  'observation.converted_to_material_request',
  // #194: drawing/document register lifecycle (api/plans.js).
  'document.uploaded',
  'document.superseded',
  'document.made_current',
  // #299: a field worker acknowledged a revision ("seen rev C").
  'document.acknowledged',
  // #189: per-job contacts maintained by the office.
  'contact.saved',
  'contact.removed',
  // #331: worker licence / ticket register (api/licences.js).
  'credential.added',
  'credential.updated',
  'credential.removed',
  // #332: per-job site induction register (api/job-inductions.js).
  // Self-confirms and office backfills stay distinguishable by verb.
  'induction.confirmed',
  'induction.backfilled',
  // #127: office marks/clears a not-worked (leave) day; #333 worker requests.
  'leave.recorded',
  'leave.decided',
  'leave.cancelled',
  // #280: variation CLAIM module (api/variations.js). Mirrors the snag pattern —
  // one created verb + one transitioned verb covering every status change; the
  // row's metadata.from / metadata.to carry the direction. The approve
  // transition additionally records metadata.method so a dispute review can see
  // HOW it was approved without re-fetching. variation.converted_from_observation
  // mirrors observation.converted_to_snag — emitted when a variation-typed
  // observation is promoted to a real claim (the observation also gets its own
  // observation.converted_to_variation row attributing the office decision).
  // Kept in sync with src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'variation.created',
  'variation.transitioned',
  'observation.converted_to_variation',
  // #276: observation → real RFI conversion verb (mirrors the snag/variation
  // converts; the field's "Question for office" chip becomes a register RFI).
  'observation.converted_to_rfi',
  // #390: hours / time-entry events in the canonical audit journal so the
  // cross-job activity feed (#220) and per-job history include both the office
  // approvals pass — half the office's day — and the worker submissions that
  // feed it. Written best-effort (the payroll mutation never blocks on the
  // audit). targetType 'time_entry'. Bulk actions write ONE summarising entry
  // (metadata.entries carries the decided days), not N rows. submitted covers a
  // first submission (draft→submitted or create-as-submitted); resubmitted is a
  // rejected→submitted correction. Kept in sync with
  // src/domains/audit-log/schema.ts AUDIT_ACTIONS + api/audit-log.js.
  'hours.approved',
  'hours.rejected',
  'hours.reject_undone',
  'hours.reopened',
  'hours.bulk_approved',
  'hours.bulk_rejected',
  'hours.submitted',
  'hours.resubmitted',
  // #370: daywork register (api/dayworks.js). daywork.created on POST;
  // daywork.signed on the supervisor sign; daywork.transitioned on the
  // signed → invoiced change (metadata.from/to carry the direction);
  // daywork.amended when a signed/invoiced docket spawns a linked amendment.
  // targetType 'daywork'. Kept in sync with src/domains/audit-log/schema.ts.
  'daywork.created',
  'daywork.signed',
  'daywork.transitioned',
  'daywork.amended',
  // #371: pre-start readiness gate (api/job-readiness.js). One verb each for a
  // manual-checklist tick/un-tick, recording an override-with-reason, and
  // clearing it. targetType 'prestart'. Kept in sync with
  // src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'readiness.item_ticked',
  'readiness.overridden',
  'readiness.override_cleared',
  // #581: job-creating actions in the canonical journal — a money-relevant gap
  // (job creation left no trail). job.created fires on EVERY sanctioned job
  // write (Job Builder POST + won-quote convert); quote.converted fires on the
  // quote→job conversion (its own lifecycle event; its jobId is the NEW job so
  // it also surfaces in that job's feed). Best-effort after the write. Kept in
  // sync with src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'job.created',
  'quote.converted',
  // #349: job closeout lifecycle — job.closed freezes the final-numbers snapshot
  // (active/archived → complete); job.reopened reverses it (complete → active) so
  // the numbers can be corrected and closed out again. Prior snapshots are kept.
  'job.closed',
  'job.reopened',
  // #224: rule-based task generation — the builder's "Generate tasks" filled
  // matching areas from the task-rules set. targetType 'job'. Kept in sync with
  // src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'job.tasks_generated',
  // #219: safety documents (api/safety-docs.js). Kept in sync with
  // src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'safety_doc.uploaded',
  'safety_doc.acknowledged',
  // #231: commissioning documents + certificates register (api/certificates.js).
  'certificate.uploaded',
  // #276: per-job RFI register (api/rfis.js). rfi.created on raise; rfi.transitioned
  // on send/answer/close (one verb; metadata.from/to carry the direction).
  'rfi.created',
  'rfi.transitioned',
  // #210: site diary (api/diary.js). diary.created on the day's entry POST;
  // diary.amended on an append-only amendment (the original is never mutated).
  // targetType 'diary'. Kept in sync with src/domains/audit-log/schema.ts.
  'diary.created',
  'diary.amended',
  // #235: defect liability period. job.handover_set fires from the jobs PUT
  // whenever the handover / defect-period dates change and a handover date
  // remains; job.handover_cleared fires when the handover date is removed.
  // targetType 'job'. Kept in sync with src/domains/audit-log/schema.ts.
  'job.handover_set',
  'job.handover_cleared',
  // #217: per-job meeting-minutes register (api/job-minutes.js). minutes.recorded
  // on a new minute; minutes.amended on an append-only amendment (the original
  // body is never mutated). targetType 'minutes'. Kept in sync with
  // src/domains/audit-log/schema.ts.
  'minutes.recorded',
  'minutes.amended',
  // #230: services-locations register (api/services-locations.js) — where the
  // pit/board/meter/temp-supply are, with optional denormalised photos.
  // service_location.added on POST; service_location.updated on PATCH;
  // service_location.removed on DELETE. targetType 'service_location'. Kept in
  // sync with src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'service_location.added',
  'service_location.updated',
  'service_location.removed',
  // #283: site-instructions register (api/site-instructions.js). created on a
  // recorded instruction; transitioned on acknowledge / close. targetType
  // 'instruction'. Kept in sync with src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'instruction.created',
  'instruction.transitioned',
  // #760: owner runtime feature-flag control. One verb covers both the customer
  // launch-gate toggle and the owner-preview override; metadata.scope
  // ('customer'|'ownerPreview'), metadata.value (bool | null = cleared to
  // default) and metadata.previous carry the change. targetType 'feature_flag',
  // targetId is the flag key. Written best-effort (the toggle never blocks on the
  // audit). Kept in sync with src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'feature_flag.toggled',
]);
const VALID_TARGET_TYPES = new Set([
  'evidence',
  'snag',
  // E1a: 'itp_instance' is the per-job ITP we write/read most often.
  // 'itp_template' is reserved for the E2 template-editor rebuild —
  // accepted now so when E2 lands the verbs can write against it
  // without bouncing a schema migration through the storage layer.
  'itp_template',
  'itp_instance',
  // Onboarding (O1).
  'employee',
  'invite',
  // PR 6: observations as audit targets — observation.converted_to_snag uses
  // targetType='observation' so the conversion attributes to the observation
  // lifecycle (the snag also gets its own snag.created entry).
  'observation',
  // PR 11: Material Request module.
  'material_request',
  // #151: platform-level events (backups) with no business record target.
  'system',
  'document',
  'contact',
  // #331: worker licence/ticket records (workforce/credentials.json).
  'credential',
  // #332: per-job induction records (jobs/<id>/inductions.json).
  'induction',
  // #127/#333: leave / not-worked records (leave-requests.json).
  'leave',
  // #280: variation claim records (jobs/<id>/variations.json).
  'variation',
  // #390: timesheet day records (users/<id>/time-entries/<date>.json).
  'time_entry',
  // #370: daywork docket records (jobs/<id>/dayworks.json).
  'daywork',
  // #371: per-job pre-start readiness (jobs/<id>/prestart.json).
  'prestart',
  // #503: per-task proof review records (jobs/<id>/job-control.json proofReviews).
  'proof_review',
  // #581: a created job (job.created) and a converted quote (quote.converted).
  'job',
  'quote',
  // #219: per-job safety docs (jobs/<id>/safety-docs.json).
  'safety_doc',
  // #231: per-job certificates (jobs/<id>/certificates.json).
  'certificate',
  // #276: per-job RFI records (jobs/<id>/rfis.json).
  'rfi',
  // #210: per-job site diary entries (jobs/<id>/diary.json).
  'diary',
  // #217: per-job meeting-minutes records (jobs/<id>/minutes.json).
  'minutes',
  // #230: per-job services-locations records (jobs/<id>/services-locations.json).
  'service_location',
  // #283: per-job site-instructions records (jobs/<id>/site-instructions.json).
  'instruction',
  // #760: a feature flag (targetId = the flag key) for owner toggle/preview events.
  'feature_flag',
]);

const MAX_ENTRIES_PER_MONTH = 5000;
const TRIM_TO_PER_MONTH = 4000;

function _key(yyyymm) {
  return `audit/${yyyymm}.json`;
}

function _yyyymm(iso) {
  return String(iso).slice(0, 7);
}

async function readMonth(yyyymm) {
  const data = await readBlob(_key(yyyymm), { entries: [] });
  return Array.isArray(data && data.entries) ? data.entries : [];
}

/**
 * Append a single entry. Best-effort: caller wraps in `.catch(() => {})`
 * so a write failure on the journal never blocks the parent mutation.
 *
 * @param {{ action: string, actorId: string, actorName: string,
 *           actorRole?: string|null, jobId?: string|null,
 *           targetType: string, targetId: string, summary: string,
 *           metadata?: object }} payload
 */
async function append(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const action = String(payload.action || '');
  const targetType = String(payload.targetType || '');
  if (!VALID_ACTIONS.has(action)) return null;
  if (!VALID_TARGET_TYPES.has(targetType)) return null;
  const targetId = String(payload.targetId || '');
  if (!targetId) return null;

  const ts = new Date().toISOString();
  const id = nanoid('al_');
  const entry = {
    id,
    ts,
    action,
    actorId: String(payload.actorId || ''),
    actorName: String(payload.actorName || ''),
    actorRole: payload.actorRole == null ? null : String(payload.actorRole),
    jobId: payload.jobId == null ? null : String(payload.jobId),
    targetType,
    targetId,
    summary: String(payload.summary || '').slice(0, 240),
    ...(payload.metadata && typeof payload.metadata === 'object'
      ? { metadata: _shrinkMetadata(payload.metadata) }
      : {}),
  };

  const yyyymm = _yyyymm(ts);
  const entries = await readMonth(yyyymm);
  entries.push(entry);
  let trimmed = entries;
  if (entries.length > MAX_ENTRIES_PER_MONTH) {
    trimmed = entries.slice(-TRIM_TO_PER_MONTH);
  }
  await writeBlob(_key(yyyymm), { entries: trimmed });
  return entry;
}

function _shrinkMetadata(meta) {
  // Cap metadata JSON at ~2 KB so a runaway caller can't bloat the
  // monthly blob. Matches the same shrink pattern in job-audit.js.
  try {
    const s = JSON.stringify(meta);
    if (s.length <= 2048) return meta;
    return { _truncated: true, preview: s.slice(0, 2048) };
  } catch {
    return { _truncated: true };
  }
}

module.exports = {
  append,
  readMonth,
  // Exported read-only so observability surfaces (the Owner Console coverage
  // matrix — docs/owner-console.md) can derive which product areas write to
  // the canonical journal. Never mutate these Sets from a caller.
  VALID_ACTIONS,
  VALID_TARGET_TYPES,
  MAX_ENTRIES_PER_MONTH,
  TRIM_TO_PER_MONTH,
};
