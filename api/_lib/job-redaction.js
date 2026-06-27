// Role-based field redaction for job GET responses (#382).
//
// Job rows carry commercial figures (contract value, estimates, claim
// state) that only the admin tier may read. Writes were always admin-gated;
// READS returned whole rows to everyone — these helpers strip the money
// fields for non-admin viewers at the response boundary, so the figures
// never reach a tradie's phone or a client's browser console.
//
// Designed as a per-field AUDIENCE map (not a flat list) so follow-ups
// (#200 client visibility, #228 LH cost context) can widen individual
// fields to 'adminAndLH' etc. without restructuring. Today: everything
// admin-tier only.

const { isAdminRole, isLeadingHandRole } = require('./auth');

const FIELD_AUDIENCE = {
  contractValue:    'adminTier',
  labourEstimate:   'adminTier',
  materialEstimate: 'adminTier',
  claimedToDate:    'adminTier',
  paidToDate:       'adminTier',
  oldestClaimDays:  'adminTier',
  // #228: client + contract context — admin-tier only; never reaches the
  // field/LH/client payload (commercial-sensitive).
  clientReference:  'adminTier',
  contractNotes:    'adminTier',
  // #200: scope of work is commercial text — the office writes it, a
  // leading hand may READ it on site, a tradie's phone / client's browser
  // console never receives it.
  scopeOfWork:      'adminAndLH',
};

const REDACTED_FIELDS = Object.keys(FIELD_AUDIENCE);

/** A copy of `job` safe for `role` — admin tier gets the object UNTOUCHED
 *  (byte-identical responses for the surfaces that consume the figures). */
function redactJobForViewer(job, role) {
  if (isAdminRole(role)) return job;
  const lh = isLeadingHandRole(role);
  const out = { ...job };
  for (const [field, audience] of Object.entries(FIELD_AUDIENCE)) {
    if (!(field in out)) continue;
    if (audience === 'adminAndLH' && lh) continue;
    delete out[field];
  }
  return out;
}

module.exports = { redactJobForViewer, REDACTED_FIELDS, FIELD_AUDIENCE };
