// Hours sync-check engine moved to api/_lib/hours-sync-report.js (app code) so
// the scheduled cron route and this manual runner share ONE source of truth.
// Re-exported here for the importer + its tests' existing import path.
module.exports = require('../../../api/_lib/hours-sync-report');
