// Epic 5 — AI Drawing Interpretation. Slice #197: page understanding.
//
// Classifies each rendered plan page (sheet type) and parses its title block
// (sheet number, title, revision, scale) with per-field confidence, storing
// results in Supabase with full provenance behind a human review-and-correct
// loop. THE foundation for every later Epic 5 capability (#199 registry,
// #201 legends, #203 revision diff, #204/#205 device recognition, ...).
//
// Routes (all DARK behind the `ai_drawings` flag — 404 when off):
//   GET  /api/ai-drawings?jobId=X&action=sheets
//        → { sheets, reviewThreshold, spend } — effective per-page rows
//          (human override > AI value), needs-review derived at read time.
//   POST /api/ai-drawings?jobId=X&action=understand-page
//        body: { planId, pageIndex, titleBlockCrop?: { dataUrl, region } }
//        → runs ONE vision call (client orchestrates the loop, Phase-9
//          pattern — serverless can't run background jobs). Cached by
//          (page sha256, prompt version, model): an unchanged page never
//          bills twice. 402 once the per-job AI cap is reached.
//   POST /api/ai-drawings?jobId=X&action=override
//        body: { planId, pageIndex, field, value|null }
//        → human correction; stored separately from AI values, wins on read,
//          survives re-extraction. value null = "field is absent".
//   POST /api/ai-drawings?jobId=X&action=clear-override
//        body: { planId, pageIndex, field }
//
// Honesty rules (P7): absent fields are null, never guessed — the prompt
// demands nulls-over-guesses and the model's stated confidence is stored
// verbatim. Fields under the review threshold surface as needs-review; the
// system never silently accepts a low-confidence read. Spend is recorded
// into the SHARED per-job ledger (api/_lib/ai-spend.js, #510 CAS) even when
// the model returns unusable output — the money was spent.
//
// Storage: Supabase Postgres via the guarded direct connection
// (api/_lib/supabase-db.js). Preview deploys and local dev have no
// SUPABASE_DB_URL — the handler answers an honest 503 there instead of
// pretending. No new Blob keys (spend rides the existing ai-takeoff.json).

const { z } = require('zod');
const { put } = require('@vercel/blob');
const { setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isAdminRole, isClientRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { aiComplete, AiError } = require('./_lib/ai');
const { readBlob } = require('./_lib/blob');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { getDb } = require('./_lib/supabase-db');
const aiSpend = require('./_lib/ai-spend');
const store = require('./_lib/ai-drawings-store');
const pageDiff = require('./_lib/page-diff');
const countReview = require('./_lib/count-review');
const roomAssign = require('./_lib/room-assign');
const cable = require('./_lib/cable-estimate');
const entityLinks = require('./_lib/entity-links');

// ─── Config (env-configurable, bare current alias default — #378) ──────────
const AI_DRAWINGS_MODEL = process.env.AI_DRAWINGS_MODEL || 'claude-opus-4-8';
// Opus 4.8 published rates as of writing ($5/$25 per MTok). Override via env
// if the model knob is pointed at a different tier.
const COST_PER_INPUT_TOKEN = Number(process.env.AI_DRAWINGS_INPUT_USD_PER_MTOK || '5') / 1_000_000;
const COST_PER_OUTPUT_TOKEN = Number(process.env.AI_DRAWINGS_OUTPUT_USD_PER_MTOK || '25') / 1_000_000;
// A field below this confidence (with no human override) flags needs-review.
const REVIEW_THRESHOLD = Number(process.env.AI_DRAWINGS_REVIEW_THRESHOLD || '0.8');
// Bump when the prompt changes — extraction cache is keyed on it, so a new
// prompt version re-runs pages while old rows stay for comparison.
const PROMPT_VERSION = 'pu-v1';
const KIND = 'page-understanding';
const MAX_CROP_DATAURL_CHARS = 6 * 1024 * 1024; // ~4.5MB decoded

// #201 legend extraction — separate prompt lineage, same run-log + cache.
const LEGEND_PROMPT_VERSION = 'lv-v1';
const KIND_LEGEND = 'legend-entries';
const MAX_SYMBOL_CROP_CHARS = 1_500_000; // symbol cells are small

// #202/#207 schedule extraction — one prompt lineage per table kind.
// #202 ships lighting; #207 widens the request enum to switchboard.
const SCHEDULE_PROMPT_VERSIONS = { lighting: 'sl-v1', switchboard: 'sb-v1' };
const SCHEDULE_RUN_KINDS = { lighting: 'schedule-lighting', switchboard: 'schedule-switchboard' };

// #204 device detection — per-tile vision against the REVIEWED vocabulary.
const DETECTION_PROMPT_VERSION = 'dd-v1';
const DETECTION_SEAM_IOU = 0.5; // same entry + overlap above this = tile-seam duplicate
const MAX_TILE_DATAURL_CHARS = 4_000_000; // Vercel body ceiling, minus headroom
const MAX_FEWSHOT_CROPS = 12; // legend reference images per call

// #206 rooms — whole-page label + approximate-extent pass, same run-log cache.
const ROOMS_PROMPT_VERSION = 'rv-v1';
const KIND_ROOMS = 'rooms';

// #212 cross-sheet references — callout detection pass, same run-log cache.
// Entity-link proposals are PURE (exact identifier matches) — no model call.
const REFS_PROMPT_VERSION = 'sr-v1';
const KIND_REFS = 'sheet-refs';

// ─── Request validation (Zod at the boundary) ──────────────────────────────
const CropRegion = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});
const UnderstandBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  titleBlockCrop: z
    .object({
      dataUrl: z.string().startsWith('data:image/').max(MAX_CROP_DATAURL_CHARS),
      region: CropRegion,
    })
    .optional(),
});
const OverrideBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  field: z.enum(store.OVERRIDE_FIELDS),
  value: z.string().max(200).nullable(),
});
const ClearOverrideBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  field: z.enum(store.OVERRIDE_FIELDS),
});
const ExtractLegendBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
});
const ReviewLegendBody = z.object({
  entryId: z.string().min(1),
  status: z.enum(['accepted', 'edited', 'rejected']),
  humanLabel: z.string().min(1).max(120).optional(),
  note: z.string().max(500).optional(),
});
const AddLegendBody = z.object({
  label: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  category: z.enum(store.LEGEND_CATEGORIES).nullable().optional(),
});
const AttachLegendCropBody = z.object({
  entryId: z.string().min(1),
  dataUrl: z.string().startsWith('data:image/').max(MAX_SYMBOL_CROP_CHARS),
});
const ExtractScheduleBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  tableKind: z.enum(['lighting', 'switchboard']), // #202 lighting, #207 switchboard
});
const ReviewScheduleRowBody = z.object({
  rowId: z.string().min(1),
  status: z.enum(['accepted', 'edited', 'rejected']),
  // per-cell corrections: { col: 'fixed text' | null } — null = cell is empty
  cells: z.record(z.string().max(80), z.string().max(300).nullable()).optional(),
  note: z.string().max(500).optional(),
});
const PageRef = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
});
const DiffPagesBody = z.object({
  base: PageRef, // older revision
  head: PageRef, // newer revision — regions land in head coordinates
});
const ReviewDiffRegionBody = z.object({
  regionId: z.string().min(1),
  status: z.enum(['reviewed', 'dismissed']),
  note: z.string().max(500).optional(),
});
const DetectDevicesBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  tile: z.object({
    region: CropRegion, // the tile's window on the page, normalised
    dataUrl: z.string().startsWith('data:image/').max(MAX_TILE_DATAURL_CHARS),
  }),
});
// #205 — the marker being acted on carries its own (plan, page, raster), so
// the body names only the target and the action.
const ReviewMarkerBody = z
  .object({
    action: z.enum(['delete', 'restore', 'reclassify']),
    detectionId: z.string().min(1).optional(), // AI marker
    reviewId: z.string().min(1).optional(), // human-added marker (its add action)
    toLegendEntryId: z.string().min(1).optional(),
    note: z.string().max(500).optional(),
  })
  .refine((b) => (b.detectionId ? 1 : 0) + (b.reviewId ? 1 : 0) === 1, {
    message: 'exactly one of detectionId or reviewId is required',
  })
  .refine((b) => b.action !== 'reclassify' || Boolean(b.toLegendEntryId), {
    message: 'reclassify requires toLegendEntryId',
  });
const AddMarkerBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  bbox: CropRegion,
  legendEntryId: z.string().min(1),
  note: z.string().max(500).optional(),
});
const AcceptCountBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  legendEntryId: z.string().min(1),
});
// #206 rooms
const ExtractRoomsBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
});
const ReviewRoomBody = z
  .object({
    roomId: z.string().min(1),
    status: z.enum(['accepted', 'edited', 'rejected']),
    name: z.string().min(1).max(80).optional(), // rename
    bbox: CropRegion.optional(), // redraw
    note: z.string().max(500).optional(),
  })
  .refine((b) => b.status !== 'edited' || Boolean(b.name) || Boolean(b.bbox), {
    message: 'edited requires a rename (name) or a redraw (bbox) — that is what distinguishes it from accept',
  });
const AddRoomBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  name: z.string().min(1).max(80),
  bbox: CropRegion,
});
const AssignRoomBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  markerKey: z.string().min(3), // 'd:<id>' | 'r:<id>'
  roomId: z.string().min(1).nullable(), // null = pin to the unzoned bucket
});
const ClearRoomAssignmentBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  markerKey: z.string().min(3),
});
// #211 cable estimates — pure geometry, no AI.
const NormPoint = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const PinBoardBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  boardIdentifier: z.string().min(1).max(40),
  point: NormPoint,
});
const ClearBoardPinBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  boardIdentifier: z.string().min(1).max(40),
});
const CalibrateBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  pointA: NormPoint,
  pointB: NormPoint,
  realMm: z.number().gt(0).max(1_000_000),
  rasterAspect: z.number().gt(0).max(20),
});
const EstimateCableBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
  factors: z
    .object({
      routingFactor: z.number().min(1).max(5).optional(),
      riseDropMm: z.number().min(0).max(100000).optional(),
      slackFactor: z.number().min(1).max(3).optional(),
    })
    .optional(),
});
const AcceptCableBody = z.object({ runId: z.string().min(1) });
// #212 cross-sheet links
const ExtractRefsBody = z.object({
  planId: z.string().min(1),
  pageIndex: z.number().int().min(0),
});
const ReviewLinkBody = z.object({
  linkId: z.string().min(1),
  status: z.enum(['confirmed', 'rejected']),
});
const AddLinkBody = z.object({
  kind: z.literal('same-board'),
  identifier: z.string().min(1).max(60),
  a: z.object({ planId: z.string().min(1), pageIndex: z.number().int().min(0) }),
  b: z.object({ planId: z.string().min(1), pageIndex: z.number().int().min(0) }),
});

// ─── Model output contract (validated before anything persists) ────────────
const FieldOut = z.object({
  value: z.string().max(200).nullable(),
  confidence: z.number().min(0).max(1),
});
const ModelOutput = z.object({
  sheetType: z.enum(store.SHEET_TYPES),
  sheetTypeConfidence: z.number().min(0).max(1),
  titleBlock: z.object({
    sheetNumber: FieldOut,
    sheetTitle: FieldOut,
    revision: FieldOut,
    scale: FieldOut,
  }),
  notes: z.string().max(2000).nullable().optional(),
});

// #201 legend model contract. bbox is the tight normalised box around the
// drawn SYMBOL cell (for the client-side reference crop) — nullable: an
// entry the model can't localise is still a valid label-only row.
const LegendEntryOut = z.object({
  label: z.string().min(1).max(120),
  description: z.string().max(300).nullable().optional(),
  category: z.enum(store.LEGEND_CATEGORIES).nullable().optional(),
  symbol: z.string().max(200).nullable().optional(),
  confidence: z.number().min(0).max(1),
  bbox: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().gt(0).max(1),
      h: z.number().gt(0).max(1),
    })
    .nullable()
    .optional(),
});
const LegendModelOutput = z.object({
  isLegendPresent: z.boolean(),
  entries: z.array(LegendEntryOut).max(150),
  notes: z.string().max(2000).nullable().optional(),
});

// #202/#207 schedule model contract — table-type-agnostic. Cells are the
// VERBATIM per-cell read with confidence; null = unreadable/absent, never
// invented, and abbreviations are never expanded.
const NormBox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});
const CellOut = z.object({
  value: z.string().max(300).nullable(),
  confidence: z.number().min(0).max(1),
});
const ScheduleTableOut = z.object({
  boardIdentifier: z.string().max(60).nullable().optional(),
  region: NormBox.nullable().optional(),
  headers: z.array(z.string().max(120)).max(30),
  columnMap: z.record(z.string().max(120), z.string().max(80)),
  rows: z
    .array(
      z.object({
        rowRegion: NormBox.nullable().optional(),
        cells: z.record(z.string().max(80), CellOut),
      }),
    )
    .max(200),
});
const ScheduleModelOutput = z.object({
  isSchedulePresent: z.boolean(),
  tables: z.array(ScheduleTableOut).max(5),
  notes: z.string().max(2000).nullable().optional(),
});

// #204 detection model contract. entryIndex refers to the numbered
// vocabulary list in the prompt (mapped back to legend_entries server-side —
// the model never echoes ids). Dense areas land in uncertainRegions instead
// of confidently wrong detections (issue AC).
const DetectionOut = z.object({
  entryIndex: z.number().int().min(0),
  bbox: NormBox,
  confidence: z.number().min(0).max(1),
});
const UncertainRegionOut = z.object({
  bbox: NormBox,
  note: z.string().max(300).nullable().optional(),
});
const DetectionModelOutput = z.object({
  detections: z.array(DetectionOut).max(300),
  uncertainRegions: z.array(UncertainRegionOut).max(40),
  notes: z.string().max(2000).nullable().optional(),
});

// #206 rooms model contract — names verbatim, extents approximate, no
// invented rooms (unlabelled space stays undetected; humans add rooms).
const RoomOut = z.object({
  name: z.string().min(1).max(80),
  bbox: NormBox,
  confidence: z.number().min(0).max(1),
});
const RoomsModelOutput = z.object({
  rooms: z.array(RoomOut).max(120),
  notes: z.string().max(2000).nullable().optional(),
});

// #212 reference-callout model contract — callouts verbatim, target sheet
// numbers exactly as printed, nothing invented.
const RefOut = z.object({
  text: z.string().min(1).max(200),
  targetSheetNumber: z.string().min(1).max(40),
  bbox: NormBox.nullable().optional(),
  confidence: z.number().min(0).max(1),
});
const RefsModelOutput = z.object({
  refs: z.array(RefOut).max(80),
  notes: z.string().max(2000).nullable().optional(),
});

// ─── Prompt (version: PROMPT_VERSION) ───────────────────────────────────────
function pageUnderstandingPrompt(hasCrop) {
  return `You are analysing ONE page of an Australian construction drawing set (usually electrical).

TASK 1 — CLASSIFY the sheet into exactly one type:
- "floorPlan":  a plan view of a building level showing rooms/areas (incl. lighting/power layout plans)
- "schematic":  single-line diagrams, switchboard schematics, riser/distribution diagrams
- "schedule":   tabular data — switchboard schedules, lighting schedules, equipment/cable schedules
- "legend":     a symbol key/legend sheet (or a page whose dominant content is the legend)
- "titleCover": title sheet, cover sheet, drawing index/register sheet
- "detail":     enlarged construction/installation details, sections, elevations of details
- "other":      anything that fits none of the above

TASK 2 — READ THE TITLE BLOCK (conventionally the bottom-right corner or the right-hand edge strip):
- sheetNumber: the drawing number, e.g. "E-101", "E2.04", "SK-05"
- sheetTitle:  the sheet's own title, e.g. "LEVEL 2 LIGHTING PLAN"
- revision:    the CURRENT revision code, e.g. "C", "P3", "2" (from the title block or the highest entry in the revision table)
- scale:       the stated scale, e.g. "1:100", "1:50 @ A1", "NTS"
${hasCrop ? '\nThe SECOND image is a high-resolution crop of the title-block region of the SAME page — prefer it when reading small title-block text.\n' : ''}
RULES — these are non-negotiable:
- NEVER guess. If a field is not clearly legible or not present, return null for its value.
- Confidence is YOUR honest 0..1 estimate per field. A null value with high confidence means "I am confident this field is absent/illegible".
- Return ONLY strict JSON, no commentary, in exactly this shape:
{
  "sheetType": "floorPlan" | "schematic" | "schedule" | "legend" | "titleCover" | "detail" | "other",
  "sheetTypeConfidence": 0.0,
  "titleBlock": {
    "sheetNumber": { "value": "E-101" or null, "confidence": 0.0 },
    "sheetTitle":  { "value": "..." or null, "confidence": 0.0 },
    "revision":    { "value": "..." or null, "confidence": 0.0 },
    "scale":       { "value": "..." or null, "confidence": 0.0 }
  },
  "notes": "one short caveat sentence, or null"
}`;
}

// ─── Prompt (version: LEGEND_PROMPT_VERSION) ────────────────────────────────
function legendPrompt() {
  return `You are reading the SYMBOL LEGEND on ONE page of an Australian construction drawing set (usually electrical).

A legend is a key/table mapping each drawn symbol to its meaning (e.g. "double GPO", "downlight", "exhaust fan", "two-way switch", "data outlet"). It may be a dedicated legend sheet, or one or more legend blocks in a corner of another sheet. Read EVERY legend row on this page.

For each legend entry return:
- label:       the legend's own text label, verbatim (e.g. "DOUBLE GPO 10A")
- description: extra descriptive text the legend gives for that row, or null
- category:    one of "Power" | "Lighting" | "Switch" | "Data" | "Comms" | "Safety" | "Mechanical" | "EV" | "Appliance" | "Other"
- symbol:      a terse description of the DRAWN symbol (e.g. "circle with two parallel lines"), or null
- confidence:  YOUR honest 0..1 estimate for this row
- bbox:        the tight box around the drawn SYMBOL GRAPHIC cell (not its text), in page-normalised coordinates {"x","y","w","h"} each 0..1 of the FULL page — or null if you cannot localise it precisely

RULES — non-negotiable:
- NEVER invent entries. Only rows the legend actually shows. Unreadable rows: skip them and say so in notes.
- Use Australian terminology (GPO not "outlet", light point not "fixture", isolator not "disconnect").
- If this page has NO legend at all: {"isLegendPresent": false, "entries": [], "notes": "..."}.
- Return ONLY strict JSON:
{
  "isLegendPresent": true,
  "entries": [
    { "label": "...", "description": "..." or null, "category": "Power", "symbol": "..." or null, "confidence": 0.0, "bbox": {"x":0.1,"y":0.2,"w":0.03,"h":0.02} or null }
  ],
  "notes": "one short caveat sentence, or null"
}`;
}

// ─── Prompt (versions: SCHEDULE_PROMPT_VERSIONS) ────────────────────────────
function schedulePrompt(tableKind) {
  const canonical = store.SCHEDULE_COLUMNS[tableKind].join(' | ');
  const kindBlock =
    tableKind === 'lighting'
      ? `LIGHTING SCHEDULE tables — luminaire schedules listing type codes, descriptions, manufacturer/model, lamp, wattage, quantities.
Canonical columns to map onto: ${canonical}.
boardIdentifier is always null for lighting schedules.`
      : `SWITCHBOARD SCHEDULE tables — board schedules listing circuit references, descriptions, protection devices, cable sizes, phases, loads.
Canonical columns to map onto: ${canonical}.
Set boardIdentifier to the board's name/code (e.g. "MSB", "DB-1") for EACH table; one table per board section.`;

  return `You are reading ${tableKind.toUpperCase()} SCHEDULE tables on ONE page of an Australian construction drawing set.

${kindBlock}

For EVERY such table on the page return:
- boardIdentifier (see above)
- region: the table's bounding box in page-normalised coordinates {"x","y","w","h"} each 0..1, or null
- headers: the header row cells EXACTLY as printed, in order
- columnMap: each raw header mapped to a canonical column name where one fits; leave unmappable headers OUT of columnMap (their cells still extract under the raw header key)
- rows: EVERY data row. Per row:
  - rowRegion: the row's bounding box (page-normalised), or null
  - cells: an object keyed by canonical column names (and raw header keys for unmapped columns), each cell {"value": "...", "confidence": 0..1}

RULES — non-negotiable:
- Cells are VERBATIM: exactly the text printed, abbreviations preserved, never expanded or corrected. "2.5mm²" stays "2.5mm²"; "EM" stays "EM".
- An unreadable, smudged or empty cell is {"value": null, "confidence": <your honest estimate>} — NEVER guessed.
- NEVER invent rows. Skip continuation/total/blank separator rows and say so in notes.
- If the page has NO ${tableKind} schedule: {"isSchedulePresent": false, "tables": [], "notes": "..."}.
- Return ONLY strict JSON:
{
  "isSchedulePresent": true,
  "tables": [
    {
      "boardIdentifier": "DB-1" or null,
      "region": {"x":0.1,"y":0.2,"w":0.5,"h":0.6} or null,
      "headers": ["TYPE", "DESCRIPTION", "..."],
      "columnMap": {"TYPE": "typeCode", "DESCRIPTION": "description"},
      "rows": [
        { "rowRegion": {...} or null, "cells": { "typeCode": {"value":"L1","confidence":0.95}, "description": {"value":null,"confidence":0.4} } }
      ]
    }
  ],
  "notes": "one short caveat sentence, or null"
}`;
}

// Best-effort JSON extraction from a model reply (fence-strip pattern proven
// in api/plans.js Phase 9). Returns parsed object or null.
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(candidate); } catch {}
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch {}
  }
  return null;
}

// Fetch a stored page PNG as a Buffer (plans.js pattern).
async function fetchPngBuffer(url) {
  const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('fetch png failed: ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function fetchPngAsBase64(url) {
  const buf = await fetchPngBuffer(url);
  return { base64: buf.toString('base64'), mediaType: 'image/png' };
}

// Normalise "" → null and trim string values out of the validated output.
function cleanValue(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// ─── Effective view: override > AI, needs-review derived (never stored) ────
// One field's shape: { ai: {value, confidence}|null, override: {...}|null,
// effective: value|null }.
function effectiveSheet(row, overrides) {
  const byField = {};
  for (const o of overrides) {
    if (o.plan_id === row.plan_id && o.page_index === row.page_index) byField[o.field] = o;
  }
  const field = (name, aiValue, aiConfidence) => {
    const o = byField[name] || null;
    const ai = aiConfidence === null && aiValue === null && row.extraction_id === null
      ? null
      : { value: aiValue, confidence: aiConfidence };
    return {
      ai,
      override: o
        ? { value: o.value, correctedBy: o.corrected_by, correctedAt: o.corrected_at }
        : null,
      effective: o ? o.value : aiValue,
    };
  };
  const fields = {
    sheetType: field('sheetType', row.sheet_type, row.sheet_type_confidence),
    sheetNumber: field('sheetNumber', row.sheet_number, row.sheet_number_confidence),
    sheetTitle: field('sheetTitle', row.sheet_title, row.sheet_title_confidence),
    revision: field('revision', row.revision, row.revision_confidence),
    scale: field('scale', row.scale, row.scale_confidence),
  };
  // needs-review: any field with NO human override whose AI confidence is
  // missing or under the threshold. An override on a field settles it.
  const needsReview = Object.values(fields).some((f) => {
    if (f.override) return false;
    const c = f.ai ? f.ai.confidence : null;
    return c === null || c === undefined || c < REVIEW_THRESHOLD;
  });
  return {
    planId: row.plan_id,
    pageIndex: row.page_index,
    pageSha256: row.page_sha256,
    model: row.model,
    promptVersion: row.prompt_version,
    updatedAt: row.updated_at,
    fields,
    needsReview,
  };
}

// Map a validated model payload + context into an extraction-row shape.
// `rawJson` is the model's ACTUAL parsed output (pre-zod) — provenance stores
// what the model said, not the schema-stripped projection of it.
function extractionRowFrom(ctx, parsed, rawJson, usage) {
  const tb = parsed.titleBlock;
  return {
    jobId: ctx.jobId,
    planId: ctx.planId,
    pageIndex: ctx.pageIndex,
    pageSha256: ctx.pageSha256,
    kind: KIND,
    model: AI_DRAWINGS_MODEL,
    promptVersion: PROMPT_VERSION,
    raw: rawJson,
    sheetType: parsed.sheetType,
    sheetTypeConfidence: parsed.sheetTypeConfidence,
    sheetNumber: cleanValue(tb.sheetNumber.value),
    sheetNumberConfidence: tb.sheetNumber.confidence,
    sheetTitle: cleanValue(tb.sheetTitle.value),
    sheetTitleConfidence: tb.sheetTitle.confidence,
    revision: cleanValue(tb.revision.value),
    revisionConfidence: tb.revision.confidence,
    scale: cleanValue(tb.scale.value),
    scaleConfidence: tb.scale.confidence,
    region: ctx.cropRegion || null,
    inputTokens: usage ? Number(usage.inputTokens ?? usage.input_tokens ?? 0) : null,
    outputTokens: usage ? Number(usage.outputTokens ?? usage.output_tokens ?? 0) : null,
    createdByLabel: ctx.username || null,
  };
}

// Guarded DB acquisition — an honest 503 where the extraction store can't be
// reached (preview deploys / local dev have no SUPABASE_DB_URL; prod writes
// additionally require the explicit production-write opt-in).
function dbOr503(res, mode) {
  try {
    return getDb({ mode });
  } catch (e) {
    res.status(503).json({
      error: 'extraction store unavailable in this environment',
      code: (e && e.code) || 'DB_UNAVAILABLE',
    });
    return null;
  }
}

async function readPlanPage(jobId, planId, pageIndex) {
  const index = await readBlob('jobs/' + jobId + '/plans-index.json', { plans: [] });
  const plan = (index.plans || []).find((p) => p.id === planId);
  if (!plan) return { error: 'plan not found', status: 404 };
  const page = (plan.pages || []).find((p) => p.pageIndex === pageIndex);
  if (!page) return { error: 'page not registered — run set-pages first', status: 404 };
  if (!page.sha256) return { error: 'page has no sha256 — re-run set-pages', status: 409 };
  return { plan, page };
}

// ─── Action handlers ────────────────────────────────────────────────────────

async function handleSheets(res, sql, tenantId, jobId) {
  const [rows, overrides, takeoff] = await Promise.all([
    store.listPlanSheets(sql, tenantId, jobId),
    store.listOverrides(sql, tenantId, jobId),
    aiSpend.readTakeoff(jobId),
  ]);
  return res.status(200).json({
    sheets: rows.map((r) => effectiveSheet(r, overrides)),
    reviewThreshold: REVIEW_THRESHOLD,
    model: AI_DRAWINGS_MODEL,
    promptVersion: PROMPT_VERSION,
    spend: { totalUsd: takeoff.spend.totalUsd, capUsd: aiSpend.COST_CAP_USD },
  });
}

async function handleUnderstandPage(res, sql, tenantId, jobId, user, body) {
  const parsedBody = UnderstandBody.safeParse(body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: parsedBody.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, titleBlockCrop } = parsedBody.data;

  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const { page } = found;

  const cacheKey = {
    jobId, planId, pageIndex,
    pageSha256: page.sha256,
    kind: KIND,
    promptVersion: PROMPT_VERSION,
    model: AI_DRAWINGS_MODEL,
  };

  // Cache: an unchanged page + same prompt/model never bills twice. Re-upsert
  // the projection (covers the row having been superseded by another sha).
  const cached = await store.findCachedExtraction(sql, tenantId, cacheKey);
  if (cached) {
    await store.upsertPlanSheet(sql, tenantId, cached);
    const overrides = await store.listOverrides(sql, tenantId, jobId);
    const rows = await store.listPlanSheets(sql, tenantId, jobId);
    const row = rows.find((r) => r.plan_id === planId && r.page_index === pageIndex);
    return res.status(200).json({ cached: true, sheet: row ? effectiveSheet(row, overrides) : null });
  }

  // Per-job AI cost cap (#510 shared ledger) — checked before spending.
  const takeoff = await aiSpend.readTakeoff(jobId);
  if (aiSpend.overBudget(takeoff)) {
    return res.status(402).json({
      error: 'cost cap reached for this job ($' + aiSpend.COST_CAP_USD + ')',
      spend: takeoff.spend,
    });
  }

  // Build the vision request: full page (+ optional client-side title-block
  // crop as a second image — small text reads far better from the crop).
  let content;
  try {
    const png = await fetchPngAsBase64(page.pngUrl);
    content = [
      { type: 'image', source: { type: 'base64', media_type: png.mediaType, data: png.base64 } },
    ];
  } catch (e) {
    return res.status(502).json({ error: 'could not fetch page image: ' + e.message });
  }
  let cropRegion = null;
  if (titleBlockCrop) {
    const m = titleBlockCrop.dataUrl.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/s);
    if (!m) return res.status(400).json({ error: 'titleBlockCrop.dataUrl must be a base64 image data URL' });
    content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    cropRegion = titleBlockCrop.region;
  }
  content.push({ type: 'text', text: pageUnderstandingPrompt(!!cropRegion) });

  let text, usage;
  try {
    const out = await aiComplete({
      model: AI_DRAWINGS_MODEL,
      maxTokens: 2000,
      messages: [{ role: 'user', content }],
    });
    text = out.text;
    usage = out.usage;
  } catch (e) {
    if (e instanceof AiError && e.code === 'UNCONFIGURED') {
      return res.status(503).json({ error: 'AI is not configured in this environment' });
    }
    return res.status(502).json({ error: 'vision call failed: ' + e.message });
  }

  // The money is spent — record it BEFORE judging the output (honest cap).
  await aiSpend.commitTakeoff(jobId, (t) => {
    aiSpend.recordSpend(t, usage, 'understand-page', { planId, pageIndex, promptVersion: PROMPT_VERSION }, {
      inputUsdPerToken: COST_PER_INPUT_TOKEN,
      outputUsdPerToken: COST_PER_OUTPUT_TOKEN,
    });
  });

  const json = extractJson(text);
  const parsed = json ? ModelOutput.safeParse(json) : { success: false };
  if (!parsed.success) {
    // Nothing persists to the extraction store — no invented values (P7).
    return res.status(502).json({
      error: 'model returned unusable output — nothing was stored; try again',
    });
  }

  const ctx = { jobId, planId, pageIndex, pageSha256: page.sha256, cropRegion, username: user.username };
  let inserted;
  try {
    inserted = await store.insertExtraction(sql, tenantId, extractionRowFrom(ctx, parsed.data, json, usage));
  } catch (e) {
    // Two concurrent runs of the same page can both miss the cache; the
    // loser hits the unique cache index. Serve the winner's row — both
    // calls genuinely spent, both spends are already recorded.
    const dup = e && (e.code === '23505' || /duplicate key/i.test(String(e.message || '')));
    if (!dup) throw e;
    inserted = await store.findCachedExtraction(sql, tenantId, cacheKey);
    if (!inserted) throw e;
  }
  await store.upsertPlanSheet(sql, tenantId, inserted);

  await appendAuditLog({
    action: 'document.ai_extracted',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: planId,
    summary: `AI read page ${pageIndex + 1}: ${parsed.data.sheetType}` +
      (parsed.data.titleBlock.sheetNumber.value ? ` ${parsed.data.titleBlock.sheetNumber.value}` : ''),
    metadata: { pageIndex, model: AI_DRAWINGS_MODEL, promptVersion: PROMPT_VERSION },
  }).catch(() => {});

  const overrides = await store.listOverrides(sql, tenantId, jobId);
  const rows = await store.listPlanSheets(sql, tenantId, jobId);
  const row = rows.find((r) => r.plan_id === planId && r.page_index === pageIndex);
  const fresh = await aiSpend.readTakeoff(jobId);
  return res.status(200).json({
    cached: false,
    sheet: row ? effectiveSheet(row, overrides) : null,
    spend: { totalUsd: fresh.spend.totalUsd, capUsd: aiSpend.COST_CAP_USD },
  });
}

async function handleOverride(res, sql, tenantId, jobId, user, body) {
  const parsed = OverrideBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, field } = parsed.data;
  const value = cleanValue(parsed.data.value);
  if (field === 'sheetType' && value !== null && !store.SHEET_TYPES.includes(value)) {
    return res.status(400).json({ error: 'sheetType must be one of: ' + store.SHEET_TYPES.join(', ') });
  }
  // The page must exist on the register (no corrections on phantom pages).
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });

  await store.upsertOverride(sql, tenantId, {
    jobId, planId, pageIndex, field, value,
    correctedBy: user.username || 'Unknown',
    correctedByUserId: user.id || null,
  });
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: planId,
    summary: `corrected AI ${field} on page ${pageIndex + 1} → ${value === null ? '(absent)' : '"' + value + '"'}`,
    metadata: { pageIndex, field },
  }).catch(() => {});

  const overrides = await store.listOverrides(sql, tenantId, jobId);
  const rows = await store.listPlanSheets(sql, tenantId, jobId);
  const row = rows.find((r) => r.plan_id === planId && r.page_index === pageIndex);
  return res.status(200).json({ sheet: row ? effectiveSheet(row, overrides) : null });
}

async function handleClearOverride(res, sql, tenantId, jobId, user, body) {
  const parsed = ClearOverrideBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, field } = parsed.data;
  const removed = await store.deleteOverride(sql, tenantId, jobId, planId, pageIndex, field);
  if (!removed) return res.status(404).json({ error: 'no override on that field' });
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: planId,
    summary: `cleared AI ${field} correction on page ${pageIndex + 1} (back to AI value)`,
    metadata: { pageIndex, field, cleared: true },
  }).catch(() => {});
  const overrides = await store.listOverrides(sql, tenantId, jobId);
  const rows = await store.listPlanSheets(sql, tenantId, jobId);
  const row = rows.find((r) => r.plan_id === planId && r.page_index === pageIndex);
  return res.status(200).json({ sheet: row ? effectiveSheet(row, overrides) : null });
}

// ─── #201: legend vocabulary handlers ───────────────────────────────────────

function legendEntryView(row) {
  return {
    id: row.id,
    origin: row.origin,
    status: row.status,
    label: row.label,
    effectiveLabel: row.human_label !== null && row.human_label !== undefined ? row.human_label : row.label,
    description: row.description,
    category: row.category,
    symbolText: row.symbol_text,
    symbolCropUrl: row.symbol_crop_url,
    cropRegion: row.crop_region,
    sourcePlanId: row.source_plan_id,
    sourcePageIndex: row.source_page_index,
    confidence: row.confidence,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by_label,
    reviewNote: row.review_note,
  };
}

async function handleLegendList(res, sql, tenantId, jobId) {
  const rows = await store.listLegendEntries(sql, tenantId, jobId);
  return res.status(200).json({
    entries: rows.map(legendEntryView),
    categories: store.LEGEND_CATEGORIES,
    model: AI_DRAWINGS_MODEL,
    promptVersion: LEGEND_PROMPT_VERSION,
  });
}

async function handleExtractLegend(res, sql, tenantId, jobId, user, body) {
  const parsedBody = ExtractLegendBody.safeParse(body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: parsedBody.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex } = parsedBody.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const { page } = found;

  const cacheKey = {
    jobId, planId, pageIndex,
    pageSha256: page.sha256,
    kind: KIND_LEGEND,
    promptVersion: LEGEND_PROMPT_VERSION,
    model: AI_DRAWINGS_MODEL,
  };

  // Same cache semantics as page understanding: an unchanged page + same
  // prompt/model never bills twice; the MERGE below is idempotent (dedupe
  // index), so a re-click safely re-converges the vocabulary.
  let extraction = await store.findCachedExtraction(sql, tenantId, cacheKey);
  const cached = !!extraction;
  if (!extraction) {
    const takeoff = await aiSpend.readTakeoff(jobId);
    if (aiSpend.overBudget(takeoff)) {
      return res.status(402).json({
        error: 'cost cap reached for this job ($' + aiSpend.COST_CAP_USD + ')',
        spend: takeoff.spend,
      });
    }
    let content;
    try {
      const png = await fetchPngAsBase64(page.pngUrl);
      content = [
        { type: 'image', source: { type: 'base64', media_type: png.mediaType, data: png.base64 } },
        { type: 'text', text: legendPrompt() },
      ];
    } catch (e) {
      return res.status(502).json({ error: 'could not fetch page image: ' + e.message });
    }
    let text, usage;
    try {
      const out = await aiComplete({
        model: AI_DRAWINGS_MODEL,
        maxTokens: 4000, // a full legend is 40+ rows of JSON
        messages: [{ role: 'user', content }],
      });
      text = out.text;
      usage = out.usage;
    } catch (e) {
      if (e instanceof AiError && e.code === 'UNCONFIGURED') {
        return res.status(503).json({ error: 'AI is not configured in this environment' });
      }
      return res.status(502).json({ error: 'vision call failed: ' + e.message });
    }
    // The money is spent — record it BEFORE judging the output (honest cap).
    await aiSpend.commitTakeoff(jobId, (t) => {
      aiSpend.recordSpend(t, usage, 'extract-legend', { planId, pageIndex, promptVersion: LEGEND_PROMPT_VERSION }, {
        inputUsdPerToken: COST_PER_INPUT_TOKEN,
        outputUsdPerToken: COST_PER_OUTPUT_TOKEN,
      });
    });
    const json = extractJson(text);
    if (!json || !LegendModelOutput.safeParse(json).success) {
      return res.status(502).json({
        error: 'model returned unusable output — nothing was stored; try again',
      });
    }
    try {
      extraction = await store.insertExtraction(sql, tenantId, {
        jobId, planId, pageIndex,
        pageSha256: page.sha256,
        kind: KIND_LEGEND,
        model: AI_DRAWINGS_MODEL,
        promptVersion: LEGEND_PROMPT_VERSION,
        raw: json,
        sheetType: null, sheetTypeConfidence: null,
        sheetNumber: null, sheetNumberConfidence: null,
        sheetTitle: null, sheetTitleConfidence: null,
        revision: null, revisionConfidence: null,
        scale: null, scaleConfidence: null,
        region: null,
        inputTokens: usage ? Number(usage.inputTokens ?? usage.input_tokens ?? 0) : null,
        outputTokens: usage ? Number(usage.outputTokens ?? usage.output_tokens ?? 0) : null,
        createdByLabel: user.username || null,
      });
    } catch (e) {
      const dup = e && (e.code === '23505' || /duplicate key/i.test(String(e.message || '')));
      if (!dup) throw e;
      extraction = await store.findCachedExtraction(sql, tenantId, cacheKey);
      if (!extraction) throw e;
    }
  }

  const parsedOut = LegendModelOutput.safeParse(extraction.raw);
  if (!parsedOut.success) {
    return res.status(502).json({ error: 'stored legend run is unreadable — re-run after a prompt bump' });
  }
  const output = parsedOut.data;

  let inserted = [];
  let duplicates = 0;
  let rejectedSkipped = 0;
  if (output.isLegendPresent && output.entries.length > 0) {
    // A label a human explicitly rejected must not resurrect on re-runs.
    const rejected = new Set(await store.rejectedLegendLabels(sql, tenantId, jobId));
    const candidates = [];
    for (const e of output.entries) {
      if (rejected.has(store.normalizeLabel(e.label))) {
        rejectedSkipped += 1;
        continue;
      }
      candidates.push({
        jobId,
        label: e.label.trim(),
        description: cleanValue(e.description),
        category: e.category || null,
        symbolText: cleanValue(e.symbol),
        cropRegion: e.bbox || null,
        sourcePlanId: planId,
        sourcePageIndex: pageIndex,
        sourcePageSha256: page.sha256,
        extractionId: extraction.id,
        confidence: e.confidence,
        model: extraction.model,
        promptVersion: extraction.prompt_version,
        createdByLabel: user.username || null,
      });
    }
    const merged = await store.insertLegendSuggestions(sql, tenantId, candidates);
    inserted = merged.inserted;
    duplicates = merged.duplicates;
  }

  if (inserted.length > 0) {
    await appendAuditLog({
      action: 'document.ai_extracted',
      actorId: user.id,
      actorName: user.username || 'Unknown',
      actorRole: user.role || null,
      jobId,
      targetType: 'document',
      targetId: planId,
      summary: `AI read ${inserted.length} legend entr${inserted.length === 1 ? 'y' : 'ies'} from page ${pageIndex + 1}`,
      metadata: { kind: KIND_LEGEND, pageIndex, inserted: inserted.length, promptVersion: LEGEND_PROMPT_VERSION },
    }).catch(() => {});
  }

  const entries = await store.listLegendEntries(sql, tenantId, jobId);
  const fresh = await aiSpend.readTakeoff(jobId);
  return res.status(200).json({
    cached,
    isLegendPresent: output.isLegendPresent,
    extracted: output.entries.length,
    inserted: inserted.length,
    duplicates,
    rejectedSkipped,
    notes: output.notes || null,
    entries: entries.map(legendEntryView),
    spend: { totalUsd: fresh.spend.totalUsd, capUsd: aiSpend.COST_CAP_USD },
  });
}

async function handleReviewLegendEntry(res, sql, tenantId, jobId, user, body) {
  const parsed = ReviewLegendBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { entryId, status, humanLabel, note } = parsed.data;
  if (status === 'edited' && !cleanValue(humanLabel)) {
    return res.status(400).json({ error: 'edited requires humanLabel — that is what distinguishes it from accept' });
  }
  const entry = await store.getLegendEntry(sql, tenantId, jobId, entryId);
  if (!entry) return res.status(404).json({ error: 'legend entry not found' });
  const allowed = store.LEGEND_TRANSITIONS[entry.status] || [];
  if (!allowed.includes(status)) {
    return res.status(409).json({ error: `cannot ${status} a ${entry.status} entry` });
  }
  const updated = await store.reviewLegendEntry(sql, tenantId, jobId, entry, {
    status,
    humanLabel: status === 'edited' ? cleanValue(humanLabel) : entry.human_label,
    note: cleanValue(note),
    reviewedByLabel: user.username || 'Unknown',
  });
  if (!updated) return res.status(409).json({ error: 'entry was reviewed concurrently — reload' });
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: entry.source_plan_id || 'legend',
    summary: `legend entry "${updated.human_label || updated.label}" ${status}`,
    metadata: { kind: 'legend', entryId, status },
  }).catch(() => {});
  return res.status(200).json({ entry: legendEntryView(updated) });
}

async function handleAddLegendEntry(res, sql, tenantId, jobId, user, body) {
  const parsed = AddLegendBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const row = await store.addHumanLegendEntry(sql, tenantId, {
    jobId,
    label: parsed.data.label.trim(),
    description: cleanValue(parsed.data.description),
    category: parsed.data.category || null,
    createdByLabel: user.username || 'Unknown',
  });
  if (!row) {
    return res.status(409).json({ error: 'an entry with that label already exists on this job' });
  }
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: 'legend',
    summary: `added legend entry "${row.label}" the AI missed`,
    metadata: { kind: 'legend', entryId: row.id, added: true },
  }).catch(() => {});
  return res.status(201).json({ entry: legendEntryView(row) });
}

async function handleAttachLegendCrop(res, sql, tenantId, jobId, user, body) {
  const parsed = AttachLegendCropBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const entry = await store.getLegendEntry(sql, tenantId, jobId, parsed.data.entryId);
  if (!entry) return res.status(404).json({ error: 'legend entry not found' });
  const m = parsed.data.dataUrl.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/s);
  if (!m) return res.status(400).json({ error: 'dataUrl must be a base64 image data URL' });
  const buf = Buffer.from(m[2], 'base64');
  const uploaded = await put(`jobs/${jobId}/legend-crops/${entry.id}.png`, buf, {
    access: 'public',
    contentType: m[1],
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  const updated = await store.setLegendCrop(sql, tenantId, jobId, entry.id, uploaded.url);
  return res.status(200).json({ entry: updated ? legendEntryView(updated) : null });
}

// ─── #202/#207: schedule table handlers ─────────────────────────────────────

function scheduleTableView(t) {
  return {
    id: t.id,
    planId: t.plan_id,
    pageIndex: t.page_index,
    pageSha256: t.page_sha256,
    tableKind: t.table_kind,
    boardIdentifier: t.board_identifier,
    region: t.region,
    headers: t.headers,
    columnMap: t.column_map,
    rowCount: t.row_count,
    model: t.model,
    promptVersion: t.prompt_version,
    createdAt: t.created_at,
  };
}

// Effective cell = human correction (wins) else the AI's verbatim read.
function scheduleRowView(r) {
  const cells = r.cells || {};
  const human = r.human_cells || {};
  const effective = {};
  for (const key of new Set([...Object.keys(cells), ...Object.keys(human)])) {
    const corrected = Object.prototype.hasOwnProperty.call(human, key);
    effective[key] = {
      value: corrected ? human[key] : (cells[key] ? cells[key].value : null),
      confidence: cells[key] ? cells[key].confidence : null,
      corrected,
    };
  }
  return {
    id: r.id,
    tableId: r.table_id,
    rowIndex: r.row_index,
    cells,
    humanCells: r.human_cells,
    effective,
    rowRegion: r.row_region,
    status: r.status,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by_label,
    reviewNote: r.review_note,
  };
}

async function handleSchedulesList(res, sql, tenantId, jobId) {
  const tables = await store.listScheduleTables(sql, tenantId, jobId);
  const rows = await store.listScheduleRowsForTables(sql, tenantId, tables.map((t) => t.id));
  return res.status(200).json({
    tables: tables.map(scheduleTableView),
    rows: rows.map(scheduleRowView),
    columns: store.SCHEDULE_COLUMNS,
    promptVersions: SCHEDULE_PROMPT_VERSIONS,
  });
}

// Normalise a validated model table into store shape: cell values trimmed
// (verbatim otherwise), '' → null.
function normaliseModelTable(t) {
  return {
    boardIdentifier: cleanValue(t.boardIdentifier),
    region: t.region || null,
    headers: t.headers,
    columnMap: t.columnMap,
    rows: t.rows.map((r) => {
      const cells = {};
      for (const [key, cell] of Object.entries(r.cells)) {
        const v = cell.value === null ? null : String(cell.value).trim();
        cells[key] = { value: v === '' ? null : v, confidence: cell.confidence };
      }
      return { rowRegion: r.rowRegion || null, cells };
    }),
  };
}

async function handleExtractSchedule(res, sql, tenantId, jobId, user, body) {
  const parsedBody = ExtractScheduleBody.safeParse(body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: parsedBody.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, tableKind } = parsedBody.data;
  const runKind = SCHEDULE_RUN_KINDS[tableKind];
  const promptVersion = SCHEDULE_PROMPT_VERSIONS[tableKind];

  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const { page } = found;

  const cacheKey = {
    jobId, planId, pageIndex,
    pageSha256: page.sha256,
    kind: runKind,
    promptVersion,
    model: AI_DRAWINGS_MODEL,
  };

  let extraction = await store.findCachedExtraction(sql, tenantId, cacheKey);
  const cached = !!extraction;
  if (!extraction) {
    const takeoff = await aiSpend.readTakeoff(jobId);
    if (aiSpend.overBudget(takeoff)) {
      return res.status(402).json({
        error: 'cost cap reached for this job ($' + aiSpend.COST_CAP_USD + ')',
        spend: takeoff.spend,
      });
    }
    let content;
    try {
      const png = await fetchPngAsBase64(page.pngUrl);
      content = [
        { type: 'image', source: { type: 'base64', media_type: png.mediaType, data: png.base64 } },
        { type: 'text', text: schedulePrompt(tableKind) },
      ];
    } catch (e) {
      return res.status(502).json({ error: 'could not fetch page image: ' + e.message });
    }
    let text, usage;
    try {
      const out = await aiComplete({
        model: AI_DRAWINGS_MODEL,
        maxTokens: 4000, // dense tables — rows dominate the budget
        messages: [{ role: 'user', content }],
      });
      text = out.text;
      usage = out.usage;
    } catch (e) {
      if (e instanceof AiError && e.code === 'UNCONFIGURED') {
        return res.status(503).json({ error: 'AI is not configured in this environment' });
      }
      return res.status(502).json({ error: 'vision call failed: ' + e.message });
    }
    // The money is spent — record it BEFORE judging the output (honest cap).
    await aiSpend.commitTakeoff(jobId, (t) => {
      aiSpend.recordSpend(t, usage, 'extract-schedule', { planId, pageIndex, tableKind, promptVersion }, {
        inputUsdPerToken: COST_PER_INPUT_TOKEN,
        outputUsdPerToken: COST_PER_OUTPUT_TOKEN,
      });
    });
    const json = extractJson(text);
    if (!json || !ScheduleModelOutput.safeParse(json).success) {
      return res.status(502).json({
        error: 'model returned unusable output — nothing was stored; try again',
      });
    }
    try {
      extraction = await store.insertExtraction(sql, tenantId, {
        jobId, planId, pageIndex,
        pageSha256: page.sha256,
        kind: runKind,
        model: AI_DRAWINGS_MODEL,
        promptVersion,
        raw: json,
        sheetType: null, sheetTypeConfidence: null,
        sheetNumber: null, sheetNumberConfidence: null,
        sheetTitle: null, sheetTitleConfidence: null,
        revision: null, revisionConfidence: null,
        scale: null, scaleConfidence: null,
        region: null,
        inputTokens: usage ? Number(usage.inputTokens ?? usage.input_tokens ?? 0) : null,
        outputTokens: usage ? Number(usage.outputTokens ?? usage.output_tokens ?? 0) : null,
        createdByLabel: user.username || null,
      });
    } catch (e) {
      const dup = e && (e.code === '23505' || /duplicate key/i.test(String(e.message || '')));
      if (!dup) throw e;
      extraction = await store.findCachedExtraction(sql, tenantId, cacheKey);
      if (!extraction) throw e;
    }
  }

  const parsedOut = ScheduleModelOutput.safeParse(extraction.raw);
  if (!parsedOut.success) {
    return res.status(502).json({ error: 'stored schedule run is unreadable — re-run after a prompt bump' });
  }
  const output = parsedOut.data;

  // Idempotent materialisation: a cached re-click serves the tables the run
  // already produced; a fresh run inserts + supersedes the page's old tables.
  let liveTables = await store.liveTablesForExtraction(sql, tenantId, extraction.id);
  if (liveTables.length === 0 && output.isSchedulePresent && output.tables.length > 0) {
    liveTables = await store.insertScheduleTables(
      sql,
      tenantId,
      {
        jobId, planId, pageIndex,
        pageSha256: page.sha256,
        tableKind,
        extractionId: extraction.id,
        model: extraction.model,
        promptVersion: extraction.prompt_version,
        createdByLabel: user.username || null,
      },
      output.tables.map(normaliseModelTable),
    );
    await appendAuditLog({
      action: 'document.ai_extracted',
      actorId: user.id,
      actorName: user.username || 'Unknown',
      actorRole: user.role || null,
      jobId,
      targetType: 'document',
      targetId: planId,
      summary: `AI read ${liveTables.length} ${tableKind} schedule table${liveTables.length === 1 ? '' : 's'} (${liveTables.reduce((n, t) => n + t.row_count, 0)} rows) from page ${pageIndex + 1}`,
      metadata: { kind: runKind, pageIndex, tables: liveTables.length, promptVersion },
    }).catch(() => {});
  }

  const allTables = await store.listScheduleTables(sql, tenantId, jobId);
  const rows = await store.listScheduleRowsForTables(sql, tenantId, allTables.map((t) => t.id));
  const fresh = await aiSpend.readTakeoff(jobId);
  return res.status(200).json({
    cached,
    isSchedulePresent: output.isSchedulePresent,
    notes: output.notes || null,
    tables: allTables.map(scheduleTableView),
    rows: rows.map(scheduleRowView),
    spend: { totalUsd: fresh.spend.totalUsd, capUsd: aiSpend.COST_CAP_USD },
  });
}

async function handleReviewScheduleRow(res, sql, tenantId, jobId, user, body) {
  const parsed = ReviewScheduleRowBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { rowId, status, cells, note } = parsed.data;
  if (status === 'edited' && (!cells || Object.keys(cells).length === 0)) {
    return res.status(400).json({ error: 'edited requires cell corrections — that is what distinguishes it from accept' });
  }
  const row = await store.getScheduleRow(sql, tenantId, jobId, rowId);
  if (!row) return res.status(404).json({ error: 'schedule row not found' });
  const allowed = store.SCHEDULE_ROW_TRANSITIONS[row.status] || [];
  if (!allowed.includes(status)) {
    return res.status(409).json({ error: `cannot ${status} a ${row.status} row` });
  }
  let humanCells;
  if (status === 'edited') {
    humanCells = { ...(row.human_cells || {}) };
    for (const [key, value] of Object.entries(cells)) {
      humanCells[key] = value === null ? null : String(value).trim();
    }
  }
  const updated = await store.reviewScheduleRow(sql, tenantId, jobId, row, {
    status,
    humanCells,
    note: cleanValue(note),
    reviewedByLabel: user.username || 'Unknown',
  });
  if (!updated) return res.status(409).json({ error: 'row was reviewed concurrently — reload' });
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: 'schedule',
    summary: `schedule row ${updated.row_index + 1} ${status}` +
      (status === 'edited' ? ` (${Object.keys(cells).length} cell${Object.keys(cells).length === 1 ? '' : 's'})` : ''),
    metadata: { kind: 'schedule', rowId, status },
  }).catch(() => {});
  return res.status(200).json({ row: scheduleRowView(updated) });
}

// ─── #204: device detection handlers ────────────────────────────────────────

// Prompt (version: DETECTION_PROMPT_VERSION). `vocab` rows carry
// {label, symbolText, refIndex|null} — refIndex points at the extra
// reference image for that entry (few-shot from the legend crops).
function detectionPrompt(vocab) {
  const lines = vocab.map((v, i) => {
    const ref = v.refIndex !== null ? ` — reference image #${v.refIndex + 1} shows this symbol` : '';
    const sym = v.symbolText ? ` (drawn as: ${v.symbolText})` : '';
    return `  ${i}: ${v.label}${sym}${ref}`;
  });
  return `You are locating electrical devices on ONE TILE cropped from a floor-plan sheet of an Australian construction drawing set.

The FIRST image is the tile. Any further images are reference crops of this project's own legend symbols (numbered in the vocabulary below).

THIS PROJECT'S VOCABULARY — detect ONLY these (index: label):
${lines.join('\n')}

For EVERY instance of a vocabulary symbol visible in the tile return:
- entryIndex: the vocabulary index above
- bbox: a tight box around the symbol in TILE-normalised coordinates {"x","y","w","h"} each 0..1 of THIS TILE
- confidence: YOUR honest 0..1 estimate

RULES — non-negotiable:
- ONLY vocabulary symbols. Never invent device types; ignore text, dimensions, walls, furniture.
- Where symbols are too dense, overlapping or degraded to count reliably, DO NOT guess instance-by-instance — return that area in uncertainRegions with a short note instead.
- A symbol only partially visible at the tile edge still counts if identifiable.
- If the tile contains no vocabulary symbols: {"detections": [], "uncertainRegions": [], "notes": "..."}.
- Return ONLY strict JSON:
{
  "detections": [ { "entryIndex": 0, "bbox": {"x":0.31,"y":0.44,"w":0.02,"h":0.02}, "confidence": 0.9 } ],
  "uncertainRegions": [ { "bbox": {"x":0.6,"y":0.1,"w":0.2,"h":0.15}, "note": "dense ceiling grid — symbols overlap" } ],
  "notes": "one short caveat sentence, or null"
}`;
}

function detectionView(r) {
  return {
    id: r.id,
    planId: r.plan_id,
    pageIndex: r.page_index,
    pageSha256: r.page_sha256,
    kind: r.kind,
    legendEntryId: r.legend_entry_id,
    label: r.label,
    bbox: r.bbox,
    confidence: r.confidence,
    note: r.note,
    runId: r.run_id,
    createdAt: r.created_at,
  };
}

// Map a tile-normalised box into page-normalised coordinates.
function tileBoxToPage(tile, b) {
  return {
    x: tile.x + b.x * tile.w,
    y: tile.y + b.y * tile.h,
    w: b.w * tile.w,
    h: b.h * tile.h,
  };
}

async function handleDetectionsList(res, sql, tenantId, jobId) {
  const rows = await store.listDeviceDetections(sql, tenantId, jobId);
  return res.status(200).json({
    detections: rows.map(detectionView),
    promptVersion: DETECTION_PROMPT_VERSION,
    model: AI_DRAWINGS_MODEL,
  });
}

async function handleDetectDevices(res, sql, tenantId, jobId, user, body) {
  const parsedBody = DetectDevicesBody.safeParse(body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: parsedBody.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, tile } = parsedBody.data;

  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const { page } = found;

  // Detection is constrained matching against THIS project's reviewed
  // vocabulary — without one there is nothing honest to match against.
  const vocabRows = await store.acceptedLegendEntries(sql, tenantId, jobId);
  if (vocabRows.length === 0) {
    return res.status(409).json({
      error: 'no reviewed legend vocabulary — extract and accept the legend first (#201)',
    });
  }

  const tileKey = store.tileKeyOf(tile.region);
  const cacheKey = {
    jobId, planId, pageIndex,
    pageSha256: page.sha256,
    tileKey,
    promptVersion: DETECTION_PROMPT_VERSION,
    model: AI_DRAWINGS_MODEL,
  };

  let run = await store.findCachedDetectionRun(sql, tenantId, cacheKey);
  const cached = !!run;
  let vocab = null;
  if (!run) {
    const takeoff = await aiSpend.readTakeoff(jobId);
    if (aiSpend.overBudget(takeoff)) {
      return res.status(402).json({
        error: 'cost cap reached for this job ($' + aiSpend.COST_CAP_USD + ')',
        spend: takeoff.spend,
      });
    }
    const m = tile.dataUrl.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/s);
    if (!m) return res.status(400).json({ error: 'tile.dataUrl must be a base64 image data URL' });

    // Few-shot references: the reviewed vocabulary's symbol crops ride along
    // as extra images (fetched from Blob), capped to keep the call bounded.
    vocab = [];
    const refImages = [];
    for (const row of vocabRows) {
      let refIndex = null;
      if (row.symbol_crop_url && refImages.length < MAX_FEWSHOT_CROPS) {
        try {
          const png = await fetchPngAsBase64(row.symbol_crop_url);
          refIndex = refImages.length;
          refImages.push({ type: 'image', source: { type: 'base64', media_type: png.mediaType, data: png.base64 } });
        } catch {
          refIndex = null; // crop unreachable — the entry stays text-only
        }
      }
      vocab.push({
        entryId: row.id,
        label: row.human_label || row.label,
        symbolText: row.symbol_text,
        refIndex,
      });
    }

    const content = [
      { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
      ...refImages,
      { type: 'text', text: detectionPrompt(vocab) },
    ];
    let text, usage;
    try {
      const out = await aiComplete({
        model: AI_DRAWINGS_MODEL,
        maxTokens: 4000,
        messages: [{ role: 'user', content }],
      });
      text = out.text;
      usage = out.usage;
    } catch (e) {
      if (e instanceof AiError && e.code === 'UNCONFIGURED') {
        return res.status(503).json({ error: 'AI is not configured in this environment' });
      }
      return res.status(502).json({ error: 'vision call failed: ' + e.message });
    }
    // The money is spent — record it BEFORE judging the output (honest cap).
    await aiSpend.commitTakeoff(jobId, (t) => {
      aiSpend.recordSpend(t, usage, 'detect-devices', { planId, pageIndex, tileKey, promptVersion: DETECTION_PROMPT_VERSION }, {
        inputUsdPerToken: COST_PER_INPUT_TOKEN,
        outputUsdPerToken: COST_PER_OUTPUT_TOKEN,
      });
    });
    const json = extractJson(text);
    if (!json || !DetectionModelOutput.safeParse(json).success) {
      return res.status(502).json({
        error: 'model returned unusable output — nothing was stored; try again',
      });
    }
    try {
      run = await store.insertDetectionRun(sql, tenantId, {
        jobId, planId, pageIndex,
        pageSha256: page.sha256,
        tileKey,
        tileRegion: tile.region,
        promptVersion: DETECTION_PROMPT_VERSION,
        model: AI_DRAWINGS_MODEL,
        raw: { ...json, vocab: vocab.map((v) => ({ entryId: v.entryId, label: v.label })) },
        inputTokens: usage ? Number(usage.inputTokens ?? usage.input_tokens ?? 0) : null,
        outputTokens: usage ? Number(usage.outputTokens ?? usage.output_tokens ?? 0) : null,
        createdByLabel: user.username || null,
      });
    } catch (e) {
      const dup = e && (e.code === '23505' || /duplicate key/i.test(String(e.message || '')));
      if (!dup) throw e;
      run = await store.findCachedDetectionRun(sql, tenantId, cacheKey);
      if (!run) throw e;
    }
  }

  // Materialise detections from the run's raw output (idempotent: the IoU
  // seam-dedup also absorbs a cached re-click). The vocabulary mapping is
  // frozen INSIDE the run's raw so a later legend change can't re-label
  // history.
  const parsedOut = DetectionModelOutput.safeParse(run.raw);
  if (!parsedOut.success) {
    return res.status(502).json({ error: 'stored detection run is unreadable — re-run after a prompt bump' });
  }
  const runVocab = Array.isArray(run.raw.vocab) ? run.raw.vocab : [];
  const candidates = [];
  let offVocabulary = 0;
  for (const d of parsedOut.data.detections) {
    const entry = runVocab[d.entryIndex];
    if (!entry) {
      offVocabulary += 1; // model pointed outside the list — dropped, counted
      continue;
    }
    candidates.push({
      kind: 'device',
      legendEntryId: entry.entryId,
      label: entry.label,
      bbox: tileBoxToPage(tile.region, d.bbox),
      confidence: d.confidence,
      note: null,
    });
  }
  for (const u of parsedOut.data.uncertainRegions) {
    candidates.push({
      kind: 'uncertain-region',
      legendEntryId: null,
      label: null,
      bbox: tileBoxToPage(tile.region, u.bbox),
      confidence: null,
      note: cleanValue(u.note),
    });
  }
  const ctx = { jobId, planId, pageIndex, pageSha256: page.sha256, runId: run.id };
  const { inserted, seamDuplicates } = await store.insertDeviceDetections(
    sql, tenantId, ctx, candidates, DETECTION_SEAM_IOU,
  );

  if (inserted.length > 0) {
    await appendAuditLog({
      action: 'document.ai_extracted',
      actorId: user.id,
      actorName: user.username || 'Unknown',
      actorRole: user.role || null,
      jobId,
      targetType: 'document',
      targetId: planId,
      summary: `AI located ${inserted.filter((d) => d.kind === 'device').length} device${inserted.filter((d) => d.kind === 'device').length === 1 ? '' : 's'} on page ${pageIndex + 1} (unverified)`,
      metadata: { kind: 'device-detections', pageIndex, tileKey, promptVersion: DETECTION_PROMPT_VERSION },
    }).catch(() => {});
  }

  const pageRows = await store.listDeviceDetectionsForPage(
    sql, tenantId, jobId, planId, pageIndex, page.sha256,
  );
  const fresh = await aiSpend.readTakeoff(jobId);
  return res.status(200).json({
    cached,
    inserted: inserted.length,
    seamDuplicates,
    offVocabulary,
    detections: pageRows.map(detectionView),
    spend: { totalUsd: fresh.spend.totalUsd, capUsd: aiSpend.COST_CAP_USD },
  });
}

// ─── #203: revision diff handlers ───────────────────────────────────────────

function pageDiffView(d) {
  return {
    id: d.id,
    basePlanId: d.base_plan_id,
    basePageIndex: d.base_page_index,
    basePageSha256: d.base_page_sha256,
    headPlanId: d.head_plan_id,
    headPageIndex: d.head_page_index,
    headPageSha256: d.head_page_sha256,
    algoVersion: d.algo_version,
    identical: d.identical,
    alignment: d.alignment,
    basis: d.basis,
    regionCount: d.region_count,
    createdAt: d.created_at,
  };
}

function diffRegionView(r) {
  return {
    id: r.id,
    diffId: r.diff_id,
    regionIndex: r.region_index,
    bbox: r.bbox,
    areaCells: r.area_cells,
    status: r.status,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by_label,
    reviewNote: r.review_note,
  };
}

async function handleDiffsList(res, sql, tenantId, jobId) {
  const diffs = await store.listPageDiffs(sql, tenantId, jobId);
  const regions = await store.listDiffRegionsForDiffs(sql, tenantId, diffs.map((d) => d.id));
  return res.status(200).json({
    diffs: diffs.map(pageDiffView),
    regions: regions.map(diffRegionView),
    algoVersion: pageDiff.ALGO_VERSION,
  });
}

async function handleDiffPages(res, sql, tenantId, jobId, user, body) {
  const parsed = DiffPagesBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { base, head } = parsed.data;
  if (base.planId === head.planId && base.pageIndex === head.pageIndex) {
    return res.status(400).json({ error: 'base and head are the same page' });
  }
  const baseFound = await readPlanPage(jobId, base.planId, base.pageIndex);
  if (baseFound.error) return res.status(baseFound.status).json({ error: 'base: ' + baseFound.error });
  const headFound = await readPlanPage(jobId, head.planId, head.pageIndex);
  if (headFound.error) return res.status(headFound.status).json({ error: 'head: ' + headFound.error });

  const baseSha = baseFound.page.sha256;
  const headSha = headFound.page.sha256;

  // Cache: one live diff per (base sha, head sha, algo) — reruns are free.
  const cached = await store.findLiveDiff(sql, tenantId, jobId, baseSha, headSha, pageDiff.ALGO_VERSION);
  if (cached) {
    const regions = await store.listDiffRegionsForDiffs(sql, tenantId, [cached.id]);
    return res.status(200).json({
      cached: true,
      diff: pageDiffView(cached),
      regions: regions.map(diffRegionView),
    });
  }

  const ctx = {
    jobId,
    basePlanId: base.planId,
    basePageIndex: base.pageIndex,
    basePageSha256: baseSha,
    headPlanId: head.planId,
    headPageIndex: head.pageIndex,
    headPageSha256: headSha,
    algoVersion: pageDiff.ALGO_VERSION,
    createdByLabel: user.username || null,
  };

  let diffRow;
  let regions = [];
  if (baseSha === headSha) {
    // Byte-identical rasters — nothing to fetch, nothing to compute.
    diffRow = await store.insertPageDiff(sql, tenantId, {
      ...ctx,
      identical: true,
      alignment: null,
      basis: { byteIdentical: true },
    }, []);
  } else {
    let headBuf, baseBuf;
    try {
      [headBuf, baseBuf] = await Promise.all([
        fetchPngBuffer(headFound.page.pngUrl),
        fetchPngBuffer(baseFound.page.pngUrl),
      ]);
    } catch (e) {
      return res.status(502).json({ error: 'could not fetch page images: ' + e.message });
    }
    const result = pageDiff.diffPages(headBuf, baseBuf);
    if (!result.ok) {
      // Honest refusal — nothing stored, the reason goes to the human.
      return res.status(422).json({
        error: result.reason,
        alignment: result.alignment || null,
        basis: result.basis || null,
      });
    }
    diffRow = await store.insertPageDiff(sql, tenantId, {
      ...ctx,
      identical: false,
      alignment: result.alignment,
      basis: result.basis,
    }, result.regions);
    regions = await store.listDiffRegionsForDiffs(sql, tenantId, [diffRow.id]);
  }

  await appendAuditLog({
    action: 'document.revision_diffed',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: head.planId,
    summary: diffRow.identical
      ? `compared page ${head.pageIndex + 1} revisions — byte-identical`
      : `compared page ${head.pageIndex + 1} revisions — ${diffRow.region_count} changed region${diffRow.region_count === 1 ? '' : 's'}`,
    metadata: { basePlanId: base.planId, headPlanId: head.planId, regionCount: diffRow.region_count, algoVersion: pageDiff.ALGO_VERSION },
  }).catch(() => {});

  return res.status(200).json({
    cached: false,
    diff: pageDiffView(diffRow),
    regions: regions.map(diffRegionView),
  });
}

async function handleReviewDiffRegion(res, sql, tenantId, jobId, user, body) {
  const parsed = ReviewDiffRegionBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { regionId, status, note } = parsed.data;
  const region = await store.getDiffRegion(sql, tenantId, jobId, regionId);
  if (!region) return res.status(404).json({ error: 'diff region not found' });
  const allowed = store.DIFF_REGION_TRANSITIONS[region.status] || [];
  if (!allowed.includes(status)) {
    return res.status(409).json({ error: `cannot mark a ${region.status} region ${status}` });
  }
  const updated = await store.reviewDiffRegion(sql, tenantId, jobId, region, {
    status,
    note: cleanValue(note),
    reviewedByLabel: user.username || 'Unknown',
  });
  if (!updated) return res.status(409).json({ error: 'region was reviewed concurrently — reload' });
  await appendAuditLog({
    action: 'document.diff_region_reviewed',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: 'revision-diff',
    summary: `marked change region ${updated.region_index + 1} ${status}`,
    metadata: { regionId, status },
  }).catch(() => {});
  return res.status(200).json({ region: diffRegionView(updated) });
}

// ─── #205: count review handlers ────────────────────────────────────────────

function reviewActionView(r) {
  return {
    id: r.id,
    planId: r.plan_id,
    pageIndex: r.page_index,
    pageSha256: r.page_sha256,
    action: r.action,
    targetDetectionId: r.target_detection_id,
    targetReviewId: r.target_review_id,
    legendEntryId: r.legend_entry_id,
    label: r.label,
    bbox: r.bbox,
    note: r.note,
    createdAt: r.created_at,
    createdBy: r.created_by_label,
  };
}

function acceptedCountView(a, stale) {
  return {
    id: a.id,
    planId: a.plan_id,
    pageIndex: a.page_index,
    pageSha256: a.page_sha256,
    legendEntryId: a.legend_entry_id,
    label: a.label,
    count: a.count,
    basis: a.basis,
    acceptedAt: a.accepted_at,
    acceptedBy: a.accepted_by_label,
    stale,
  };
}

// Assemble ONE page raster's full review state from preloaded job rows —
// pure, so GET and every POST return the identical shape and the UI never
// re-derives. Accepted sign-offs prefer the current raster; a live sign-off
// whose raster (or marker set) no longer matches surfaces as stale, never
// silently — including entries whose markers were ALL removed since accept.
function assembleCountReviewPage(planId, pageIndex, pageSha256, jobRows) {
  const detections = jobRows.detections.filter(
    (d) => d.plan_id === planId && d.page_index === pageIndex && d.page_sha256 === pageSha256,
  );
  const reviews = jobRows.reviews.filter(
    (r) => r.plan_id === planId && r.page_index === pageIndex && r.page_sha256 === pageSha256,
  );
  const { markers, uncertain } = countReview.deriveMarkers(detections, reviews);
  const counts = countReview.countsByEntry(markers);
  const liveAccepted = jobRows.accepted.filter(
    (a) => a.plan_id === planId && a.page_index === pageIndex && a.status === 'live',
  );
  const acceptedFor = (entryId) =>
    liveAccepted.find((a) => a.legend_entry_id === entryId && a.page_sha256 === pageSha256) ||
    liveAccepted.find((a) => a.legend_entry_id === entryId) ||
    null;
  const countRows = counts.map((c) => {
    const acc = c.legendEntryId ? acceptedFor(c.legendEntryId) : null;
    return {
      legendEntryId: c.legendEntryId,
      label: c.label,
      liveCount: c.liveCount,
      removedCount: c.removedCount,
      addedCount: c.addedCount,
      accepted: acc
        ? acceptedCountView(
            acc,
            acc.page_sha256 !== pageSha256 || countReview.isAcceptStale(acc, markers),
          )
        : null,
    };
  });
  for (const acc of liveAccepted) {
    if (!countRows.some((c) => c.legendEntryId === acc.legend_entry_id)) {
      countRows.push({
        legendEntryId: acc.legend_entry_id,
        label: acc.label,
        liveCount: 0,
        removedCount: 0,
        addedCount: 0,
        accepted: acceptedCountView(acc, true),
      });
    }
  }
  // #206: rooms on this raster + the by-room grouping view. Assignment is
  // derived (pin > centre-in-bbox > unzoned) — nothing spatial is stored.
  const pageRooms = jobRows.rooms.filter(
    (r) => r.plan_id === planId && r.page_index === pageIndex && r.page_sha256 === pageSha256,
  );
  const pageAssignments = jobRows.assignments.filter(
    (a) => a.plan_id === planId && a.page_index === pageIndex && a.page_sha256 === pageSha256,
  );
  const assignment = roomAssign.assignMarkers(markers, pageRooms, pageAssignments);
  const pinnedKeys = new Set(pageAssignments.map((a) => a.marker_key));
  const onRaster = (r) =>
    r.plan_id === planId && r.page_index === pageIndex && r.page_sha256 === pageSha256;
  const pagePins = jobRows.pins.filter(onRaster);
  const calibration = jobRows.calibrations.find(onRaster) || null;
  const cableRun = jobRows.cableRuns.find(onRaster) || null;
  // #212: warn when a live link ties this page to ANOTHER page that also
  // carries accepted counts — the same physical scope may be counted twice.
  const countedPageKeys = new Set(
    jobRows.accepted
      .filter((a) => a.status === 'live')
      .map((a) => entityLinks.pageKeyOf(a.plan_id, a.page_index)),
  );
  const warnings = entityLinks.duplicateCountWarnings(jobRows.links, countedPageKeys);
  return {
    planId,
    pageIndex,
    pageSha256,
    markers: markers.map((m) => ({
      ...m,
      roomId: m.status === 'live' ? (assignment.get(m.key) ?? null) : null,
      roomPinned: pinnedKeys.has(m.key),
    })),
    uncertain: uncertain.map(detectionView),
    counts: countRows,
    rooms: pageRooms.map(roomView),
    byRoom: roomAssign.groupByRoom(markers, pageRooms, pageAssignments),
    cable: {
      pins: pagePins.map(boardPinView),
      calibration: calibration ? calibrationView(calibration) : null,
      run: cableRun ? cableRunView(cableRun, cableRunStale(cableRun, markers, pagePins, calibration)) : null,
    },
    duplicateCountWarnings: warnings.get(entityLinks.pageKeyOf(planId, pageIndex)) || [],
  };
}

// ─── #211: cable estimate handlers ──────────────────────────────────────────

function boardPinView(p) {
  return {
    id: p.id,
    boardIdentifier: p.board_identifier,
    point: p.point,
    createdBy: p.created_by_label,
  };
}

function calibrationView(c) {
  return {
    id: c.id,
    pointA: c.point_a,
    pointB: c.point_b,
    realMm: c.real_mm,
    rasterAspect: c.raster_aspect,
    mmPerNormX: c.mm_per_norm_x,
    mmPerNormY: c.mm_per_norm_y,
    titleScaleText: c.title_scale_text,
    createdAt: c.created_at,
    createdBy: c.created_by_label,
  };
}

function cableRunView(r, stale) {
  return {
    id: r.id,
    status: r.status,
    factors: r.factors,
    inputs: r.inputs,
    results: r.results,
    createdAt: r.created_at,
    createdBy: r.created_by_label,
    acceptedAt: r.accepted_at,
    acceptedBy: r.accepted_by_label,
    stale,
  };
}

// A run is stale when ANY of its inputs moved: the live marker set, the
// pins, or the calibration. Snapshot-vs-current comparison — same honesty
// contract as the #205 accepted counts.
function cableRunStale(run, markers, pins, calibration) {
  const inputs = run.inputs || {};
  const currentKeys = markers
    .filter((m) => m.status === 'live')
    .map((m) => m.key)
    .sort();
  const snapKeys = Array.isArray(inputs.markerKeys) ? [...inputs.markerKeys].sort() : [];
  if (currentKeys.length !== snapKeys.length || currentKeys.some((k, i) => k !== snapKeys[i])) {
    return true;
  }
  const pinSig = (arr) =>
    arr
      .map((p) => `${p.boardIdentifier ?? p.board_identifier}@${(p.point || {}).x},${(p.point || {}).y}`)
      .sort()
      .join('|');
  if (pinSig(pins) !== pinSig(Array.isArray(inputs.pins) ? inputs.pins : [])) return true;
  const snapCal = inputs.calibration || null;
  if (!calibration || !snapCal) return true;
  return (
    Number(snapCal.mmPerNormX) !== Number(calibration.mm_per_norm_x) ||
    Number(snapCal.mmPerNormY) !== Number(calibration.mm_per_norm_y)
  );
}

async function handlePinBoard(res, sql, tenantId, jobId, user, body) {
  const parsed = PinBoardBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, boardIdentifier, point } = parsed.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  await store.upsertBoardPin(sql, tenantId, {
    jobId,
    planId,
    pageIndex,
    pageSha256: found.page.sha256,
    boardIdentifier: boardIdentifier.trim(),
    point,
    createdByLabel: user.username || null,
  });
  const page = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, found.page.sha256);
  return res.status(200).json({ page });
}

async function handleClearBoardPin(res, sql, tenantId, jobId, user, body) {
  const parsed = ClearBoardPinBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, boardIdentifier } = parsed.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const removed = await store.deleteBoardPin(
    sql, tenantId, jobId, planId, pageIndex, found.page.sha256, boardIdentifier,
  );
  if (!removed) return res.status(404).json({ error: 'no pin with that identifier' });
  const page = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, found.page.sha256);
  return res.status(200).json({ page });
}

async function handleCalibrateSheet(res, sql, tenantId, jobId, user, body) {
  const parsed = CalibrateBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, pointA, pointB, realMm, rasterAspect } = parsed.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const scales = cable.calibrationScales(pointA, pointB, realMm, rasterAspect);
  if (scales.error) return res.status(400).json({ error: scales.error });

  // The sheet's effective title-block scale rides along as a CROSS-CHECK —
  // the calibration is the measured source, never the scale string.
  let titleScaleText = null;
  try {
    const [rows, overrides] = await Promise.all([
      store.listPlanSheets(sql, tenantId, jobId),
      store.listOverrides(sql, tenantId, jobId),
    ]);
    const row = rows.find((r) => r.plan_id === planId && r.page_index === pageIndex);
    if (row) titleScaleText = effectiveSheet(row, overrides).fields.scale.effective;
  } catch {
    // cross-check only — a failure here never blocks calibration
  }

  const saved = await store.upsertCalibration(sql, tenantId, {
    jobId,
    planId,
    pageIndex,
    pageSha256: found.page.sha256,
    pointA,
    pointB,
    realMm,
    rasterAspect,
    mmPerNormX: scales.mmPerNormX,
    mmPerNormY: scales.mmPerNormY,
    titleScaleText,
    createdByLabel: user.username || null,
  });
  await appendAuditLog({
    action: 'document.cable_estimated',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: planId,
    summary: `calibrated page ${pageIndex + 1} against a known ${Math.round(realMm)}mm dimension`,
    metadata: { kind: 'calibration', pageIndex, realMm },
  }).catch(() => {});
  const page = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, found.page.sha256);
  return res.status(200).json({ calibration: calibrationView(saved), page });
}

async function handleEstimateCable(res, sql, tenantId, jobId, user, body) {
  const parsed = EstimateCableBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, factors } = parsed.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const pageSha256 = found.page.sha256;

  const jobRows = await loadJobReviewRows(sql, tenantId, jobId);
  const onRaster = (r) =>
    r.plan_id === planId && r.page_index === pageIndex && r.page_sha256 === pageSha256;
  const calibration = jobRows.calibrations.find(onRaster) || null;
  if (!calibration) {
    return res.status(409).json({
      error: 'no trusted scale for this sheet — calibrate against a known dimension first (estimates are never unit-guessed)',
    });
  }
  const pins = jobRows.pins.filter(onRaster);
  if (!pins.length) {
    return res.status(409).json({ error: 'no board pinned on this sheet — pin the switchboard location first' });
  }
  const detections = jobRows.detections.filter(onRaster);
  const reviews = jobRows.reviews.filter(onRaster);
  const { markers } = countReview.deriveMarkers(detections, reviews);
  const liveMarkers = markers.filter((m) => m.status === 'live');
  if (!liveMarkers.length) {
    return res.status(409).json({ error: 'no devices on this sheet — detect or add markers first' });
  }

  const cal = { mmPerNormX: calibration.mm_per_norm_x, mmPerNormY: calibration.mm_per_norm_y };
  const result = cable.estimateRun(
    markers,
    pins.map((p) => ({ board_identifier: p.board_identifier, point: p.point })),
    cal,
    factors,
  );
  if (result.error) return res.status(409).json({ error: result.error });

  const run = await store.insertCableRun(sql, tenantId, {
    jobId,
    planId,
    pageIndex,
    pageSha256,
    factors: result.factors,
    inputs: {
      markerKeys: liveMarkers.map((m) => m.key).sort(),
      markers: liveMarkers.map((m) => ({ key: m.key, label: m.label, bbox: m.bbox })),
      pins: pins.map((p) => ({ boardIdentifier: p.board_identifier, point: p.point })),
      calibration: {
        id: calibration.id,
        mmPerNormX: calibration.mm_per_norm_x,
        mmPerNormY: calibration.mm_per_norm_y,
        realMm: calibration.real_mm,
        titleScaleText: calibration.title_scale_text,
      },
    },
    results: {
      perDevice: result.perDevice,
      boards: result.boards,
      totalMm: result.totalMm,
      deviceCount: result.deviceCount,
    },
    createdByLabel: user.username || null,
  });
  await appendAuditLog({
    action: 'document.cable_estimated',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: planId,
    summary: `estimated ${(result.totalMm / 1000).toFixed(0)}m of cable across ${result.deviceCount} devices on page ${pageIndex + 1} (heuristic draft — assumptions attached)`,
    metadata: { kind: 'cable-estimate', pageIndex, runId: run.id, totalMm: result.totalMm },
  }).catch(() => {});
  const page = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, pageSha256);
  return res.status(200).json({ run: cableRunView(run, false), page });
}

async function handleAcceptCableEstimate(res, sql, tenantId, jobId, user, body) {
  const parsed = AcceptCableBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { runId } = parsed.data;
  const run = await store.getCableRun(sql, tenantId, jobId, runId);
  if (!run) return res.status(404).json({ error: 'estimate run not found' });
  if (run.status === 'superseded') {
    return res.status(409).json({ error: 'this run was superseded by a recompute — accept the current one' });
  }
  if (run.status === 'accepted') {
    return res.status(409).json({ error: 'already accepted' });
  }
  const updated = await store.acceptCableRun(sql, tenantId, jobId, runId, user.username || 'Unknown');
  if (!updated) return res.status(409).json({ error: 'run changed concurrently — reload' });
  await appendAuditLog({
    action: 'document.cable_estimate_accepted',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: run.plan_id,
    summary: `accepted the ${((updated.results || {}).totalMm / 1000).toFixed(0)}m cable ESTIMATE on page ${run.page_index + 1} (assumptions attached)`,
    metadata: { kind: 'cable-estimate', runId, totalMm: (updated.results || {}).totalMm },
  }).catch(() => {});
  const page = await loadCountReviewPage(
    sql, tenantId, jobId, run.plan_id, run.page_index, run.page_sha256,
  );
  return res.status(200).json({ run: cableRunView(updated, cableRunStaleFromPage(page, updated)), page });
}

// convenience: recompute staleness for a run against an assembled page block
function cableRunStaleFromPage(page, run) {
  return cableRunStale(
    run,
    page.markers,
    (page.cable?.pins || []).map((p) => ({ board_identifier: p.boardIdentifier, point: p.point })),
    page.cable?.calibration
      ? { mm_per_norm_x: page.cable.calibration.mmPerNormX, mm_per_norm_y: page.cable.calibration.mmPerNormY }
      : null,
  );
}

async function loadJobReviewRows(sql, tenantId, jobId) {
  const [detections, reviews, accepted, rooms, assignments, pins, calibrations, cableRuns, links] =
    await Promise.all([
      store.listDeviceDetections(sql, tenantId, jobId),
      store.listDetectionReviews(sql, tenantId, jobId),
      store.listAcceptedCounts(sql, tenantId, jobId),
      store.listRooms(sql, tenantId, jobId),
      store.listRoomAssignments(sql, tenantId, jobId),
      store.listBoardPins(sql, tenantId, jobId),
      store.listCalibrations(sql, tenantId, jobId),
      store.listCableRuns(sql, tenantId, jobId),
      store.listEntityLinks(sql, tenantId, jobId),
    ]);
  return { detections, reviews, accepted, rooms, assignments, pins, calibrations, cableRuns, links };
}

async function handleCountReviewList(res, sql, tenantId, jobId) {
  const jobRows = await loadJobReviewRows(sql, tenantId, jobId);
  const index = await readBlob('jobs/' + jobId + '/plans-index.json', { plans: [] });
  const shaOf = new Map();
  for (const plan of index.plans || []) {
    for (const page of plan.pages || []) {
      if (page.sha256) shaOf.set(plan.id + ':' + page.pageIndex, page.sha256);
    }
  }
  const pageKeys = new Set();
  for (const d of jobRows.detections) pageKeys.add(d.plan_id + ':' + d.page_index);
  for (const r of jobRows.reviews) pageKeys.add(r.plan_id + ':' + r.page_index);
  for (const a of jobRows.accepted) {
    if (a.status === 'live') pageKeys.add(a.plan_id + ':' + a.page_index);
  }
  for (const r of jobRows.rooms) pageKeys.add(r.plan_id + ':' + r.page_index);
  const pages = [];
  for (const key of [...pageKeys].sort()) {
    const cut = key.lastIndexOf(':');
    const planId = key.slice(0, cut);
    const pageIndex = Number(key.slice(cut + 1));
    const sha = shaOf.get(key);
    if (!sha) continue; // page no longer registered — history stays in PG, not shown as actionable
    pages.push(assembleCountReviewPage(planId, pageIndex, sha, jobRows));
  }
  // drop pages with nothing to show for the CURRENT raster and no sign-offs
  const visible = pages.filter(
    (p) => p.markers.length > 0 || p.uncertain.length > 0 || p.counts.length > 0 || p.rooms.length > 0,
  );
  return res.status(200).json({ pages: visible });
}

async function loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, pageSha256) {
  const jobRows = await loadJobReviewRows(sql, tenantId, jobId);
  return assembleCountReviewPage(planId, pageIndex, pageSha256, jobRows);
}

async function handleReviewMarker(res, sql, tenantId, jobId, user, body) {
  const parsed = ReviewMarkerBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { action, detectionId, reviewId, toLegendEntryId, note } = parsed.data;

  let target;
  let targetKind;
  if (detectionId) {
    target = await store.getDeviceDetection(sql, tenantId, jobId, detectionId);
    if (!target) return res.status(404).json({ error: 'detection not found' });
    if (target.kind !== 'device') {
      return res.status(400).json({
        error: 'uncertain regions are not countable markers — add real markers over the area instead',
      });
    }
    targetKind = 'detection';
  } else {
    target = await store.getDetectionReview(sql, tenantId, jobId, reviewId);
    if (!target) return res.status(404).json({ error: 'marker not found' });
    if (target.action !== 'add') {
      return res.status(400).json({ error: 'reviewId must reference an added marker' });
    }
    targetKind = 'review';
  }

  // Acting on a marker from a superseded render would silently affect nothing
  // — refuse instead (the current raster needs its own detection pass).
  const found = await readPlanPage(jobId, target.plan_id, target.page_index);
  if (found.error) return res.status(found.status).json({ error: found.error });
  if (found.page.sha256 !== target.page_sha256) {
    return res.status(409).json({
      error: 'the sheet raster changed since this marker was made — re-run detection on the current render',
    });
  }

  let entry = null;
  if (action === 'reclassify') {
    entry = await store.getLegendEntry(sql, tenantId, jobId, toLegendEntryId);
    if (!entry) return res.status(404).json({ error: 'legend entry not found' });
    if (entry.status !== 'accepted' && entry.status !== 'edited') {
      return res.status(409).json({
        error: 'reclassify target must be a reviewed legend entry (accepted or edited)',
      });
    }
  }

  const inserted = await store.insertDetectionReview(sql, tenantId, {
    jobId,
    planId: target.plan_id,
    pageIndex: target.page_index,
    pageSha256: target.page_sha256,
    action,
    targetDetectionId: targetKind === 'detection' ? target.id : null,
    targetReviewId: targetKind === 'review' ? target.id : null,
    legendEntryId: action === 'reclassify' ? entry.id : null,
    label: action === 'reclassify' ? entry.human_label || entry.label : null,
    bbox: null,
    note: cleanValue(note),
    createdByLabel: user.username || null,
  });
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: target.plan_id,
    summary:
      action === 'reclassify'
        ? `reclassified a device marker to ${inserted.label} on page ${target.page_index + 1}`
        : `${action}d a device marker on page ${target.page_index + 1}`,
    metadata: { kind: 'device-marker', action, reviewId: inserted.id },
  }).catch(() => {});

  const page = await loadCountReviewPage(
    sql, tenantId, jobId, target.plan_id, target.page_index, target.page_sha256,
  );
  return res.status(200).json({ review: reviewActionView(inserted), page });
}

async function handleAddMarker(res, sql, tenantId, jobId, user, body) {
  const parsed = AddMarkerBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, bbox, legendEntryId, note } = parsed.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });

  const entry = await store.getLegendEntry(sql, tenantId, jobId, legendEntryId);
  if (!entry) return res.status(404).json({ error: 'legend entry not found' });
  if (entry.status !== 'accepted' && entry.status !== 'edited') {
    return res.status(409).json({
      error: 'added markers must use the reviewed legend vocabulary (accepted or edited)',
    });
  }

  const inserted = await store.insertDetectionReview(sql, tenantId, {
    jobId,
    planId,
    pageIndex,
    pageSha256: found.page.sha256,
    action: 'add',
    targetDetectionId: null,
    targetReviewId: null,
    legendEntryId: entry.id,
    label: entry.human_label || entry.label,
    bbox,
    note: cleanValue(note),
    createdByLabel: user.username || null,
  });
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: planId,
    summary: `added a ${inserted.label} marker the AI missed on page ${pageIndex + 1}`,
    metadata: { kind: 'device-marker', action: 'add', reviewId: inserted.id },
  }).catch(() => {});

  const page = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, found.page.sha256);
  return res.status(200).json({ review: reviewActionView(inserted), page });
}

async function handleAcceptCount(res, sql, tenantId, jobId, user, body) {
  const parsed = AcceptCountBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, legendEntryId } = parsed.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const pageSha256 = found.page.sha256;

  const entry = await store.getLegendEntry(sql, tenantId, jobId, legendEntryId);
  if (!entry) return res.status(404).json({ error: 'legend entry not found' });

  const before = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, pageSha256);
  const entryMarkers = before.markers.filter((m) => m.legendEntryId === legendEntryId);
  const liveMarkers = entryMarkers.filter((m) => m.status === 'live');
  // count 0 IS a valid sign-off ("none on this sheet") — but only after the
  // human actually reviewed something here: markers existed or were removed.
  if (entryMarkers.length === 0) {
    return res.status(409).json({
      error: 'nothing to accept — no markers of this type on the sheet (detect or add first)',
    });
  }

  // Snapshot EXACTLY what was counted: marker keys (staleness compare),
  // marker detail (provenance display), and the review actions that shaped
  // this entry's marker set (the corrections trail).
  const basis = {
    markerKeys: liveMarkers.map((m) => m.key).sort(),
    markers: liveMarkers.map((m) => ({
      key: m.key,
      source: m.source,
      bbox: m.bbox,
      label: m.label,
      confidence: m.confidence,
    })),
    reviewIds: [...new Set(entryMarkers.flatMap((m) => m.appliedReviewIds))],
  };

  let accepted;
  try {
    accepted = await store.insertAcceptedCount(sql, tenantId, {
      jobId,
      planId,
      pageIndex,
      pageSha256,
      legendEntryId: entry.id,
      label: entry.human_label || entry.label,
      count: liveMarkers.length,
      basis,
      acceptedByLabel: user.username || null,
    });
  } catch (e) {
    const dup = e && (e.code === '23505' || /duplicate key/i.test(String(e.message || '')));
    if (!dup) throw e;
    return res.status(409).json({ error: 'this count was accepted concurrently — reload' });
  }
  await appendAuditLog({
    action: 'document.count_accepted',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: planId,
    summary: `accepted ${accepted.label} count: ${accepted.count} on page ${pageIndex + 1} (human-verified)`,
    metadata: { kind: 'device-count', legendEntryId: entry.id, count: accepted.count },
  }).catch(() => {});

  const page = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, pageSha256);
  return res.status(200).json({ accepted: acceptedCountView(accepted, false), page });
}

// ─── #206: rooms and zones handlers ─────────────────────────────────────────

// Prompt (version: ROOMS_PROMPT_VERSION).
function roomsPrompt() {
  return `You are reading ONE floor-plan page of an Australian construction drawing set (usually electrical). Room names are often faint architectural underlay text.

TASK — list every LABELLED room/zone visible on the plan:
- name: the label EXACTLY as printed (e.g. "KITCHEN", "BED 2", "WIR"). Never invent, expand or translate names. The same name may appear more than once — list each instance separately.
- bbox: an APPROXIMATE extent of that room as {"x","y","w","h"} normalised 0..1 of the page — a box roughly covering the room's floor area including its label. Precision is not expected; a human redraws boxes later.
- confidence: YOUR honest 0..1 — faint/ambiguous underlay text should score LOW, not be guessed confidently.

RULES — non-negotiable:
- ONLY rooms that carry a printed label. Unlabelled space is simply not listed.
- Ignore title block, legends, schedules, notes blocks, north arrows, grid references.
- If the page is not a floor plan or has no labelled rooms: {"rooms": [], "notes": "..."}.
- Return ONLY strict JSON:
{
  "rooms": [ { "name": "KITCHEN", "bbox": {"x":0.32,"y":0.41,"w":0.18,"h":0.14}, "confidence": 0.85 } ],
  "notes": "one short caveat sentence, or null"
}`;
}

function roomView(r) {
  return {
    id: r.id,
    planId: r.plan_id,
    pageIndex: r.page_index,
    pageSha256: r.page_sha256,
    origin: r.origin,
    status: r.status,
    name: r.name,
    effectiveName: r.human_name || r.name,
    bbox: r.bbox,
    effectiveBbox: r.human_bbox || r.bbox,
    confidence: r.confidence,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by_label,
    reviewNote: r.review_note,
  };
}

async function handleExtractRooms(res, sql, tenantId, jobId, user, body) {
  const parsedBody = ExtractRoomsBody.safeParse(body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: parsedBody.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex } = parsedBody.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const { page } = found;

  const cacheKey = {
    jobId, planId, pageIndex,
    pageSha256: page.sha256,
    kind: KIND_ROOMS,
    promptVersion: ROOMS_PROMPT_VERSION,
    model: AI_DRAWINGS_MODEL,
  };
  let extraction = await store.findCachedExtraction(sql, tenantId, cacheKey);
  const cached = !!extraction;
  if (!extraction) {
    const takeoff = await aiSpend.readTakeoff(jobId);
    if (aiSpend.overBudget(takeoff)) {
      return res.status(402).json({
        error: 'cost cap reached for this job ($' + aiSpend.COST_CAP_USD + ')',
        spend: takeoff.spend,
      });
    }
    let content;
    try {
      const png = await fetchPngAsBase64(page.pngUrl);
      content = [
        { type: 'image', source: { type: 'base64', media_type: png.mediaType, data: png.base64 } },
        { type: 'text', text: roomsPrompt() },
      ];
    } catch (e) {
      return res.status(502).json({ error: 'could not fetch page image: ' + e.message });
    }
    let text, usage;
    try {
      const out = await aiComplete({
        model: AI_DRAWINGS_MODEL,
        maxTokens: 4000,
        messages: [{ role: 'user', content }],
      });
      text = out.text;
      usage = out.usage;
    } catch (e) {
      if (e instanceof AiError && e.code === 'UNCONFIGURED') {
        return res.status(503).json({ error: 'AI is not configured in this environment' });
      }
      return res.status(502).json({ error: 'vision call failed: ' + e.message });
    }
    // The money is spent — record it BEFORE judging the output (honest cap).
    await aiSpend.commitTakeoff(jobId, (t) => {
      aiSpend.recordSpend(t, usage, 'extract-rooms', { planId, pageIndex, promptVersion: ROOMS_PROMPT_VERSION }, {
        inputUsdPerToken: COST_PER_INPUT_TOKEN,
        outputUsdPerToken: COST_PER_OUTPUT_TOKEN,
      });
    });
    const json = extractJson(text);
    if (!json || !RoomsModelOutput.safeParse(json).success) {
      return res.status(502).json({
        error: 'model returned unusable output — nothing was stored; try again',
      });
    }
    try {
      extraction = await store.insertExtraction(sql, tenantId, {
        jobId, planId, pageIndex,
        pageSha256: page.sha256,
        kind: KIND_ROOMS,
        model: AI_DRAWINGS_MODEL,
        promptVersion: ROOMS_PROMPT_VERSION,
        raw: json,
        sheetType: null, sheetTypeConfidence: null,
        sheetNumber: null, sheetNumberConfidence: null,
        sheetTitle: null, sheetTitleConfidence: null,
        revision: null, revisionConfidence: null,
        scale: null, scaleConfidence: null,
        region: null,
        inputTokens: usage ? Number(usage.inputTokens ?? usage.input_tokens ?? 0) : null,
        outputTokens: usage ? Number(usage.outputTokens ?? usage.output_tokens ?? 0) : null,
        createdByLabel: user.username || null,
      });
    } catch (e) {
      const dup = e && (e.code === '23505' || /duplicate key/i.test(String(e.message || '')));
      if (!dup) throw e;
      extraction = await store.findCachedExtraction(sql, tenantId, cacheKey);
      if (!extraction) throw e;
    }
  }

  // Materialise suggestions from the run — idempotent: a cached re-click
  // finds this extraction's rooms already present and inserts nothing, so
  // human review state is never trampled.
  const already = await store.roomsForExtraction(sql, tenantId, extraction.id);
  let inserted = [];
  if (already.length === 0) {
    const parsedOut = RoomsModelOutput.safeParse(extraction.raw);
    if (!parsedOut.success) {
      return res.status(502).json({ error: 'stored rooms run is unreadable — re-run after a prompt bump' });
    }
    inserted = await store.insertRoomSuggestions(
      sql,
      tenantId,
      {
        jobId, planId, pageIndex,
        pageSha256: page.sha256,
        extractionId: extraction.id,
        model: AI_DRAWINGS_MODEL,
        promptVersion: ROOMS_PROMPT_VERSION,
        createdByLabel: user.username || null,
      },
      parsedOut.data.rooms.map((r) => ({
        name: r.name.trim(),
        bbox: r.bbox,
        confidence: r.confidence,
      })),
    );
    if (inserted.length > 0) {
      await appendAuditLog({
        action: 'document.ai_extracted',
        actorId: user.id,
        actorName: user.username || 'Unknown',
        actorRole: user.role || null,
        jobId,
        targetType: 'document',
        targetId: planId,
        summary: `AI mapped ${inserted.length} room${inserted.length === 1 ? '' : 's'} on page ${pageIndex + 1} (approximate extents, unverified)`,
        metadata: { kind: 'rooms', pageIndex, promptVersion: ROOMS_PROMPT_VERSION },
      }).catch(() => {});
    }
  }

  const pageBlock = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, page.sha256);
  const fresh = await aiSpend.readTakeoff(jobId);
  return res.status(200).json({
    cached,
    inserted: inserted.length,
    page: pageBlock,
    spend: { totalUsd: fresh.spend.totalUsd, capUsd: aiSpend.COST_CAP_USD },
  });
}

async function handleReviewRoom(res, sql, tenantId, jobId, user, body) {
  const parsed = ReviewRoomBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { roomId, status, name, bbox, note } = parsed.data;
  const room = await store.getRoom(sql, tenantId, jobId, roomId);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const allowed = store.ROOM_TRANSITIONS[room.status] || [];
  if (!allowed.includes(status)) {
    return res.status(409).json({ error: `cannot ${status} a ${room.status} room` });
  }
  const updated = await store.reviewRoom(sql, tenantId, jobId, room, {
    status,
    humanName: status === 'edited' && name ? name.trim() : undefined,
    humanBbox: status === 'edited' && bbox ? bbox : undefined,
    note: cleanValue(note),
    reviewedByLabel: user.username || 'Unknown',
  });
  if (!updated) return res.status(409).json({ error: 'room was reviewed concurrently — reload' });
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: room.plan_id,
    summary:
      status === 'edited'
        ? `${name ? 'renamed' : 'redrew'} room ${updated.human_name || updated.name} on page ${room.page_index + 1}`
        : `${status} room ${updated.human_name || updated.name} on page ${room.page_index + 1}`,
    metadata: { kind: 'room', roomId, status },
  }).catch(() => {});
  const pageBlock = await loadCountReviewPage(
    sql, tenantId, jobId, room.plan_id, room.page_index, room.page_sha256,
  );
  return res.status(200).json({ room: roomView(updated), page: pageBlock });
}

async function handleAddRoom(res, sql, tenantId, jobId, user, body) {
  const parsed = AddRoomBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, name, bbox } = parsed.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const inserted = await store.addHumanRoom(sql, tenantId, {
    jobId,
    planId,
    pageIndex,
    pageSha256: found.page.sha256,
    name: name.trim(),
    bbox,
    createdByLabel: user.username || null,
  });
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: planId,
    summary: `added room ${inserted.name} on page ${pageIndex + 1}`,
    metadata: { kind: 'room', roomId: inserted.id, status: 'added' },
  }).catch(() => {});
  const pageBlock = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, found.page.sha256);
  return res.status(200).json({ room: roomView(inserted), page: pageBlock });
}

async function handleAssignDeviceRoom(res, sql, tenantId, jobId, user, body) {
  const parsed = AssignRoomBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, markerKey, roomId } = parsed.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const pageSha256 = found.page.sha256;

  const before = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, pageSha256);
  const marker = before.markers.find((m) => m.key === markerKey);
  if (!marker || marker.status !== 'live') {
    return res.status(404).json({ error: 'marker not found on the current raster' });
  }
  let room = null;
  if (roomId !== null) {
    room = await store.getRoom(sql, tenantId, jobId, roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const live = room.status === 'suggested' || room.status === 'accepted' || room.status === 'edited';
    if (!live || room.plan_id !== planId || room.page_index !== pageIndex || room.page_sha256 !== pageSha256) {
      return res.status(409).json({ error: 'room is not live on this sheet raster' });
    }
  }
  await store.upsertRoomAssignment(sql, tenantId, {
    jobId,
    planId,
    pageIndex,
    pageSha256,
    markerKey,
    roomId,
    correctedByLabel: user.username || null,
  });
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: planId,
    summary: roomId
      ? `moved a ${marker.label || 'device'} marker to ${room.human_name || room.name} on page ${pageIndex + 1}`
      : `parked a ${marker.label || 'device'} marker as unzoned on page ${pageIndex + 1}`,
    metadata: { kind: 'room-assignment', markerKey, roomId },
  }).catch(() => {});
  const pageBlock = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, pageSha256);
  return res.status(200).json({ page: pageBlock });
}

async function handleClearDeviceRoom(res, sql, tenantId, jobId, user, body) {
  const parsed = ClearRoomAssignmentBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex, markerKey } = parsed.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const removed = await store.deleteRoomAssignment(
    sql, tenantId, jobId, planId, pageIndex, found.page.sha256, markerKey,
  );
  if (!removed) return res.status(404).json({ error: 'no room pin on that marker' });
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: planId,
    summary: `returned a device marker to automatic room grouping on page ${pageIndex + 1}`,
    metadata: { kind: 'room-assignment', markerKey, cleared: true },
  }).catch(() => {});
  const pageBlock = await loadCountReviewPage(sql, tenantId, jobId, planId, pageIndex, found.page.sha256);
  return res.status(200).json({ page: pageBlock });
}

// ─── #212: cross-sheet reference + link handlers ────────────────────────────

// Prompt (version: REFS_PROMPT_VERSION).
function refsPrompt() {
  return `You are reading ONE page of an Australian construction drawing set, looking ONLY for cross-sheet reference callouts.

TASK — list every reference to ANOTHER sheet visible on this page:
- Typical forms: "REFER E-501", "SEE DETAIL 3 / E-501", detail bubbles (a circle split by a line: detail number above, sheet number below), "REFER TO DWG E-201", section markers pointing at another sheet.
- text: the callout VERBATIM as printed.
- targetSheetNumber: the referenced sheet number EXACTLY as printed (e.g. "E-501").
- bbox: a box around the callout in normalised 0..1 page coordinates, or null if hard to localise.
- confidence: YOUR honest 0..1.

RULES — non-negotiable:
- ONLY references to OTHER sheets. Ignore the title block naming THIS sheet, revision tables, general notes without a sheet number.
- Never invent sheet numbers. If the page has no cross-references: {"refs": [], "notes": "..."}.
- Return ONLY strict JSON:
{
  "refs": [ { "text": "REFER E-501 FOR SWITCHBOARD DETAILS", "targetSheetNumber": "E-501", "bbox": {"x":0.72,"y":0.31,"w":0.12,"h":0.02}, "confidence": 0.9 } ],
  "notes": "one short caveat sentence, or null"
}`;
}

function sheetRefView(r, resolved) {
  return {
    id: r.id,
    planId: r.plan_id,
    pageIndex: r.page_index,
    pageSha256: r.page_sha256,
    text: r.text,
    targetSheetNumber: r.target_sheet_number,
    bbox: r.bbox,
    confidence: r.confidence,
    createdAt: r.created_at,
    resolved: resolved ?? null,
  };
}

function entityLinkView(l) {
  return {
    id: l.id,
    kind: l.kind,
    identifier: l.identifier,
    a: { planId: l.a_plan_id, pageIndex: l.a_page_index },
    b: { planId: l.b_plan_id, pageIndex: l.b_page_index },
    confidence: l.confidence,
    evidence: l.evidence,
    origin: l.origin,
    status: l.status,
    createdAt: l.created_at,
    reviewedAt: l.reviewed_at,
    reviewedBy: l.reviewed_by_label,
  };
}

// Effective sheet numbers for LIVE resolution (human overrides win, #197).
async function effectiveSheetNumbers(sql, tenantId, jobId) {
  const [rows, overrides] = await Promise.all([
    store.listPlanSheets(sql, tenantId, jobId),
    store.listOverrides(sql, tenantId, jobId),
  ]);
  return rows.map((row) => ({
    planId: row.plan_id,
    pageIndex: row.page_index,
    sheetNumber: effectiveSheet(row, overrides).fields.sheetNumber.effective,
  }));
}

async function handleLinksList(res, sql, tenantId, jobId) {
  const [refs, links, sheets] = await Promise.all([
    store.listSheetRefs(sql, tenantId, jobId),
    store.listEntityLinks(sql, tenantId, jobId),
    effectiveSheetNumbers(sql, tenantId, jobId),
  ]);
  const resolvedRefs = entityLinks.resolveRefs(refs, sheets);
  return res.status(200).json({
    refs: resolvedRefs.map((r) => sheetRefView(r, r.resolved)),
    links: links.map(entityLinkView),
    promptVersion: REFS_PROMPT_VERSION,
  });
}

async function handleExtractRefs(res, sql, tenantId, jobId, user, body) {
  const parsedBody = ExtractRefsBody.safeParse(body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: parsedBody.error.issues[0]?.message || 'invalid body' });
  }
  const { planId, pageIndex } = parsedBody.data;
  const found = await readPlanPage(jobId, planId, pageIndex);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const { page } = found;

  const cacheKey = {
    jobId, planId, pageIndex,
    pageSha256: page.sha256,
    kind: KIND_REFS,
    promptVersion: REFS_PROMPT_VERSION,
    model: AI_DRAWINGS_MODEL,
  };
  let extraction = await store.findCachedExtraction(sql, tenantId, cacheKey);
  const cached = !!extraction;
  if (!extraction) {
    const takeoff = await aiSpend.readTakeoff(jobId);
    if (aiSpend.overBudget(takeoff)) {
      return res.status(402).json({
        error: 'cost cap reached for this job ($' + aiSpend.COST_CAP_USD + ')',
        spend: takeoff.spend,
      });
    }
    let content;
    try {
      const png = await fetchPngAsBase64(page.pngUrl);
      content = [
        { type: 'image', source: { type: 'base64', media_type: png.mediaType, data: png.base64 } },
        { type: 'text', text: refsPrompt() },
      ];
    } catch (e) {
      return res.status(502).json({ error: 'could not fetch page image: ' + e.message });
    }
    let text, usage;
    try {
      const out = await aiComplete({
        model: AI_DRAWINGS_MODEL,
        maxTokens: 4000,
        messages: [{ role: 'user', content }],
      });
      text = out.text;
      usage = out.usage;
    } catch (e) {
      if (e instanceof AiError && e.code === 'UNCONFIGURED') {
        return res.status(503).json({ error: 'AI is not configured in this environment' });
      }
      return res.status(502).json({ error: 'vision call failed: ' + e.message });
    }
    // The money is spent — record it BEFORE judging the output (honest cap).
    await aiSpend.commitTakeoff(jobId, (t) => {
      aiSpend.recordSpend(t, usage, 'extract-refs', { planId, pageIndex, promptVersion: REFS_PROMPT_VERSION }, {
        inputUsdPerToken: COST_PER_INPUT_TOKEN,
        outputUsdPerToken: COST_PER_OUTPUT_TOKEN,
      });
    });
    const json = extractJson(text);
    if (!json || !RefsModelOutput.safeParse(json).success) {
      return res.status(502).json({
        error: 'model returned unusable output — nothing was stored; try again',
      });
    }
    try {
      extraction = await store.insertExtraction(sql, tenantId, {
        jobId, planId, pageIndex,
        pageSha256: page.sha256,
        kind: KIND_REFS,
        model: AI_DRAWINGS_MODEL,
        promptVersion: REFS_PROMPT_VERSION,
        raw: json,
        sheetType: null, sheetTypeConfidence: null,
        sheetNumber: null, sheetNumberConfidence: null,
        sheetTitle: null, sheetTitleConfidence: null,
        revision: null, revisionConfidence: null,
        scale: null, scaleConfidence: null,
        region: null,
        inputTokens: usage ? Number(usage.inputTokens ?? usage.input_tokens ?? 0) : null,
        outputTokens: usage ? Number(usage.outputTokens ?? usage.output_tokens ?? 0) : null,
        createdByLabel: user.username || null,
      });
    } catch (e) {
      const dup = e && (e.code === '23505' || /duplicate key/i.test(String(e.message || '')));
      if (!dup) throw e;
      extraction = await store.findCachedExtraction(sql, tenantId, cacheKey);
      if (!extraction) throw e;
    }
  }

  // Idempotent materialisation — a cached re-click inserts nothing.
  const already = await store.refsForExtraction(sql, tenantId, extraction.id);
  let inserted = [];
  if (already.length === 0) {
    const parsedOut = RefsModelOutput.safeParse(extraction.raw);
    if (!parsedOut.success) {
      return res.status(502).json({ error: 'stored refs run is unreadable — re-run after a prompt bump' });
    }
    inserted = await store.insertSheetRefs(
      sql,
      tenantId,
      {
        jobId, planId, pageIndex,
        pageSha256: page.sha256,
        extractionId: extraction.id,
        createdByLabel: user.username || null,
      },
      parsedOut.data.refs.map((r) => ({
        text: r.text.trim(),
        targetSheetNumber: r.targetSheetNumber.trim(),
        bbox: r.bbox ?? null,
        confidence: r.confidence,
      })),
    );
    if (inserted.length > 0) {
      await appendAuditLog({
        action: 'document.ai_extracted',
        actorId: user.id,
        actorName: user.username || 'Unknown',
        actorRole: user.role || null,
        jobId,
        targetType: 'document',
        targetId: planId,
        summary: `AI found ${inserted.length} cross-sheet reference${inserted.length === 1 ? '' : 's'} on page ${pageIndex + 1}`,
        metadata: { kind: 'sheet-refs', pageIndex, promptVersion: REFS_PROMPT_VERSION },
      }).catch(() => {});
    }
  }

  const sheets = await effectiveSheetNumbers(sql, tenantId, jobId);
  const refs = await store.listSheetRefs(sql, tenantId, jobId);
  const pageRefs = entityLinks
    .resolveRefs(refs, sheets)
    .filter((r) => r.plan_id === planId && r.page_index === pageIndex);
  const fresh = await aiSpend.readTakeoff(jobId);
  return res.status(200).json({
    cached,
    inserted: inserted.length,
    refs: pageRefs.map((r) => sheetRefView(r, r.resolved)),
    spend: { totalUsd: fresh.spend.totalUsd, capUsd: aiSpend.COST_CAP_USD },
  });
}

// Pure scan — exact identifier matches across schedules (#207) and board
// pins (#211). No model call, no spend. Rejections stay rejected.
async function handleProposeLinks(res, sql, tenantId, jobId, user) {
  const [tables, pins, existing] = await Promise.all([
    store.listScheduleTables(sql, tenantId, jobId),
    store.listBoardPins(sql, tenantId, jobId),
    store.listEntityLinks(sql, tenantId, jobId),
  ]);
  const sightings = entityLinks.boardSightings(tables, pins);
  // suppression happens in the pure fn (rejections stay rejected) — count
  // the suppressed pairs so "already known" is honest on re-scans
  const allPairs = entityLinks.proposeBoardLinks(sightings, []);
  const proposals = entityLinks.proposeBoardLinks(sightings, existing);
  const { inserted, skipped } = await store.insertEntityLinks(
    sql, tenantId, jobId, proposals, 'ai', user.username || null,
  );
  const links = await store.listEntityLinks(sql, tenantId, jobId);
  return res.status(200).json({
    proposed: inserted.length,
    alreadyKnown: allPairs.length - proposals.length + skipped,
    sightings: sightings.length,
    links: links.map(entityLinkView),
  });
}

const LINK_TRANSITIONS = {
  proposed: ['confirmed', 'rejected'],
  confirmed: ['rejected'],
  rejected: ['confirmed'],
};

async function handleReviewLink(res, sql, tenantId, jobId, user, body) {
  const parsed = ReviewLinkBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { linkId, status } = parsed.data;
  const link = await store.getEntityLink(sql, tenantId, jobId, linkId);
  if (!link) return res.status(404).json({ error: 'link not found' });
  const allowed = LINK_TRANSITIONS[link.status] || [];
  if (!allowed.includes(status)) {
    return res.status(409).json({ error: `cannot ${status} a ${link.status} link` });
  }
  const updated = await store.reviewEntityLink(sql, tenantId, jobId, link, {
    status,
    reviewedByLabel: user.username || 'Unknown',
  });
  if (!updated) return res.status(409).json({ error: 'link was reviewed concurrently — reload' });
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: link.a_plan_id,
    summary: `${status} the ${updated.identifier} cross-sheet link`,
    metadata: { kind: 'entity-link', linkId, status },
  }).catch(() => {});
  return res.status(200).json({ link: entityLinkView(updated) });
}

async function handleAddLink(res, sql, tenantId, jobId, user, body) {
  const parsed = AddLinkBody.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
  }
  const { kind, identifier, a, b } = parsed.data;
  if (a.planId === b.planId && a.pageIndex === b.pageIndex) {
    return res.status(400).json({ error: 'a link joins two DIFFERENT pages' });
  }
  // canonical ordering keeps the pair unique regardless of input order
  const [first, second] = [a, b].sort((x, y) =>
    entityLinks.pageKeyOf(x.planId, x.pageIndex).localeCompare(entityLinks.pageKeyOf(y.planId, y.pageIndex)),
  );
  const { inserted } = await store.insertEntityLinks(
    sql,
    tenantId,
    jobId,
    [{
      kind,
      identifier: entityLinks.normaliseIdentifier(identifier),
      aPlanId: first.planId,
      aPageIndex: first.pageIndex,
      bPlanId: second.planId,
      bPageIndex: second.pageIndex,
      confidence: null,
      evidence: 'added by ' + (user.username || 'a human'),
    }],
    'human',
    user.username || null,
  );
  if (!inserted.length) {
    return res.status(409).json({ error: 'this pair already has a link — review it instead' });
  }
  await appendAuditLog({
    action: 'document.ai_corrected',
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'document',
    targetId: first.planId,
    summary: `linked ${inserted[0].identifier} across two sheets`,
    metadata: { kind: 'entity-link', linkId: inserted[0].id, status: 'confirmed' },
  }).catch(() => {});
  return res.status(200).json({ link: entityLinkView(inserted[0]) });
}

// ─── Router ─────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (isClientRole(user.role)) return res.status(403).json({ error: 'forbidden' });

  // DARK by default: 404 (not 403) when off, so the surface is invisible.
  // Viewer-aware check → owner preview works before customer rollout.
  if (!(await isFlagEnabled('ai_drawings', user))) {
    return res.status(404).json({ error: 'not found' });
  }

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const action = (req.query && req.query.action) || null;

  // Office review surface: admins any job, leading hands their own.
  if (!canManageJob(user, jobId) && !isAdminRole(user.role)) {
    return res.status(403).json({ error: 'cannot manage this job' });
  }

  if (
    req.method === 'GET' &&
    (action === 'sheets' || action === 'legend' || action === 'schedules' || action === 'diffs' ||
      action === 'detections' || action === 'count-review' || action === 'links')
  ) {
    const sql = dbOr503(res, 'read');
    if (!sql) return;
    const tenantId = await store.resolveTenantId(sql);
    if (action === 'legend') return handleLegendList(res, sql, tenantId, jobId);
    if (action === 'schedules') return handleSchedulesList(res, sql, tenantId, jobId);
    if (action === 'diffs') return handleDiffsList(res, sql, tenantId, jobId);
    if (action === 'detections') return handleDetectionsList(res, sql, tenantId, jobId);
    if (action === 'count-review') return handleCountReviewList(res, sql, tenantId, jobId);
    if (action === 'links') return handleLinksList(res, sql, tenantId, jobId);
    return handleSheets(res, sql, tenantId, jobId);
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const sql = dbOr503(res, 'write');
    if (!sql) return;
    const tenantId = await store.resolveTenantId(sql);
    if (action === 'understand-page') return handleUnderstandPage(res, sql, tenantId, jobId, user, body);
    if (action === 'override') return handleOverride(res, sql, tenantId, jobId, user, body);
    if (action === 'clear-override') return handleClearOverride(res, sql, tenantId, jobId, user, body);
    if (action === 'extract-legend') return handleExtractLegend(res, sql, tenantId, jobId, user, body);
    if (action === 'review-legend-entry') return handleReviewLegendEntry(res, sql, tenantId, jobId, user, body);
    if (action === 'add-legend-entry') return handleAddLegendEntry(res, sql, tenantId, jobId, user, body);
    if (action === 'attach-legend-crop') return handleAttachLegendCrop(res, sql, tenantId, jobId, user, body);
    if (action === 'extract-schedule') return handleExtractSchedule(res, sql, tenantId, jobId, user, body);
    if (action === 'review-schedule-row') return handleReviewScheduleRow(res, sql, tenantId, jobId, user, body);
    if (action === 'diff-pages') return handleDiffPages(res, sql, tenantId, jobId, user, body);
    if (action === 'review-diff-region') return handleReviewDiffRegion(res, sql, tenantId, jobId, user, body);
    if (action === 'detect-devices') return handleDetectDevices(res, sql, tenantId, jobId, user, body);
    if (action === 'review-marker') return handleReviewMarker(res, sql, tenantId, jobId, user, body);
    if (action === 'add-marker') return handleAddMarker(res, sql, tenantId, jobId, user, body);
    if (action === 'accept-count') return handleAcceptCount(res, sql, tenantId, jobId, user, body);
    if (action === 'extract-rooms') return handleExtractRooms(res, sql, tenantId, jobId, user, body);
    if (action === 'review-room') return handleReviewRoom(res, sql, tenantId, jobId, user, body);
    if (action === 'add-room') return handleAddRoom(res, sql, tenantId, jobId, user, body);
    if (action === 'assign-device-room') return handleAssignDeviceRoom(res, sql, tenantId, jobId, user, body);
    if (action === 'clear-device-room') return handleClearDeviceRoom(res, sql, tenantId, jobId, user, body);
    if (action === 'pin-board') return handlePinBoard(res, sql, tenantId, jobId, user, body);
    if (action === 'clear-board-pin') return handleClearBoardPin(res, sql, tenantId, jobId, user, body);
    if (action === 'calibrate-sheet') return handleCalibrateSheet(res, sql, tenantId, jobId, user, body);
    if (action === 'estimate-cable') return handleEstimateCable(res, sql, tenantId, jobId, user, body);
    if (action === 'accept-cable-estimate') return handleAcceptCableEstimate(res, sql, tenantId, jobId, user, body);
    if (action === 'extract-refs') return handleExtractRefs(res, sql, tenantId, jobId, user, body);
    if (action === 'propose-links') return handleProposeLinks(res, sql, tenantId, jobId, user);
    if (action === 'review-link') return handleReviewLink(res, sql, tenantId, jobId, user, body);
    if (action === 'add-link') return handleAddLink(res, sql, tenantId, jobId, user, body);
    return res.status(400).json({ error: 'unknown action: ' + (action || '(none)') });
  }

  return res.status(405).json({ error: 'method not allowed' });
};

// Test-only exports: pure logic that must stay honest (effective merge +
// needs-review derivation + prompt versioning), testable without PG/AI.
module.exports.__test = {
  effectiveSheet,
  extractJson,
  extractionRowFrom,
  cleanValue,
  PROMPT_VERSION,
  REVIEW_THRESHOLD,
  pageUnderstandingPrompt,
  LEGEND_PROMPT_VERSION,
  legendPrompt,
  legendEntryView,
  SCHEDULE_PROMPT_VERSIONS,
  schedulePrompt,
  scheduleRowView,
  normaliseModelTable,
  pageDiffView,
  diffRegionView,
  DETECTION_PROMPT_VERSION,
  detectionPrompt,
  detectionView,
  tileBoxToPage,
  reviewActionView,
  acceptedCountView,
  assembleCountReviewPage,
  ROOMS_PROMPT_VERSION,
  roomsPrompt,
  roomView,
  cableRunStale,
  boardPinView,
  calibrationView,
  REFS_PROMPT_VERSION,
  refsPrompt,
  sheetRefView,
  entityLinkView,
};
