// Allocation primitives moved to api/_lib/alloc-pg.js (app code) so the live
// dual-write mirror and this importer share ONE source of truth. Re-exported
// here for the importer + its tests' existing import path.
module.exports = require('../../../api/_lib/alloc-pg');
