// Status normalisation for stages and snags. Centralised so we don't scatter
// string comparisons through the app.

const STAGE_STATUSES = [
  'not-started', 'ready', 'in-progress', 'blocked',
  'pending-sync', 'pending-validation',
  'submitted', 'review', 'done', 'reopened',
];

function normaliseStageStatus(v) {
  if (!v) return 'not-started';
  const k = String(v).trim().toLowerCase().replace(/[ _]/g, '-');
  if (k === 'complete' || k === 'completed') return 'done';
  if (k === 'inprogress') return 'in-progress';
  if (k === 'notstarted' || k === '') return 'not-started';
  if (STAGE_STATUSES.includes(k)) return k;
  return 'not-started';
}

// Mapping back to the human display labels Phil and Switchboard already use.
const STAGE_LABELS = {
  'not-started':        'Not started',
  'ready':              'Ready',
  'in-progress':        'In progress',
  'blocked':            'Blocked',
  'pending-sync':       'Pending sync',
  'pending-validation': 'Pending validation',
  'submitted':          'Submitted',
  'review':             'Review',
  'done':               'Done',
  'reopened':           'Reopened',
};
function stageLabel(v) { return STAGE_LABELS[normaliseStageStatus(v)] || 'Not started'; }

const SNAG_STATUSES = ['Open', 'Resolved', 'Closed', 'Reopened'];
function normaliseSnagStatus(v) {
  if (!v) return 'Open';
  const lc = String(v).trim().toLowerCase();
  if (lc === 'open')     return 'Open';
  if (lc === 'resolved') return 'Resolved';
  if (lc === 'closed')   return 'Closed';
  if (lc === 'reopened') return 'Reopened';
  return 'Open';
}

module.exports = {
  STAGE_STATUSES, STAGE_LABELS, SNAG_STATUSES,
  normaliseStageStatus, stageLabel, normaliseSnagStatus,
};
