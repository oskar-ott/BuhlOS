// Shared shape-normaliser for the per-job Test & Tag register blob.
//
// jobs/<id>/tags.json comes in TWO shapes: legacy rows (pre-#397) are a BARE
// ARRAY `[ ... ]`; modern rows are `{ tags: [ ... ] }`. Every reader must accept
// both, or legacy tags silently vanish — from the register page (#641 fixed the
// page), AND from the expiry feed, the daily reminder cron and the job-stats
// counts (this helper fixes those). ONE definition, used everywhere, so the
// readers can never drift.
//
// Returns the tags array for any input; anything unrecognised → [] (never throws).
function tagsFromBlob(blob) {
  if (Array.isArray(blob)) return blob;
  if (blob && Array.isArray(blob.tags)) return blob.tags;
  return [];
}

module.exports = { tagsFromBlob };
