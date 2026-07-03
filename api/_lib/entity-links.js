'use strict';

// Epic 5 (#212) — pure cross-sheet linking helpers. No SQL, no IO.
//
// A drawing set is a web, not a pile. This module derives:
//   * board SIGHTINGS — everywhere a board identifier appears (schedule
//     tables #207, board pins #211), normalised for exact matching
//   * link PROPOSALS — same identifier on two different pages ⇒ one
//     proposed 'same-board' link per (identifier, page pair). Exact
//     matches only (board refs are usually literal, like "DB-1") —
//     nothing fuzzy, and nothing takes effect until a human confirms.
//   * reference RESOLUTION — detected "refer E-501" callouts matched
//     against the sheet registry's effective sheet numbers; unresolved
//     stays unresolved, listed honestly.

// "DB-1", "db 1", "DB–1" → "DB-1"-ish canonical form for exact matching.
function normaliseIdentifier(text) {
  return String(text || '')
    .toUpperCase()
    .replace(/[‐-―]/g, '-') // unicode dashes
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .trim();
}

function pageKeyOf(planId, pageIndex) {
  return planId + ':' + pageIndex;
}

/**
 * Collect board sightings from schedule tables and board pins.
 *   scheduleTables — live #207 rows (board_identifier nullable)
 *   boardPins      — #211 rows
 * Returns [{ identifier, normalised, planId, pageIndex, source }]
 */
function boardSightings(scheduleTables, boardPins) {
  const out = [];
  for (const t of scheduleTables) {
    if (!t.board_identifier) continue;
    out.push({
      identifier: t.board_identifier,
      normalised: normaliseIdentifier(t.board_identifier),
      planId: t.plan_id,
      pageIndex: t.page_index,
      source: 'schedule',
    });
  }
  for (const p of boardPins) {
    out.push({
      identifier: p.board_identifier,
      normalised: normaliseIdentifier(p.board_identifier),
      planId: p.plan_id,
      pageIndex: p.page_index,
      source: 'pin',
    });
  }
  return out.filter((s) => s.normalised.length > 0);
}

/**
 * Exact-match link proposals across DIFFERENT pages. One proposal per
 * (identifier, unordered page pair); sides are canonically ordered so a
 * pair can never appear twice. Existing links (any status) suppress
 * re-proposal — rejecting a proposal must stick.
 */
function proposeBoardLinks(sightings, existingLinks) {
  const seen = new Set(
    existingLinks.map((l) =>
      [l.kind, l.identifier, l.a_plan_id, l.a_page_index, l.b_plan_id, l.b_page_index].join('|'),
    ),
  );
  const byIdentifier = new Map();
  for (const s of sightings) {
    const arr = byIdentifier.get(s.normalised) || [];
    arr.push(s);
    byIdentifier.set(s.normalised, arr);
  }
  const proposals = [];
  const emitted = new Set();
  for (const [normalised, list] of byIdentifier) {
    // unique pages this identifier appears on
    const pages = new Map();
    for (const s of list) {
      const key = pageKeyOf(s.planId, s.pageIndex);
      if (!pages.has(key)) pages.set(key, s);
    }
    const uniq = [...pages.values()].sort((a, b) =>
      pageKeyOf(a.planId, a.pageIndex).localeCompare(pageKeyOf(b.planId, b.pageIndex)),
    );
    for (let i = 0; i < uniq.length; i += 1) {
      for (let j = i + 1; j < uniq.length; j += 1) {
        const a = uniq[i];
        const b = uniq[j];
        const sig = ['same-board', normalised, a.planId, a.pageIndex, b.planId, b.pageIndex].join('|');
        if (seen.has(sig) || emitted.has(sig)) continue;
        emitted.add(sig);
        proposals.push({
          kind: 'same-board',
          identifier: normalised,
          aPlanId: a.planId,
          aPageIndex: a.pageIndex,
          bPlanId: b.planId,
          bPageIndex: b.pageIndex,
          // literal identifier equality — high confidence, still human-gated
          confidence: 0.9,
          evidence: `"${a.identifier}" (${a.source}) and "${b.identifier}" (${b.source}) match exactly`,
        });
      }
    }
  }
  return proposals;
}

/**
 * Resolve detected reference callouts against the sheet registry — LIVE,
 * so corrections to sheet numbers re-resolve without re-extraction.
 *   refs   — sheet_refs rows [{ target_sheet_number, ... }]
 *   sheets — [{ planId, pageIndex, sheetNumber }] effective values
 * Returns refs decorated with { resolved: {planId, pageIndex} | null }.
 */
function resolveRefs(refs, sheets) {
  const byNumber = new Map();
  for (const s of sheets) {
    if (!s.sheetNumber) continue;
    const key = normaliseIdentifier(s.sheetNumber);
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key).push(s);
  }
  return refs.map((r) => {
    const targets = byNumber.get(normaliseIdentifier(r.target_sheet_number)) || [];
    // self-references (title block naming its own sheet) resolve to nothing
    const external = targets.filter(
      (t) => !(t.planId === r.plan_id && t.pageIndex === r.page_index),
    );
    return { ...r, resolved: external.length ? { planId: external[0].planId, pageIndex: external[0].pageIndex } : null };
  });
}

/**
 * Pages that should warn about duplicate counting: any live link
 * (proposed OR confirmed — a proposal is already a reason to check)
 * whose BOTH sides carry live accepted counts.
 *   links — entity_links rows (status proposed|confirmed)
 *   countedPageKeys — Set of 'planId:pageIndex' with ≥1 live accepted count
 * Returns Map pageKey → [{ otherPlanId, otherPageIndex, identifier, status }]
 */
function duplicateCountWarnings(links, countedPageKeys) {
  const out = new Map();
  const add = (key, warning) => {
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(warning);
  };
  for (const l of links) {
    if (l.status !== 'proposed' && l.status !== 'confirmed') continue;
    const aKey = pageKeyOf(l.a_plan_id, l.a_page_index);
    const bKey = pageKeyOf(l.b_plan_id, l.b_page_index);
    if (!countedPageKeys.has(aKey) || !countedPageKeys.has(bKey)) continue;
    add(aKey, {
      otherPlanId: l.b_plan_id,
      otherPageIndex: l.b_page_index,
      identifier: l.identifier,
      status: l.status,
    });
    add(bKey, {
      otherPlanId: l.a_plan_id,
      otherPageIndex: l.a_page_index,
      identifier: l.identifier,
      status: l.status,
    });
  }
  return out;
}

module.exports = {
  normaliseIdentifier,
  pageKeyOf,
  boardSightings,
  proposeBoardLinks,
  resolveRefs,
  duplicateCountWarnings,
};
