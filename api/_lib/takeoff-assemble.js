'use strict';

// Epic 5 (#213) — pure takeoff assembly. No SQL, no IO, NO MODEL CALLS:
// human-accepted rows in, ordered line items with provenance out.
// Correctness and provenance integrity are the entire job.
//
// The philosophy line this module enforces: only HUMAN-ACCEPTED extractions
// assemble by default. Cable estimates are accepted-but-heuristic, so their
// lines carry estimate=true and stay visually estimates all the way into
// Epic 7. Anything else unverified simply is not here.

// Effective cell text for a schedule row (#202/#207): human corrections win.
function effectiveCell(row, column) {
  const human = row.human_cells || {};
  if (Object.prototype.hasOwnProperty.call(human, column)) {
    return human[column];
  }
  const cell = (row.cells || {})[column];
  return cell ? cell.value : null;
}

// Verbatim qty cells are strings — parse strictly, never invent. "12" → 12;
// "2 + 2", "TBC", "" → null (the line flags itself for a human qty).
function parseQty(text) {
  if (text === null || text === undefined) return null;
  const m = String(text).trim().match(/^\d{1,5}$/);
  return m ? Number(m[0]) : null;
}

/**
 * Assemble line items from the accepted seams.
 *   acceptedCounts — #205 liveAcceptedCounts rows
 *   scheduleTables — #202/#207 live tables
 *   scheduleRows   — rows for those tables (accepted|edited only are used)
 *   cableRuns      — #211 acceptedCableRuns rows
 *   warningsByPage — #212 duplicateCountWarnings Map pageKey → [...]
 *
 * Returns { lines, warnings } — lines ordered device counts → schedule
 * rows → cable estimates, each carrying source type + provenance + flags.
 */
function assembleLines(input) {
  const {
    acceptedCounts = [],
    scheduleTables = [],
    scheduleRows = [],
    cableRuns = [],
    warningsByPage = new Map(),
  } = input;
  const lines = [];
  const warnings = [];
  const pageKey = (planId, pageIndex) => planId + ':' + pageIndex;

  // ── device counts (#205) — the primary input ──
  const counts = [...acceptedCounts].sort(
    (a, b) =>
      String(a.label).localeCompare(String(b.label)) ||
      String(a.plan_id).localeCompare(String(b.plan_id)) ||
      a.page_index - b.page_index,
  );
  for (const c of counts) {
    const pageWarnings = warningsByPage.get(pageKey(c.plan_id, c.page_index)) || [];
    if (pageWarnings.length) {
      warnings.push({
        kind: 'duplicate-scope',
        planId: c.plan_id,
        pageIndex: c.page_index,
        detail: pageWarnings
          .map((w) => `${w.identifier} also on ${w.otherPlanId} p${w.otherPageIndex + 1} (${w.status})`)
          .join('; '),
      });
    }
    lines.push({
      sourceType: 'device-count',
      description: c.label,
      qty: c.count,
      unit: 'ea',
      estimate: false,
      flagged: pageWarnings.length > 0,
      flagReason: pageWarnings.length > 0 ? 'possible duplicate scope — see warnings' : null,
      provenance: {
        planId: c.plan_id,
        pageIndex: c.page_index,
        pageSha256: c.page_sha256,
        acceptedCountId: c.id,
        acceptedBy: c.accepted_by_label,
        acceptedAt: c.accepted_at,
        markerKeys: (c.basis || {}).markerKeys || [],
      },
    });
  }

  // ── schedule rows (#202/#207) — accepted/edited rows only ──
  const tableById = new Map(scheduleTables.map((t) => [t.id, t]));
  const reviewedRows = scheduleRows
    .filter((r) => r.status === 'accepted' || r.status === 'edited')
    .filter((r) => tableById.has(r.table_id))
    .sort((a, b) => {
      const ta = tableById.get(a.table_id);
      const tb = tableById.get(b.table_id);
      return (
        String(ta.table_kind).localeCompare(String(tb.table_kind)) ||
        String(ta.board_identifier || '').localeCompare(String(tb.board_identifier || '')) ||
        a.row_index - b.row_index
      );
    });
  for (const r of reviewedRows) {
    const t = tableById.get(r.table_id);
    if (t.table_kind === 'lighting') {
      const typeCode = effectiveCell(r, 'typeCode');
      const desc = effectiveCell(r, 'description');
      const qty = parseQty(effectiveCell(r, 'qty'));
      lines.push({
        sourceType: 'schedule-row',
        description: [typeCode, desc].filter(Boolean).join(' — ') || '(schedule row)',
        qty,
        unit: 'ea',
        estimate: false,
        flagged: qty === null,
        flagReason: qty === null ? 'schedule qty cell not a plain number — set the quantity' : null,
        provenance: {
          planId: t.plan_id,
          pageIndex: t.page_index,
          pageSha256: t.page_sha256,
          tableId: t.id,
          rowId: r.id,
          tableKind: t.table_kind,
        },
      });
    } else {
      // switchboard rows are circuit entries, not supply quantities — they
      // assemble as qty-1 board-scope lines a human can adjust or drop.
      const circuitRef = effectiveCell(r, 'circuitRef');
      const desc = effectiveCell(r, 'description');
      lines.push({
        sourceType: 'schedule-row',
        description:
          [t.board_identifier, circuitRef, desc].filter(Boolean).join(' — ') || '(circuit row)',
        qty: 1,
        unit: 'cct',
        estimate: false,
        flagged: false,
        flagReason: null,
        provenance: {
          planId: t.plan_id,
          pageIndex: t.page_index,
          pageSha256: t.page_sha256,
          tableId: t.id,
          rowId: r.id,
          tableKind: t.table_kind,
          boardIdentifier: t.board_identifier,
        },
      });
    }
  }

  // ── cable estimates (#211) — accepted runs, per board, ALWAYS estimates ──
  const runs = [...cableRuns].sort(
    (a, b) =>
      String(a.plan_id).localeCompare(String(b.plan_id)) || a.page_index - b.page_index,
  );
  for (const run of runs) {
    const results = run.results || {};
    for (const board of results.boards || []) {
      lines.push({
        sourceType: 'cable-estimate',
        description: `Cable runs to ${board.boardIdentifier} (heuristic estimate)`,
        qty: Math.round((board.totalMm / 1000) * 10) / 10,
        unit: 'm',
        estimate: true,
        flagged: false,
        flagReason: null,
        provenance: {
          planId: run.plan_id,
          pageIndex: run.page_index,
          pageSha256: run.page_sha256,
          cableRunId: run.id,
          boardIdentifier: board.boardIdentifier,
          deviceCount: board.deviceCount,
          factors: run.factors,
          acceptedBy: run.accepted_by_label,
        },
      });
    }
  }

  return { lines, warnings };
}

module.exports = { assembleLines, effectiveCell, parseQty };
