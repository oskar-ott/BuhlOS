'use strict';

// Epic 5 (#211) — heuristic cable-run estimation. PURE geometry + factors:
// no model calls, no spend. Every number this module produces is an
// ESTIMATE and must surface labelled as one, with its full assumption set
// attached — it is valuable only while its assumptions are explicit, and
// harmful the moment it pretends to be a measurement.
//
// Metric anchor: a human CALIBRATION — two points on the sheet plus the
// real-world distance between them (a grid bay, a dimensioned wall). One
// straight-line reference plus the raster's aspect ratio yields exact
// mm-per-normalised-unit for both axes; the parsed title-block scale can't
// do this alone (page rasters carry no physical size) and rides along as a
// cross-check only. No calibration → NO estimate, flagged — never a
// unit-guessed number.

// Deliberately visible defaults — assumptions, not truths. Overridable per
// job on every run; the applied set is stored on the result.
const DEFAULT_FACTORS = {
  // Manhattan distance already bends once; real routes still wander —
  // multiply the horizontal run.
  routingFactor: 1.15,
  // Vertical allowance per run: drop/rise at the board end plus the device
  // end (switch heights, ceiling drops), in mm.
  riseDropMm: 4000,
  // Termination tails, set-downs and waste.
  slackFactor: 1.1,
};

// Two calibration points (normalised page coords), their real separation in
// mm, and the raster's aspect (height/width) → mm per full normalised page
// unit on each axis. Physical x/y scales differ because the page is not
// square; the aspect ties them together so ONE reference line fixes both.
function calibrationScales(a, b, realMm, rasterAspect) {
  const dnx = Math.abs(b.x - a.x);
  const dny = Math.abs(b.y - a.y);
  const span = Math.sqrt(dnx * dnx + dny * rasterAspect * (dny * rasterAspect));
  if (!Number.isFinite(span) || span < 0.02) {
    return { error: 'calibration points are too close together — pick a longer known dimension' };
  }
  if (!Number.isFinite(realMm) || realMm <= 0) {
    return { error: 'real distance must be a positive length in mm' };
  }
  if (!Number.isFinite(rasterAspect) || rasterAspect <= 0) {
    return { error: 'raster aspect missing' };
  }
  const mmPerNormX = realMm / span;
  const mmPerNormY = mmPerNormX * rasterAspect;
  return { mmPerNormX, mmPerNormY };
}

function centreOf(bbox) {
  return { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 };
}

// Manhattan distance in real mm between two normalised points.
function manhattanMm(p, q, cal) {
  return Math.abs(p.x - q.x) * cal.mmPerNormX + Math.abs(p.y - q.y) * cal.mmPerNormY;
}

function normaliseFactors(factors) {
  const f = { ...DEFAULT_FACTORS, ...(factors || {}) };
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    routingFactor: num(f.routingFactor, DEFAULT_FACTORS.routingFactor, 1, 5),
    riseDropMm: num(f.riseDropMm, DEFAULT_FACTORS.riseDropMm, 0, 100000),
    slackFactor: num(f.slackFactor, DEFAULT_FACTORS.slackFactor, 1, 3),
  };
}

/**
 * Estimate cable runs for one page raster.
 *   markers — #205 effective markers (only live 'device' ones are used)
 *   pins    — board pins [{ board_identifier, point: {x, y} }]
 *   cal     — { mmPerNormX, mmPerNormY } from calibrationScales
 *   factors — assumption set (normalised against defaults)
 *
 * Each device runs to its NEAREST pinned board (Manhattan — in-building
 * runs follow walls, not diagonals):
 *   estimateMm = manhattan × routingFactor × slackFactor + riseDropMm
 * Returns per-device rows plus per-board and per-(board × label) rollups.
 */
function estimateRun(markers, pins, cal, factors) {
  const f = normaliseFactors(factors);
  if (!pins.length) return { error: 'no board pinned on this sheet' };
  const perDevice = [];
  for (const m of markers) {
    if (m.status !== 'live') continue;
    const p = centreOf(m.bbox);
    let best = null;
    for (const pin of pins) {
      const mm = manhattanMm(p, pin.point, cal);
      if (!best || mm < best.mm) best = { pin, mm };
    }
    const run = Math.round(best.mm * f.routingFactor * f.slackFactor + f.riseDropMm);
    perDevice.push({
      markerKey: m.key,
      label: m.label,
      legendEntryId: m.legendEntryId,
      boardIdentifier: best.pin.board_identifier,
      manhattanMm: Math.round(best.mm),
      estimateMm: run,
    });
  }
  const perBoard = new Map();
  for (const d of perDevice) {
    let b = perBoard.get(d.boardIdentifier);
    if (!b) {
      b = { boardIdentifier: d.boardIdentifier, deviceCount: 0, totalMm: 0, byLabel: new Map() };
      perBoard.set(d.boardIdentifier, b);
    }
    b.deviceCount += 1;
    b.totalMm += d.estimateMm;
    const lk = d.label || '(unlabelled)';
    let l = b.byLabel.get(lk);
    if (!l) {
      l = { label: d.label, legendEntryId: d.legendEntryId, deviceCount: 0, totalMm: 0 };
      b.byLabel.set(lk, l);
    }
    l.deviceCount += 1;
    l.totalMm += d.estimateMm;
  }
  const boards = [...perBoard.values()]
    .map((b) => ({
      boardIdentifier: b.boardIdentifier,
      deviceCount: b.deviceCount,
      totalMm: b.totalMm,
      byLabel: [...b.byLabel.values()].sort((a, c) => c.totalMm - a.totalMm),
    }))
    .sort((a, c) => String(a.boardIdentifier).localeCompare(String(c.boardIdentifier)));
  return {
    factors: f,
    perDevice,
    boards,
    totalMm: perDevice.reduce((n, d) => n + d.estimateMm, 0),
    deviceCount: perDevice.length,
  };
}

module.exports = {
  DEFAULT_FACTORS,
  calibrationScales,
  manhattanMm,
  normaliseFactors,
  estimateRun,
};
