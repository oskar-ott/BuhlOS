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
  // Phase D.5 (snags). One verb covers every status change; the
  // metadata.from / metadata.to fields carry the direction.
  'snag.created',
  'snag.transitioned',
  // Phase E1a (ITPs). One verb per legacy api/job-itps.js mutating
  // action: attach (admin attaches a template), point.recorded (worker
  // records a point — covers the auto-advance from pending →
  // in-progress and in-progress → witnessed since both ride the same
  // POST), signed_off (admin signs off — terminal), reopened (admin
  // reverses signoff), archived (admin/LH soft-archives an instance).
  // Kept in sync with src/domains/audit-log/schema.ts AUDIT_ACTIONS.
  'itp.attached',
  'itp.point.recorded',
  'itp.signed_off',
  'itp.reopened',
  'itp.archived',
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
  MAX_ENTRIES_PER_MONTH,
  TRIM_TO_PER_MONTH,
};
