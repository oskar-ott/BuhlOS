'use strict';

// ITP builder — pure model helpers shared by the handler, the store and the
// tests (developer handoff 2026-11-02). No I/O, no env.
//
//   contentKey(areas)     fingerprint of what a PDF holds — the photos (ids)
//                         and their captions, per area. A PDF is "out of
//                         date" when the live fingerprint of ITS OWN areas no
//                         longer matches the one stamped when it was made.
//                         Additions, removals and caption edits all count;
//                         renaming an area or the PDF does not (P7: the badge
//                         says exactly "photos changed", nothing looser).
//   defaultPdfName(...)   "All areas" when every area is in, else the ticked
//                         area names joined with ", " (capped at 120 chars).
//   snapshotFor(...)      the areas + photos a PDF prints, in capture order.
//   isEmailAddress(s)     the one address check the Email sheet relies on.

const crypto = require('crypto');

const MAX_NAME = 120;

function contentKey(areas) {
  const parts = [];
  const sorted = [...(areas || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const a of sorted) {
    for (const p of a.photos || []) {
      parts.push(`${a.id}|${p.id}|${p.caption || ''}`);
    }
  }
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

function defaultPdfName(selectedAreas, totalAreaCount) {
  if (!selectedAreas.length) return 'All areas';
  if (selectedAreas.length >= totalAreaCount) return 'All areas';
  const joined = selectedAreas.map((a) => String(a.name || '').trim()).filter(Boolean).join(', ');
  return joined.length > MAX_NAME ? joined.slice(0, MAX_NAME - 1).trimEnd() + '…' : joined || 'All areas';
}

/** The areas a PDF covers, in the report's capture order, with the photo
 *  facts the composer needs. Unknown ids are dropped (an area removed since
 *  the pick simply isn't there). */
function snapshotFor(report, areaIds) {
  const wanted = new Set(areaIds || []);
  const areas = (report.areas || []).filter((a) => wanted.has(a.id));
  return {
    areas: areas.map((a) => ({
      id: a.id,
      name: a.name,
      photos: (a.photos || []).map((p) => ({ id: p.id, url: p.url, caption: p.caption || '' })),
    })),
  };
}

function countPhotos(areas) {
  return (areas || []).reduce((n, a) => n + ((a.photos && a.photos.length) || 0), 0);
}

/** Live fingerprint of the given areas of a report (missing areas excluded). */
function liveContentKey(report, areaIds) {
  return contentKey(snapshotFor(report, areaIds).areas);
}

function isEmailAddress(s) {
  const v = String(s == null ? '' : s).trim();
  if (v.length < 6 || v.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

module.exports = {
  MAX_NAME,
  contentKey,
  defaultPdfName,
  snapshotFor,
  countPhotos,
  liveContentKey,
  isEmailAddress,
};
