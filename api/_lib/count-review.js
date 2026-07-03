'use strict';

// Epic 5 (#205) — pure derivation over the count-review state model:
// raw detections (immutable) → review actions (append-only) → effective
// markers → counts. No SQL, no IO: rows in, derived state out, so the whole
// verify loop is unit-testable and the server is the single place the
// derivation runs (the UI renders what this returns, it never re-derives).

function markerKeyForDetection(id) {
  return 'd:' + id;
}

function markerKeyForReview(id) {
  return 'r:' + id;
}

/**
 * Replay the append-only review actions over one page raster's immutable
 * detections and return the effective marker set.
 *
 * detections: device_detections rows for ONE (job, plan, page, sha) — any
 * kind; 'device' rows become markers, 'uncertain-region' rows pass through.
 * reviews: detection_reviews rows for the same raster.
 *
 * Per-target semantics, applied in created_at (then id) order:
 *   delete     → marker dead (false positive)
 *   restore    → marker live again (undo a delete)
 *   reclassify → marker live with the action's entry/label (asserting a
 *                marker's type implies asserting it exists)
 *   add        → a new human marker keyed by the add-action's own row id
 * Actions against markers not on this raster are ignored (honest no-op —
 * they can exist after a page re-render changed the sha).
 */
function deriveMarkers(detections, reviews) {
  const markers = new Map();
  const uncertain = [];
  for (const d of detections) {
    if (d.kind === 'uncertain-region') {
      uncertain.push(d);
      continue;
    }
    if (d.kind !== 'device') continue;
    const key = markerKeyForDetection(d.id);
    markers.set(key, {
      key,
      source: 'ai',
      detectionId: d.id,
      reviewId: null,
      bbox: d.bbox,
      legendEntryId: d.legend_entry_id,
      label: d.label,
      confidence: d.confidence,
      status: 'live',
      appliedReviewIds: [],
    });
  }
  const ordered = [...reviews].sort((a, b) => {
    const ta = String(a.created_at);
    const tb = String(b.created_at);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
  for (const r of ordered) {
    if (r.action === 'add') {
      const key = markerKeyForReview(r.id);
      markers.set(key, {
        key,
        source: 'human',
        detectionId: null,
        reviewId: r.id,
        bbox: r.bbox,
        legendEntryId: r.legend_entry_id,
        label: r.label,
        confidence: null,
        status: 'live',
        appliedReviewIds: [r.id],
      });
      continue;
    }
    const key = r.target_detection_id
      ? markerKeyForDetection(r.target_detection_id)
      : r.target_review_id
        ? markerKeyForReview(r.target_review_id)
        : null;
    const m = key ? markers.get(key) : null;
    if (!m) continue;
    m.appliedReviewIds.push(r.id);
    if (r.action === 'delete') {
      m.status = 'deleted';
    } else if (r.action === 'restore') {
      m.status = 'live';
    } else if (r.action === 'reclassify') {
      m.legendEntryId = r.legend_entry_id;
      m.label = r.label;
      m.status = 'live';
    }
  }
  return { markers: [...markers.values()], uncertain };
}

/**
 * Group effective markers per legend entry. removed/added tallies ride along
 * so the surface can say "12 (2 removed, 1 added by review)" — the human
 * always sees how much the raw AI number was corrected.
 */
function countsByEntry(markers) {
  const by = new Map();
  for (const m of markers) {
    const groupKey = m.legendEntryId || '(unlabelled)';
    let g = by.get(groupKey);
    if (!g) {
      g = {
        legendEntryId: m.legendEntryId,
        label: m.label,
        liveCount: 0,
        removedCount: 0,
        addedCount: 0,
        liveKeys: [],
      };
      by.set(groupKey, g);
    }
    if (!g.label && m.label) g.label = m.label;
    if (m.status === 'live') {
      g.liveCount += 1;
      g.liveKeys.push(m.key);
      if (m.source === 'human') g.addedCount += 1;
    } else {
      g.removedCount += 1;
    }
  }
  return [...by.values()].sort(
    (a, b) =>
      b.liveCount - a.liveCount || String(a.label).localeCompare(String(b.label)),
  );
}

/**
 * An accepted count is stale when the CURRENT live marker keys for its entry
 * no longer match the snapshot it counted — count-equality is not enough
 * (a delete plus an add nets the same number over different instances).
 */
function isAcceptStale(accepted, markers) {
  const current = markers
    .filter((m) => m.status === 'live' && m.legendEntryId === accepted.legend_entry_id)
    .map((m) => m.key)
    .sort();
  const basis = accepted.basis || {};
  const snap = Array.isArray(basis.markerKeys) ? [...basis.markerKeys].sort() : [];
  if (current.length !== snap.length) return true;
  return current.some((k, i) => k !== snap[i]);
}

module.exports = {
  deriveMarkers,
  countsByEntry,
  isAcceptStale,
  markerKeyForDetection,
  markerKeyForReview,
};
