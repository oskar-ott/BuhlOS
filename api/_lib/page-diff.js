// Epic 5 (#203) — revision diff engine. Classic computer vision, NO model
// call, no spend: grayscale downsample → translation alignment (render drift)
// → per-block change mask → morphological cleanup → connected regions.
//
// Honesty contract (issue #203):
//   * the diff shows WHERE pixels changed; the human judges what it means
//   * a result never claims "no changes" without its basis — alignment
//     quality, threshold and the title-block mask ride on every result
//   * poor alignment returns ok:false ("could not compare"), never an
//     empty diff
//
// Pure module: buffers in, JSON out. pngjs (pure JS) keeps it
// serverless-safe — there is no native image library in this stack.

const { PNG } = require('pngjs');

const ALGO_VERSION = 'pd-v1';

// Tunables — reported on every result so reviewers see the basis.
const TARGET_MAX_DIM = 1400; // downsample ceiling (speed + noise smoothing)
const SEARCH_RADIUS = 12; // ± px translation search, downsampled space
const DIFF_THRESHOLD = 48; // |gray delta| 0..255 for a changed pixel
const CELL = 8; // block size (downsampled px)
const BLOCK_CHANGED_FRACTION = 0.12; // changed pixels per block to flag it
const MIN_REGION_CELLS = 4; // discard specks
const ALIGN_QUALITY_MIN = 0.55; // below this: "could not compare"
// The title block / revision table changes on EVERY revision — masked so the
// diff surfaces drawing changes. The mask is part of the reported basis.
const TITLE_BLOCK_MASK = { x: 0.6, y: 0.7, w: 0.4, h: 0.3 };

function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

// Grayscale + integer-factor box downsample. Alpha-0 pixels read as white
// (blank paper), matching how the renders look on screen.
function toGray(png, maxDim) {
  const factor = Math.max(1, Math.ceil(Math.max(png.width, png.height) / maxDim));
  const w = Math.floor(png.width / factor);
  const h = Math.floor(png.height / factor);
  const out = new Uint8Array(w * h);
  const src = png.data;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const i = ((y * factor + dy) * png.width + (x * factor + dx)) * 4;
          const a = src[i + 3];
          if (a === 0) {
            sum += 255;
          } else {
            sum += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
          }
        }
      }
      out[y * w + x] = Math.round(sum / (factor * factor));
    }
  }
  return { data: out, w, h, factor };
}

// Mean |Δ| over the overlap of a and b shifted by (dx, dy), sampled sparsely.
function meanAbsDiff(a, b, dx, dy, stride) {
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(a.w, b.w + dx);
  const y1 = Math.min(a.h, b.h + dy);
  if (x1 - x0 < 32 || y1 - y0 < 32) return 255;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      sum += Math.abs(a.data[y * a.w + x] - b.data[(y - dy) * b.w + (x - dx)]);
      n += 1;
    }
  }
  return n ? sum / n : 255;
}

// Coarse-to-fine translation search — render drift between revisions is a
// few pixels of offset, not rotation/scale (one render path, one DPI).
// The refine step scores sparsely, then EXACT-rescores the near-ties: sparse
// row/column sampling aliases 1px offsets (a stride-2 grid can miss every
// mismatched row of a thin line), which used to let (dx, dy±1) tie the true
// optimum and leave every horizontal line flagged as changed.
function bestTranslation(a, b) {
  let coarse = { dx: 0, dy: 0, mad: meanAbsDiff(a, b, 0, 0, 4) };
  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy += 4) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 4) {
      const mad = meanAbsDiff(a, b, dx, dy, 4);
      if (mad < coarse.mad) coarse = { dx, dy, mad };
    }
  }
  const candidates = [];
  for (let dy = coarse.dy - 3; dy <= coarse.dy + 3; dy += 1) {
    for (let dx = coarse.dx - 3; dx <= coarse.dx + 3; dx += 1) {
      candidates.push({ dx, dy, sparse: meanAbsDiff(a, b, dx, dy, 2) });
    }
  }
  candidates.sort((p, q) => p.sparse - q.sparse);
  const cutoff = candidates[0].sparse + 0.5;
  let best = null;
  for (const c of candidates.slice(0, 9)) {
    if (c.sparse > cutoff) break;
    const mad = meanAbsDiff(a, b, c.dx, c.dy, 1);
    const closer =
      best && mad === best.mad &&
      Math.abs(c.dx) + Math.abs(c.dy) < Math.abs(best.dx) + Math.abs(best.dy);
    if (!best || mad < best.mad || closer) best = { dx: c.dx, dy: c.dy, mad };
  }
  return best;
}

// 0..1: 1 = pixel-identical after alignment; 0 = wholly different. 64 mean
// levels of |Δ| (a very different image) pins to 0.
function alignmentQuality(mad) {
  return Math.max(0, Math.min(1, 1 - mad / 64));
}

function insideMask(nx, ny) {
  return (
    nx >= TITLE_BLOCK_MASK.x &&
    nx <= TITLE_BLOCK_MASK.x + TITLE_BLOCK_MASK.w &&
    ny >= TITLE_BLOCK_MASK.y &&
    ny <= TITLE_BLOCK_MASK.y + TITLE_BLOCK_MASK.h
  );
}

// Per-block change grid over the aligned overlap.
function changeGrid(a, b, dx, dy) {
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(a.w, b.w + dx);
  const y1 = Math.min(a.h, b.h + dy);
  const gw = Math.max(0, Math.floor((x1 - x0) / CELL));
  const gh = Math.max(0, Math.floor((y1 - y0) / CELL));
  const grid = new Uint8Array(gw * gh);
  const strong = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      // mask by the block centre in HEAD page coordinates
      const cx = (x0 + gx * CELL + CELL / 2) / a.w;
      const cy = (y0 + gy * CELL + CELL / 2) / a.h;
      if (insideMask(cx, cy)) continue;
      let changed = 0;
      for (let py = 0; py < CELL; py += 1) {
        for (let px = 0; px < CELL; px += 1) {
          const x = x0 + gx * CELL + px;
          const y = y0 + gy * CELL + py;
          const d = Math.abs(a.data[y * a.w + x] - b.data[(y - dy) * b.w + (x - dx)]);
          if (d > DIFF_THRESHOLD) changed += 1;
        }
      }
      const frac = changed / (CELL * CELL);
      if (frac > BLOCK_CHANGED_FRACTION) grid[gy * gw + gx] = 1;
      if (frac > 0.3) strong[gy * gw + gx] = 1;
    }
  }
  // Morphological cleanup: a changed block survives if it is strong or has
  // ≥2 changed neighbours — isolated speckle (aliasing) drops out.
  const cleaned = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      if (!grid[gy * gw + gx]) continue;
      if (strong[gy * gw + gx]) {
        cleaned[gy * gw + gx] = 1;
        continue;
      }
      let neighbours = 0;
      for (let ny = -1; ny <= 1; ny += 1) {
        for (let nx = -1; nx <= 1; nx += 1) {
          if (nx === 0 && ny === 0) continue;
          const yy = gy + ny;
          const xx = gx + nx;
          if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
          if (grid[yy * gw + xx]) neighbours += 1;
        }
      }
      if (neighbours >= 2) cleaned[gy * gw + gx] = 1;
    }
  }
  return { grid: cleaned, gw, gh, x0, y0 };
}

// 8-connected components over the block grid → normalised page bboxes.
function regionsFromGrid({ grid, gw, gh, x0, y0 }, gray) {
  const seen = new Uint8Array(gw * gh);
  const regions = [];
  for (let start = 0; start < gw * gh; start += 1) {
    if (!grid[start] || seen[start]) continue;
    let minX = gw;
    let minY = gh;
    let maxX = -1;
    let maxY = -1;
    let cells = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop();
      const gx = idx % gw;
      const gy = Math.floor(idx / gw);
      cells += 1;
      if (gx < minX) minX = gx;
      if (gy < minY) minY = gy;
      if (gx > maxX) maxX = gx;
      if (gy > maxY) maxY = gy;
      for (let ny = -1; ny <= 1; ny += 1) {
        for (let nx = -1; nx <= 1; nx += 1) {
          const yy = gy + ny;
          const xx = gx + nx;
          if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
          const nIdx = yy * gw + xx;
          if (grid[nIdx] && !seen[nIdx]) {
            seen[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
    }
    if (cells < MIN_REGION_CELLS) continue;
    regions.push({
      bbox: {
        x: (x0 + minX * CELL) / gray.w,
        y: (y0 + minY * CELL) / gray.h,
        w: ((maxX - minX + 1) * CELL) / gray.w,
        h: ((maxY - minY + 1) * CELL) / gray.h,
      },
      areaCells: cells,
    });
  }
  regions.sort((a, b) => b.areaCells - a.areaCells);
  return regions;
}

/**
 * Diff two rendered page PNGs (head = newer revision; bboxes are in head
 * page coordinates, normalised 0..1). Returns:
 *   { ok:true, identical:false, algoVersion, alignment:{dx,dy,quality},
 *     basis:{threshold, blockChangedFraction, mask, targetMaxDim},
 *     regions:[{bbox, areaCells}] }
 * or { ok:false, reason } when the pair can't be compared honestly.
 */
function diffPages(headBuffer, baseBuffer) {
  let headPng;
  let basePng;
  try {
    headPng = decodePng(headBuffer);
    basePng = decodePng(baseBuffer);
  } catch (e) {
    return { ok: false, algoVersion: ALGO_VERSION, reason: 'could not decode a page image: ' + e.message };
  }
  const headAspect = headPng.width / headPng.height;
  const baseAspect = basePng.width / basePng.height;
  if (Math.abs(headAspect - baseAspect) / baseAspect > 0.03) {
    return {
      ok: false,
      algoVersion: ALGO_VERSION,
      reason: 'page aspect ratios differ — these do not look like revisions of the same sheet',
    };
  }
  const head = toGray(headPng, TARGET_MAX_DIM);
  const base = toGray(basePng, TARGET_MAX_DIM);
  const { dx, dy, mad } = bestTranslation(head, base);
  const quality = alignmentQuality(mad);
  const basis = {
    threshold: DIFF_THRESHOLD,
    blockChangedFraction: BLOCK_CHANGED_FRACTION,
    mask: TITLE_BLOCK_MASK,
    targetMaxDim: TARGET_MAX_DIM,
    alignQualityMin: ALIGN_QUALITY_MIN,
  };
  // Alignment is judged on the ALIGNED residual: pages that overlay well
  // score near 1 even when a real change adds local differences (the mean
  // absorbs it); wholly different pages stay low and fail honestly.
  if (quality < ALIGN_QUALITY_MIN) {
    return {
      ok: false,
      algoVersion: ALGO_VERSION,
      reason: 'could not compare — alignment quality ' + quality.toFixed(2) + ' below ' + ALIGN_QUALITY_MIN,
      alignment: { dx, dy, quality },
      basis,
    };
  }
  const grid = changeGrid(head, base, dx, dy);
  const regions = regionsFromGrid(grid, head);
  return {
    ok: true,
    identical: false,
    algoVersion: ALGO_VERSION,
    alignment: { dx, dy, quality },
    basis,
    regions,
  };
}

module.exports = {
  ALGO_VERSION,
  TITLE_BLOCK_MASK,
  diffPages,
  // exported for focused unit tests
  __test: { toGray, bestTranslation, alignmentQuality, decodePng },
};
