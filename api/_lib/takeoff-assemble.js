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

// #882 — a quantity the LEGEND ITSELF tabulates, read from an entry's own
// text ("49 EA", "2.34 m²"). Strict, never invented: only these unit forms,
// `ea` must be whole. KEEP IN PARITY with the client twin
// (src/domains/ai-drawings/legend-qty.ts) — legend-qty.test.ts pins both.
const LEGEND_QTY_RE = /(?:^|[\s(])(\d{1,5}(?:\.\d{1,2})?)\s*(ea|m2|m²|lm|m)(?=$|[\s).,;:])/i;
function parseLegendQty(text) {
  if (text === null || text === undefined) return null;
  const m = String(text).match(LEGEND_QTY_RE);
  if (!m) return null;
  const qty = Number(m[1]);
  const unitRaw = m[2].toLowerCase();
  const unit = unitRaw === 'm2' ? 'm²' : unitRaw;
  if (unit === 'ea' && !Number.isInteger(qty)) return null;
  return { qty, unit };
}

// Mirrors ai-drawings-store.js normalizeLabel (the legend dedupe key) so
// device-count labels — which come from the same vocabulary — match here.
function normalizeLabel(label) {
  return String(label || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Assemble line items from the accepted seams.
 *   acceptedCounts — #205 liveAcceptedCounts rows
 *   scheduleTables — #202/#207 live tables
 *   scheduleRows   — rows for those tables (accepted|edited only are used)
 *   cableRuns      — #211 acceptedCableRuns rows
 *   legendEntries  — #882 accepted/edited legend entries; ones whose own text
 *                    tabulates a quantity become legend-qty lines
 *   warningsByPage — #212 duplicateCountWarnings Map pageKey → [...]
 *
 * Returns { lines, warnings } — lines ordered legend quantities → device
 * counts → schedule rows → cable estimates, each carrying source type +
 * provenance + flags.
 */
function assembleLines(input) {
  const {
    acceptedCounts = [],
    scheduleTables = [],
    scheduleRows = [],
    cableRuns = [],
    legendEntries = [],
    warningsByPage = new Map(),
  } = input;
  const lines = [];
  const warnings = [];
  const pageKey = (planId, pageIndex) => planId + ':' + pageIndex;

  // ── legend quantities (#882) — the legend schedule's own tabulated counts ──
  // The drawing already states these ("DGPO C2000 — 49 EA"); a human accepted
  // the entry carrying that text, so the quantity assembles as the line and
  // visual detection is demoted to locator/spot-check for the same label.
  // An entry with no tabulated quantity changes nothing (detection path).
  const legendByNorm = new Map();
  const legendRows = [...legendEntries].sort((a, b) =>
    String(a.human_label || a.label).localeCompare(String(b.human_label || b.label)),
  );
  for (const e of legendRows) {
    const parsed = parseLegendQty(e.description) || parseLegendQty(e.human_label || e.label);
    if (!parsed) continue;
    const label = e.human_label || e.label;
    const line = {
      sourceType: 'legend-qty',
      description: label,
      qty: parsed.qty,
      unit: parsed.unit,
      estimate: false,
      flagged: false,
      flagReason: null,
      provenance: {
        planId: e.source_plan_id,
        pageIndex: e.source_page_index,
        pageSha256: e.source_page_sha256,
        legendEntryId: e.id,
        legendText: e.description || label,
        acceptedBy: e.reviewed_by_label || null,
        // Spot-check tally — filled in by matching device counts below.
        located: 0,
        locatedCounts: [],
      },
    };
    lines.push(line);
    // Map BOTH spellings: counts were accepted against the vocabulary label,
    // which may predate a later human_label correction.
    legendByNorm.set(normalizeLabel(label), line);
    legendByNorm.set(normalizeLabel(e.label), line);
  }

  // ── device counts (#205) — the count path for labels the legend doesn't tabulate ──
  const counts = [...acceptedCounts].sort(
    (a, b) =>
      String(a.label).localeCompare(String(b.label)) ||
      String(a.plan_id).localeCompare(String(b.plan_id)) ||
      a.page_index - b.page_index,
  );
  for (const c of counts) {
    const legendLine = legendByNorm.get(normalizeLabel(c.label));
    if (legendLine) {
      // The legend already counts this label — the verified markers become a
      // spot-check on the legend line, never a competing count. More located
      // than the legend tabulates is a real mismatch: surface it, don't merge.
      const p = legendLine.provenance;
      p.located += c.count;
      p.locatedCounts.push({
        planId: c.plan_id,
        pageIndex: c.page_index,
        count: c.count,
        acceptedCountId: c.id,
      });
      if (p.located > legendLine.qty) {
        legendLine.flagged = true;
        legendLine.flagReason =
          `${p.located} located on the sheets vs ${legendLine.qty} from the legend — check the legend quantity`;
        warnings.push({
          kind: 'legend-mismatch',
          planId: c.plan_id,
          pageIndex: c.page_index,
          detail: `${c.label}: ${p.located} located on the sheets exceeds the legend's ${legendLine.qty} ${legendLine.unit}`,
        });
      }
      continue;
    }
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

module.exports = { assembleLines, effectiveCell, parseQty, parseLegendQty, normalizeLabel };
