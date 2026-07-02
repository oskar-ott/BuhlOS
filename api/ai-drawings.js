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

// Fetch a stored page PNG and return base64 + media type (plans.js pattern).
async function fetchPngAsBase64(url) {
  const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('fetch png failed: ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
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

  if (req.method === 'GET' && (action === 'sheets' || action === 'legend' || action === 'schedules')) {
    const sql = dbOr503(res, 'read');
    if (!sql) return;
    const tenantId = await store.resolveTenantId(sql);
    if (action === 'legend') return handleLegendList(res, sql, tenantId, jobId);
    if (action === 'schedules') return handleSchedulesList(res, sql, tenantId, jobId);
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
};
