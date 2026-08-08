// Hours go-live epoch — the first day the company logged real hours in
// BuhlOS (production go-live, Monday 2026-08-03). Everything dated before
// this is pre-launch test data territory: the app must never ASK for hours
// from before it existed in the field.
//
// Consumed by the server-side missing-day detection
// (api/time-entries-overview.js), which is the single source of truth every
// surface mirrors (admin /hours board, weekly closeout, command-centre
// needs-you, Phil week). Flooring it here floors them all.
//
// This is a company-level floor, not a per-worker start date — a worker who
// joins later still shows "missing" from their first assigned week; that is
// a separate (real) concern.
const HOURS_GO_LIVE = '2026-08-03';

module.exports = { HOURS_GO_LIVE };
