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

  if (req.method === 'GET' && action === 'sheets') {
    const sql = dbOr503(res, 'read');
    if (!sql) return;
    const tenantId = await store.resolveTenantId(sql);
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
};
