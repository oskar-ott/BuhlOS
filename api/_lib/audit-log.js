// Cross-surface audit log storage (Phase D2 bootstrap).
//
// Monthly rollover blobs at  audit/<yyyy-mm>.json
//   { entries: [{ id, ts, action, actorId, actorName, actorRole, jobId,
//                  targetType, targetId, summary, metadata? }] }
//
// Append-only — this module exposes only `append()` and a read helper.
// No update / delete API.
//
// #355: `append(payload, { blocking })` supports two durability classes.
// Default best-effort: a write failure never blocks the parent mutation, but is
// now OBSERVABLE (console.error + a best-effort #154 error-journal mirror)
// instead of silently swallowed. Blocking: a write failure THROWS so a
// compliance-relevant / destructive mutation can't outrun its audit entry
// (today: the job-delete tombstone). This is NOT transactional — blobs have no
// two-phase commit and the monthly journal still has a read-modify-write race
// (#157 applies to the journal blobs themselves); "blocking" means the caller
// LEARNS about a failed audit write, not that audit+mutation are atomic.
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
  // #262: AI photo labels. `labels_suggested` fires once per classify batch
  // (metadata: model, promptVersion, counts); `labels_corrected` per human
  // add/accept/remove. #267: `defect_suggestion_dismissed` records the sticky
  // per-photo dismissal. Kept in sync with src/domains/audit-log/schema.ts.
  'evidence.labels_suggested',
  'evidence.labels_corrected',
  'evidence.defect_suggestion_dismissed',
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
  // Crew sign-up link (public self-signup + admin review gate). Metadata only
  // — never PIN/pinHash. Kept in sync with src/domains/audit-log/schema.ts.
  'signup.submitted',
  'signup.link_created',
  'signup.link_updated',
  'signup.approved',
  'signup.rejected',
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
  // #197: Epic 5 page understanding — an AI extraction ran / a human
  // reviewed-and-corrected an AI-read field (api/ai-drawings.js).
  'document.ai_extracted',
  'document.ai_corrected',
  // #203: Epic 5 revision diff — a comparison ran (classic CV, no AI) / a
  // human walked a changed region (api/ai-drawings.js).
  'document.revision_diffed',
  'document.diff_region_reviewed',
  // #205: Epic 5 count review — a human accepted a device count after the
  // marker verify loop (api/ai-drawings.js).
  'document.count_accepted',
  // #211: Epic 5 cable estimates — sheet calibrated / heuristic run computed,
  // and a human accepted an estimate (api/ai-drawings.js).
  'document.cable_estimated',
  'document.cable_estimate_accepted',
  // #213: Epic 5 takeoff — an estimator signed off an assembled takeoff
  // (api/ai-drawings.js). Only signed-off takeoffs reach quoting.
  'document.takeoff_signed_off',
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
  // #372: PROGRESS-claim register (jobs/<id>/claims.json). Kept in sync with
  // src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'claim.created',
  'claim.submitted',
  'claim.status_changed',
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
  // 2026-07-26 owner-directed: a content edit of a still-submitted (undecided)
  // entry — the worker (or staff) changed a sent day before the office decided.
  'hours.edited_while_submitted',
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
  // #760 PR2: owner per-feature config knob change. metadata.featureKey/key and
  // metadata.from/to carry the change. targetType 'feature_config', targetId is
  // '<featureKey>.<key>'. Best-effort. Kept in sync with schema.ts AUDIT_ACTIONS.
  'feature_config.changed',
  // #170: the AI assistant generated a job summary (api/ai-assistant.js).
  // targetType 'job'; metadata carries model + token usage. Best-effort. Kept
  // in sync with src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'ai.job_summarised',
  // 2026-07 AI batch. #347: a stored insights digest was generated
  // (targetType 'system'; metadata carries model + finding count + grounding
  // outcome). #373: contract-obligation extraction run + per-item acceptance
  // (targetType 'job'). Kept in sync with src/domains/audit-log/schema.ts.
  'ai.digest_generated',
  // #171: a stored office daily summary was generated (targetType 'system';
  // metadata carries model + phrasing outcome). Kept in sync with
  // src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'ai.office_summary_generated',
  'job.contract_obligations_extracted',
  'job.contract_obligation_accepted',
  // #366: scope-vs-quote reconciliation — the office's resolve-or-accept
  // decision on an engine-named finding (resolved = conflict fixed; accepted =
  // lived with, with a required reason in metadata.reason). targetType
  // 'scope_reconciliation', targetId is the deterministic findingKey. Written
  // best-effort by the reconciliation confirm route. Kept in sync with
  // src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'scope.finding_resolved',
  'scope.finding_accepted',
  // #355: destructive-delete TOMBSTONE. A job's per-job audit blob dies with the
  // job (api/jobs.js DELETE), so a cross-surface tombstone is written to THIS
  // durable journal BEFORE the erase, capturing who/when/jobId/summary so the
  // deleted job's existence survives its own trail. Written with { blocking:true }
  // — the erase must not outrun the tombstone. targetType 'job', targetId is the
  // deleted job's id. Kept in sync with src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'job.deleted',
  // #247: Xero connection lifecycle (api/xero/*.js). connect_started on the
  // OAuth start; connected when the code exchange lands (metadata.
  // organisationCount); organisation_selected on the explicit (or single-org
  // auto) tenant choice (metadata.externalTenantId, metadata.auto);
  // connection_checked on an on-demand health check (ok or errorCategory);
  // refresh_failed on a TERMINAL refresh failure (reconnect required);
  // disconnected written BEFORE the credential row is hard-deleted (metadata.
  // revokedAtProvider). Best-effort per #355's default policy — all states are
  // recoverable via reconnect. NEVER carries tokens, codes or OAuth response
  // bodies. targetType 'integration', targetId 'xero'. Kept in sync with
  // src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'xero.connect_started',
  'xero.connected',
  'xero.organisation_selected',
  'xero.connection_checked',
  'xero.refresh_failed',
  'xero.disconnected',
  // #610: a reference-data refresh ran (metadata.results carries per-group
  // ok/failed + counts + error categories — partial outcomes stay honest).
  'xero.reference_synced',
  // #248: explicit worker↔employee mapping changes (api/xero/worker-mappings.js).
  // worker_mapped covers confirm AND remap (metadata.previousEmployeeId set on
  // remap); worker_unmapped on removal. targetType 'xero_mapping', targetId is
  // the BuhlOS worker id; metadata carries the Xero side by immutable id.
  'xero.worker_mapped',
  'xero.worker_unmapped',
  // #611: work-type ↔ earnings-rate mapping changes (api/xero/worktype-mappings.js).
  'xero.worktype_mapped',
  'xero.worktype_unmapped',
  // #893: payroll-batch lifecycle (api/xero/payroll-batches.js). Every verb is
  // ALSO evented in public.payroll_batch_events (the in-store history); the
  // journal carries the cross-surface record. targetType 'payroll_batch',
  // targetId is the batch uuid. No verb here writes to Xero.
  'payroll.batch_created',
  'payroll.batch_correction_created',
  'payroll.batch_locked',
  'payroll.batch_unlocked',
  'payroll.batch_deleted',
  // #249: draft-timesheet export to Xero (api/xero/payroll-export.js). The
  // per-worker lifecycle is also in public.payroll_batch_timesheet_events.
  'payroll.export_previewed',
  'payroll.exported_to_xero',
  'payroll.export_retried',
  'xero.sync_retried',
  'xero.sync_acknowledged',
  'payroll.reconciled',
  // #895: batch-snapshot CSV fallback download (no Xero write).
  'payroll.csv_downloaded',
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
  // Crew sign-up link requests + link lifecycle.
  'signup',
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
  // #372: progress-claim records (jobs/<id>/claims.json).
  'claim',
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
  // #760 PR2: a feature config knob (targetId = '<featureKey>.<key>').
  'feature_config',
  // #366: per-job scope reconciliation (jobs/<id>/scope-reconciliation.json);
  // targetId is the finding's deterministic key.
  'scope_reconciliation',
  // #247: an external integration connection (targetId = provider, e.g. 'xero').
  'integration',
  // #248: a worker↔Xero-employee link (targetId = the BuhlOS worker id).
  'xero_mapping',
  // #893: a durable payroll batch (targetId = the batch uuid).
  'payroll_batch',
  'xero_sync_item',
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

// #355: silent drops become visible. A dropped audit entry — a rejected
// unknown action, or a swallowed best-effort write failure — used to vanish
// with no trace. Route the context (action, actor, target) to console.error so
// the drop is at least searchable in the function logs, and, when clean, mirror
// it into the #154 error journal so it also surfaces on the platform error
// board. This helper NEVER throws (it wraps the mirror in its own try/catch, and
// appendError is itself best-effort) so making a drop observable can't itself
// take down the parent request.
function _observeDrop(reason, payload, err) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const ctx = {
    action: String(p.action || ''),
    actorId: String(p.actorId || ''),
    targetType: String(p.targetType || ''),
    targetId: String(p.targetId || ''),
  };
  console.error(
    `audit-log append dropped (${reason})`,
    ctx,
    err && err.message ? `— ${err.message}` : ''
  );
  try {
    // Lazy-require so a cycle or a reporter fault can't break audit-log load.
    const { appendError } = require('./error-log');
    void appendError({
      source: 'api',
      handler: 'audit-log.append',
      message: `audit entry dropped (${reason})${err && err.message ? `: ${err.message}` : ''}`,
      severity: 'warning',
      jobId: p.jobId == null ? null : String(p.jobId),
      metadata: { reason, ...ctx },
    });
  } catch (e) {
    console.error('audit-log drop → error-log mirror failed (swallowed)', e && e.message);
  }
}

/**
 * Append a single entry.
 *
 * Default (best-effort): a write failure or an unknown action never blocks the
 * parent mutation — the failure is now OBSERVABLE (console.error + best-effort
 * error-journal mirror, #355) rather than silently swallowed, and null is
 * returned. Existing callers wrap in `.catch(() => {})` and are unchanged.
 *
 * Blocking (`append(payload, { blocking: true })`): a write failure THROWS to
 * the caller so a compliance-relevant or destructive mutation cannot outrun its
 * audit entry. An unknown action / invalid payload still returns null (a bad
 * payload is a programming error, not a storage failure — blocking can't make an
 * unregistered verb land). Used by the job-delete tombstone (#355).
 *
 * @param {{ action: string, actorId: string, actorName: string,
 *           actorRole?: string|null, jobId?: string|null,
 *           targetType: string, targetId: string, summary: string,
 *           metadata?: object }} payload
 * @param {{ blocking?: boolean }} [options]
 */
async function append(payload, options = {}) {
  const blocking = !!(options && options.blocking);
  if (!payload || typeof payload !== 'object') {
    _observeDrop('invalid-payload', payload);
    return null;
  }
  const action = String(payload.action || '');
  const targetType = String(payload.targetType || '');
  if (!VALID_ACTIONS.has(action)) {
    _observeDrop('unknown-action', payload);
    return null;
  }
  if (!VALID_TARGET_TYPES.has(targetType)) {
    _observeDrop('unknown-target-type', payload);
    return null;
  }
  const targetId = String(payload.targetId || '');
  if (!targetId) {
    _observeDrop('missing-target-id', payload);
    return null;
  }

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

  try {
    const yyyymm = _yyyymm(ts);
    const entries = await readMonth(yyyymm);
    entries.push(entry);
    let trimmed = entries;
    if (entries.length > MAX_ENTRIES_PER_MONTH) {
      trimmed = entries.slice(-TRIM_TO_PER_MONTH);
    }
    await writeBlob(_key(yyyymm), { entries: trimmed });
    return entry;
  } catch (err) {
    // #355: blocking callers get the failure; best-effort callers get an
    // observable drop (never swallowed silently) and null. Ordering caveat
    // documented per-caller: the tombstone is written BEFORE the erase, so a
    // throw here leaves the erase un-run (safe), not a phantom tombstone.
    if (blocking) throw err;
    _observeDrop('write-failed', payload, err);
    return null;
  }
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
