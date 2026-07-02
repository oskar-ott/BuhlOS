// Plan-Assisted Job Setup — Phase 9 (vision takeoff added on top of Phase 1).
//
// Job-scoped plan register + AI-assisted material takeoff via Anthropic vision.
//
// Existing (Phase 1) — plan register CRUD:
//   GET    /api/plans?jobId=<id>                      → list plans
//   POST   /api/plans?jobId=<id>                      → upload PDF/image (dataUrl)
//   PATCH  /api/plans?jobId=<id>&id=<planId>          → edit metadata
//                        (#196: areaIds[] + stage link a spec to the
//                         work-tree areas/stage it governs)
//   DELETE /api/plans?jobId=<id>&id=<planId>          → soft-archive
//
// New (Phase 9) — vision takeoff. Client orchestrates the loop because Vercel
// serverless can't run background jobs; each call here is one short Anthropic
// vision call (~10–30s).
//
//   POST   /api/plans?jobId=X&id=Y&action=set-pages
//                        body: { pages: [{ pageIndex, pngDataUrl, sha256 }] }
//                        → Persists rendered page PNGs to Blob, registers
//                          them on the plan record. Run once per plan after
//                          the client has finished PDF.js rendering.
//
//   POST   /api/plans?jobId=X&action=analyse-legend
//                        body: { planId, pageIndex }
//                        → Stage 0. Vision call to extract the legend's
//                          symbol → label table. Persisted at
//                          ai-takeoff.json.legendItems and used as context
//                          for every subsequent count.
//
//   POST   /api/plans?jobId=X&action=analyse-sheet
//                        body: { planId, pageIndex }
//                        → Stages 1+2. Classifies the sheet (sheet number,
//                          dwelling, type) and counts each legend symbol on
//                          this sheet. Persists into ai-takeoff.json keyed
//                          by detected dwelling.
//
//   GET    /api/plans?jobId=X&action=takeoff
//                        → Read full ai-takeoff.json (legend + per-dwelling
//                          suggestions + sheet classifications + spend).
//
//   POST   /api/plans?jobId=X&action=mark-reviewed     body: { dwellingId }
//   POST   /api/plans?jobId=X&action=dismiss-dwelling  body: { dwellingId }
//
//   POST   /api/plans?jobId=X&action=set-dwelling-materials
//                        body: { dwellingId, materials: { code: qty, ... } }
//                        → Writes admin-confirmed counts into
//                          jobs/<jobId>/data.json under
//                          dwellings[dwId].materials. This is the
//                          source-of-truth write; AI suggestions are never
//                          touched by this call.
//
// Single source of truth: dwellings[id].materials in data.json (admin-
// entered). AI suggestions live in ai-takeoff.json and never overwrite.
//
// Cost cap: PLANS_MAX_USD_PER_JOB env var (default $5). When the running
// total of vision calls for this job hits the cap, further analyse-* calls
// return 402 with a clear error message. Resetting the cap is a manual
// edit of ai-takeoff.json or bumping the env var.

const crypto = require('crypto');
const { put } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isAdminRole, isClientRole, isFieldRole, isLeadingHandRole } = require('./_lib/auth');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { sendPushToUserId } = require('./_lib/push');

const VALID_STATUSES = ['current', 'superseded', 'archived'];
// #194: closed discipline set for DRAWING-type rows. Additive — legacy rows
// without one group honestly under "other" in the UI. DOCUMENT_CATEGORIES
// (plan/spec/…) is a different axis and stays untouched.
const VALID_DISCIPLINES = ['architectural', 'electrical', 'services', 'structural', 'other'];
// #196: the two work-tree stages a spec link may name. Mirrors
// api/evidence.js VALID_STAGES + src/domains/documents DOCUMENT_STAGES.
const VALID_STAGES = ['roughIn', 'fitOff'];
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap on uploads
const VISION_MODEL = process.env.PLANS_AI_MODEL || 'claude-sonnet-4-5';
const COST_CAP_USD = Number(process.env.PLANS_MAX_USD_PER_JOB || '5');
// Sonnet 4.5 published rates as of writing. Override via env if they shift.
const COST_PER_INPUT_TOKEN  = Number(process.env.PLANS_AI_INPUT_USD_PER_MTOK  || '3')  / 1_000_000;
const COST_PER_OUTPUT_TOKEN = Number(process.env.PLANS_AI_OUTPUT_USD_PER_MTOK || '15') / 1_000_000;

function newId() {
  return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function extFor(mime) {
  if (!mime) return 'bin';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic') return 'heic';
  return 'bin';
}

function isAllowedMime(mime) {
  return mime === 'application/pdf' ||
         (typeof mime === 'string' && mime.startsWith('image/'));
}

async function readIndex(jobId) {
  return await readBlob('jobs/' + jobId + '/plans-index.json', { plans: [] });
}
async function writeIndex(jobId, data) {
  await writeBlob('jobs/' + jobId + '/plans-index.json', data);
}

// #196: resolve an area on a job's work tree. Same shape as the findArea
// pattern in api/evidence.js — a spec link's areaId must resolve to a real
// area before we persist it (no dangling links written by the server; a
// link can only go stale later if the area is removed, which the read
// surfaces label honestly). Returns the area object or null.
function findArea(job, areaId) {
  for (const g of (job && job.areaGroups) || []) {
    for (const a of (g && g.areas) || []) {
      if (a && a.id === areaId) return a;
    }
  }
  return null;
}

// #510 spend primitives — extracted to api/_lib/ai-spend.js so the Epic 5
// ai-drawings surface (api/ai-drawings.js) shares ONE per-job ledger + cap.
// The local names (and the module.exports.__test signatures) stay identical.
const aiSpend = require('./_lib/ai-spend');
const readTakeoff = aiSpend.readTakeoff;
const writeTakeoff = aiSpend.writeTakeoff;
const commitTakeoff = aiSpend.commitTakeoff;

// ─── Vision call helpers ──────────────────────────────────────────────────

// Lazy-load the Anthropic SDK so the rest of this file still parses if the
// dep isn't installed yet (eg. on a fresh checkout before npm install).
let _anthropic = null;
function anthropic() {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set in Vercel env vars');
    }
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// Best-effort JSON extraction from a model reply. Models often wrap JSON in
// ```json fences; strip them if present, then parse. If parse fails, return
// the raw text under {_raw: ...} so the admin can debug.
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(candidate); } catch {}
  // Try to find the outermost {...} block
  const first = candidate.indexOf('{');
  const last  = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch {}
  }
  return { _raw: text };
}

// Fetch a PNG by URL and return base64 + media type.
async function fetchPngAsBase64(url) {
  const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('fetch png failed: ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return { base64: buf.toString('base64'), mediaType: 'image/png' };
}

// Spend recording at THIS surface's env-configured rates; the ledger + CAS
// live in _lib/ai-spend.js. Signature unchanged (test-pinned via __test).
function recordSpend(takeoff, usage, kind, meta) {
  aiSpend.recordSpend(takeoff, usage, kind, meta, {
    inputUsdPerToken: COST_PER_INPUT_TOKEN,
    outputUsdPerToken: COST_PER_OUTPUT_TOKEN,
  });
}

function overBudget(takeoff) {
  return aiSpend.overBudget(takeoff, COST_CAP_USD);
}

// ─── Prompts ──────────────────────────────────────────────────────────────

const LEGEND_PROMPT = `You are inspecting an Australian residential electrical plan sheet to extract the LEGEND.

A legend is a key/table on the sheet showing each electrical symbol and its label (eg. "single GPO", "double GPO", "downlight", "exhaust fan", "data outlet", etc.). It usually appears in a corner or as a dedicated sheet.

Return strict JSON in this exact shape:
{
  "isLegend": true | false,
  "items": [
    {
      "code":     "<short stable code, e.g. 'gpoSingle' | 'gpoDouble' | 'downlight' | 'twoWaySwitch' | 'dataCat6'>",
      "symbol":   "<terse description of the visual symbol, e.g. 'circle with single line'>",
      "label":    "<the legend's own text label>",
      "category": "Power | Lighting | Switch | Data | Comms | Safety | Mechanical | EV | Appliance | Other"
    }
  ],
  "notes": "<any caveats — partial legend, unreadable rows, extra symbols not in this taxonomy>"
}

Use Australian residential electrical terminology (GPO not "outlet", light point not "fixture", isolator not "disconnect"). If the sheet has no legend, return { "isLegend": false, "items": [], "notes": "..." }. Output JSON only — no commentary.`;

function classifyAndCountPrompt(legendItems) {
  const legendList = (legendItems || []).map(i =>
    `  ${i.code}: ${i.label}${i.symbol ? ' (' + i.symbol + ')' : ''}`
  ).join('\n');
  return `You are inspecting an Australian residential electrical plan sheet. Two tasks:

1. CLASSIFY THE SHEET. Identify:
   - sheetNumber (e.g. "E101", "E-2-04")
   - sheetTitle (the sheet's title block name)
   - dwelling — the dwelling/area this sheet belongs to (e.g. "Unit 07", "Townhouse 03"). If the sheet covers multiple dwellings, return an array. If it is a legend, cover, site services, or other shared sheet, return null.
   - sheetType — one of: "lighting", "power", "data", "combined", "legend", "cover", "shared-services", "other"

2. COUNT SYMBOLS. Using the legend below as the spine, count each symbol that appears on this sheet. ONLY count symbols that are in the legend — never invent categories.

LEGEND:
${legendList || '  (no legend items provided)'}

Return strict JSON in this exact shape:
{
  "classification": {
    "sheetNumber":  "...",
    "sheetTitle":   "...",
    "dwelling":     "Unit 07" | ["Unit 07","Unit 08"] | null,
    "sheetType":    "lighting" | "power" | "data" | "combined" | "legend" | "cover" | "shared-services" | "other",
    "confidence":   "high" | "medium" | "low",
    "rationale":    "<one short sentence>"
  },
  "counts": {
    "<code>": <integer>
  },
  "confidence": {
    "<code>": "clear" | "partial" | "missing"
  },
  "notes": "<caveats — partial sheet visible, legend symbol not seen on this sheet, unclear hatching, etc.>"
}

Confidence flags:
- "clear":   counted with high confidence
- "partial": some symbols may be missed (cropped sheet, dense overlap, faded print)
- "missing": this legend symbol wasn't found on the sheet (count = 0 with high confidence)

Output JSON only — no commentary.`;
}

// ─── Action handlers ──────────────────────────────────────────────────────

async function handleSetPages(req, res, jobId, planId, body) {
  if (!Array.isArray(body.pages) || !body.pages.length) {
    return res.status(400).json({ error: 'pages array required' });
  }
  const data = await readIndex(jobId);
  const idx = (data.plans || []).findIndex(p => p.id === planId);
  if (idx < 0) return res.status(404).json({ error: 'plan not found' });

  // Persist each page PNG to Blob and remember its URL + sha256.
  const persisted = [];
  for (const page of body.pages) {
    if (typeof page.pageIndex !== 'number') continue;
    if (!page.pngDataUrl || typeof page.pngDataUrl !== 'string') continue;
    const base64 = page.pngDataUrl.split(',')[1];
    if (!base64) continue;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_BYTES) {
      return res.status(400).json({ error: 'page ' + page.pageIndex + ' too large' });
    }
    const sha256 = page.sha256 || crypto.createHash('sha256').update(buf).digest('hex');
    const blobPath = 'jobs/' + jobId + '/plans/' + planId + '.page-' + page.pageIndex + '.png';
    const uploaded = await put(blobPath, buf, {
      access: 'public', contentType: 'image/png',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    persisted.push({ pageIndex: page.pageIndex, pngUrl: uploaded.url, sha256, sizeBytes: buf.length });
  }

  // Upsert by pageIndex so the client can stream pages one at a time
  // without losing earlier ones. Replaces existing entries on re-render.
  const existing = data.plans[idx].pages || [];
  const byIdx = {};
  for (const p of existing) byIdx[p.pageIndex] = p;
  for (const p of persisted) byIdx[p.pageIndex] = p;
  data.plans[idx].pages = Object.values(byIdx).sort((a, b) => a.pageIndex - b.pageIndex);
  data.plans[idx].pagesAt = new Date().toISOString();
  await writeIndex(jobId, data);
  return res.status(200).json({ plan: data.plans[idx] });
}

async function handleAnalyseLegend(req, res, jobId, body) {
  const planId = body.planId;
  const pageIndex = Number(body.pageIndex);
  if (!planId || !Number.isFinite(pageIndex)) {
    return res.status(400).json({ error: 'planId + pageIndex required' });
  }
  const index = await readIndex(jobId);
  const plan = (index.plans || []).find(p => p.id === planId);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const page = (plan.pages || []).find(p => p.pageIndex === pageIndex);
  if (!page) return res.status(404).json({ error: 'page not registered — run set-pages first' });

  const takeoff = await readTakeoff(jobId);
  if (overBudget(takeoff)) {
    return res.status(402).json({ error: 'cost cap reached for this job ($' + COST_CAP_USD + ')', spend: takeoff.spend });
  }

  // Cache check — same page (sha256) + 'legend' stage = served from cache.
  const cacheKey = page.sha256 + ':legend';
  const cached = takeoff.sheetCache[cacheKey];
  if (cached) {
    return res.status(200).json({ legend: cached.result, cached: true });
  }

  const { base64, mediaType } = await fetchPngAsBase64(page.pngUrl);
  let result, usage;
  try {
    const msg = await anthropic().messages.create({
      model: VISION_MODEL,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: LEGEND_PROMPT },
        ],
      }],
    });
    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    result = extractJson(text);
    usage = msg.usage;
  } catch (e) {
    return res.status(502).json({ error: 'vision call failed: ' + e.message });
  }

  const out = await commitTakeoff(jobId, (t) => {
    recordSpend(t, usage, 'analyse-legend', { planId, pageIndex });
    t.sheetCache[cacheKey] = { stage: 'legend', result };
    if (result && result.isLegend && Array.isArray(result.items) && result.items.length) {
      t.legendVersion = (t.legendVersion || 0) + 1;
      t.legendItems = result.items;
      t.legendSource = { planId, pageIndex };
    }
    return { legend: result, cached: false, spend: t.spend };
  });
  return res.status(200).json(out);
}

async function handleAnalyseSheet(req, res, jobId, body) {
  const planId = body.planId;
  const pageIndex = Number(body.pageIndex);
  if (!planId || !Number.isFinite(pageIndex)) {
    return res.status(400).json({ error: 'planId + pageIndex required' });
  }
  const index = await readIndex(jobId);
  const plan = (index.plans || []).find(p => p.id === planId);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const page = (plan.pages || []).find(p => p.pageIndex === pageIndex);
  if (!page) return res.status(404).json({ error: 'page not registered' });

  const takeoff = await readTakeoff(jobId);
  if (overBudget(takeoff)) {
    return res.status(402).json({ error: 'cost cap reached for this job ($' + COST_CAP_USD + ')', spend: takeoff.spend });
  }
  if (!takeoff.legendItems || !takeoff.legendItems.length) {
    return res.status(400).json({ error: 'no legend extracted yet — run analyse-legend on the legend sheet first' });
  }

  // Cache key includes legend version so a re-extracted legend invalidates
  // stale per-sheet counts.
  const cacheKey = page.sha256 + ':sheet:lv' + takeoff.legendVersion;
  const cached = takeoff.sheetCache[cacheKey];
  if (cached) {
    const out = await commitTakeoff(jobId, (t) => {
      applyClassificationAndCounts(t, planId, pageIndex, cached.result, true);
      return { result: cached.result, cached: true };
    });
    return res.status(200).json(out);
  }

  const { base64, mediaType } = await fetchPngAsBase64(page.pngUrl);
  let result, usage;
  try {
    const msg = await anthropic().messages.create({
      model: VISION_MODEL,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: classifyAndCountPrompt(takeoff.legendItems) },
        ],
      }],
    });
    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    result = extractJson(text);
    usage = msg.usage;
  } catch (e) {
    return res.status(502).json({ error: 'vision call failed: ' + e.message });
  }

  const out = await commitTakeoff(jobId, (t) => {
    recordSpend(t, usage, 'analyse-sheet', { planId, pageIndex });
    t.sheetCache[cacheKey] = { stage: 'sheet', result };
    applyClassificationAndCounts(t, planId, pageIndex, result, false);
    return { result, cached: false, spend: t.spend };
  });
  return res.status(200).json(out);
}

// Apply the classification + counts from a single sheet's vision result into
// the takeoff store. A sheet that maps to a single dwelling adds its counts
// to that dwelling's suggestions; multi-dwelling sheets fan out the counts
// to each named dwelling. Shared/legend/cover sheets only land in the
// classification map (no counts).
function applyClassificationAndCounts(takeoff, planId, pageIndex, result, fromCache) {
  if (!result) return;
  const key = planId + ':' + pageIndex;
  const cls = result.classification || {};
  takeoff.sheetClassifications[key] = {
    sheetNumber: cls.sheetNumber || '',
    sheetTitle: cls.sheetTitle || '',
    dwelling: cls.dwelling || null,
    sheetType: cls.sheetType || 'other',
    confidence: cls.confidence || 'medium',
    rationale: cls.rationale || '',
    fromCache: !!fromCache,
  };

  const dwellings = Array.isArray(cls.dwelling) ? cls.dwelling : (cls.dwelling ? [cls.dwelling] : []);
  if (!dwellings.length) return; // shared/legend/cover — no per-dwelling counts
  const counts = result.counts || {};
  const conf = result.confidence || {};
  const now = new Date().toISOString();

  for (const dwName of dwellings) {
    const dwId = String(dwName).trim();
    if (!dwId) continue;
    if (!takeoff.dwellings[dwId]) {
      takeoff.dwellings[dwId] = {
        suggestions: {}, confidence: {}, sheetIds: [],
        status: 'pending', model: VISION_MODEL, suggestedAt: now,
      };
    }
    const dw = takeoff.dwellings[dwId];
    // Sum counts across all sheets contributing to this dwelling.
    for (const [code, qty] of Object.entries(counts)) {
      const n = Number(qty) || 0;
      dw.suggestions[code] = (dw.suggestions[code] || 0) + n;
    }
    // Confidence: keep the worst-case across contributing sheets (worst wins).
    const rank = { clear: 0, partial: 1, missing: 2 };
    for (const [code, c] of Object.entries(conf)) {
      const prev = dw.confidence[code];
      if (!prev || (rank[c] || 0) > (rank[prev] || 0)) dw.confidence[code] = c;
    }
    // Track contributing sheets, dedup by planId+pageIndex.
    if (!dw.sheetIds.find(s => s.planId === planId && s.pageIndex === pageIndex)) {
      dw.sheetIds.push({ planId, pageIndex });
    }
    dw.suggestedAt = now;
    dw.model = VISION_MODEL;
  }
}

async function handleSetDwellingMaterials(req, res, jobId, body) {
  const dwellingId = body.dwellingId;
  if (!dwellingId) return res.status(400).json({ error: 'dwellingId required' });
  if (!body.materials || typeof body.materials !== 'object') {
    return res.status(400).json({ error: 'materials object required' });
  }
  // Normalise: only positive integers, drop empties.
  const clean = {};
  for (const [k, v] of Object.entries(body.materials)) {
    const n = Math.max(0, Math.floor(Number(v) || 0));
    if (n > 0) clean[k] = n;
  }

  const KEY = 'jobs/' + jobId + '/data.json';
  const data = await readBlob(KEY, { dwellings: {}, snags: [], notes: [] });
  data.dwellings = data.dwellings || {};
  data.dwellings[dwellingId] = data.dwellings[dwellingId] || {};
  data.dwellings[dwellingId].materials = clean;
  data.dwellings[dwellingId].materialsUpdatedAt = new Date().toISOString();
  await writeBlob(KEY, data);
  return res.status(200).json({ dwelling: data.dwellings[dwellingId] });
}

// ─── Router ───────────────────────────────────────────────────────────────

// #194: ONE current revision max per drawing number. Demotes every OTHER
// current row sharing `plan.drawingNumber` to superseded, maintains the
// supersedes/supersededBy pointers both ways, and returns the demoted ids
// (for audit rows). No-op when the plan has no drawing number.
function enforceSingleCurrent(data, plan) {
  if (!plan.drawingNumber || plan.status !== 'current') return [];
  const demoted = [];
  for (const p of data.plans) {
    if (p.id === plan.id) continue;
    if (p.drawingNumber === plan.drawingNumber && p.status === 'current') {
      p.status = 'superseded';
      p.supersededBy = plan.id;
      p.updatedAt = new Date().toISOString();
      if (!plan.supersedes) plan.supersedes = p.id;
      demoted.push(p.id);
    }
  }
  return demoted;
}

// #299: per-job revision acknowledgements — jobs/<jobId>/plan-acks.json
// { acks: [{ planId, userId, userName, ackAt }] }. The ack — not push
// delivery — is the only "seen" claim the register ever makes.
function acksKey(jobId) {
  return 'jobs/' + jobId + '/plan-acks.json';
}
async function readAcks(jobId) {
  const data = await readBlob(acksKey(jobId), { acks: [] });
  return Array.isArray(data.acks) ? data : { acks: [] };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (isClientRole(user.role)) return res.status(403).json({ error: 'forbidden' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const action = (req.query && req.query.action) || null;

  // ── GET ────────────────────────────────────────────────
  if (req.method === 'GET') {
    // #299: per-revision acknowledgement rollup — who's seen it, who's
    // outstanding. Audience = CURRENT field-tier assignment (a worker
    // assigned after issue shows outstanding; an unassigned one drops out).
    if (action === 'acks') {
      if (!isAdminRole(user.role) && !canManageJob(user, jobId)) {
        return res.status(403).json({ error: 'admin / LH only' });
      }
      const planId = req.query && req.query.planId;
      if (!planId) return res.status(400).json({ error: 'planId required' });
      const [ackData, usersBlob] = await Promise.all([
        readAcks(jobId),
        readBlob('users.json', { users: [] }),
      ]);
      const ackByUser = {};
      for (const ack of ackData.acks) {
        if (ack.planId === planId) ackByUser[ack.userId] = ack;
      }
      const acked = [];
      const outstanding = [];
      for (const u of usersBlob.users || []) {
        if (!Array.isArray(u.assignedJobIds) || !u.assignedJobIds.includes(jobId)) continue;
        if (u.archived || u.disabled || u.status === 'disabled') continue;
        if (!isFieldRole(u.role) && !isLeadingHandRole(u.role)) continue;
        const ack = ackByUser[u.id];
        if (ack) acked.push({ userId: u.id, userName: u.username || u.id, ackAt: ack.ackAt });
        else outstanding.push({ userId: u.id, userName: u.username || u.id });
      }
      return res.status(200).json({ acked, outstanding });
    }

    // #299: the viewer's own acks on this job — lets Phil render "Seen ✓"
    // without exposing anyone else's state.
    if (action === 'my-acks') {
      const isCrew = (user.assignedJobIds || []).includes(jobId);
      if (!isAdminRole(user.role) && !canManageJob(user, jobId) && !isCrew) {
        return res.status(403).json({ error: 'no access to this job' });
      }
      const ackData = await readAcks(jobId);
      return res.status(200).json({
        planIds: ackData.acks.filter(a => a.userId === user.id).map(a => a.planId),
      });
    }

    if (action === 'takeoff') {
      if (!isAdminRole(user.role) && !canManageJob(user, jobId)) {
        return res.status(403).json({ error: 'admin / LH only' });
      }
      const takeoff = await readTakeoff(jobId);
      return res.status(200).json(takeoff);
    }
    // Plain list (existing behaviour).
    const isCrew = (user.assignedJobIds || []).includes(jobId);
    if (!isAdminRole(user.role) && !canManageJob(user, jobId) && !isCrew) {
      return res.status(403).json({ error: 'no access to this job' });
    }
    const data = await readIndex(jobId);
    const includeArchived = req.query && req.query.includeArchived === '1';
    let plans = data.plans || [];
    if (!includeArchived && !isAdminRole(user.role)) {
      plans = plans.filter(p => p.status !== 'archived');
    }
    return res.status(200).json({ plans });
  }

  // #299: worker acknowledges a revision — the one FIELD write on this
  // endpoint, so it sits ABOVE the manage-gate. Self-only (session is the
  // identity — #112 attribution discipline), assigned crew only, idempotent.
  if (req.method === 'POST' && action === 'ack') {
    const body = req.body || {};
    const planId = body.planId;
    if (!planId) return res.status(400).json({ error: 'planId required' });
    const isCrew = (user.assignedJobIds || []).includes(jobId);
    if (!isCrew && !isAdminRole(user.role) && !canManageJob(user, jobId)) {
      return res.status(403).json({ error: 'not assigned to this job' });
    }
    const data = await readIndex(jobId);
    const plan = (data.plans || []).find(p => p.id === planId);
    if (!plan) return res.status(404).json({ error: 'plan not found' });
    const ackData = await readAcks(jobId);
    const existing = ackData.acks.find(a => a.planId === planId && a.userId === user.id);
    if (existing) return res.status(200).json({ ack: existing, already: true });
    const ack = {
      planId,
      userId: user.id,
      userName: user.username || user.id,
      ackAt: new Date().toISOString(),
    };
    ackData.acks.push(ack);
    await writeBlob(acksKey(jobId), ackData);
    await appendAuditLog({
      action: 'document.acknowledged',
      actorId: user.id,
      actorName: user.username || 'Unknown',
      actorRole: user.role || null,
      jobId,
      targetType: 'document',
      targetId: planId,
      summary: `acknowledged "${(plan.title || plan.fileName || plan.id).slice(0, 80)}"${plan.revision ? ' rev ' + plan.revision : ''}`,
      metadata: { revision: plan.revision || null, drawingNumber: plan.drawingNumber || null },
    }).catch(() => {});
    return res.status(201).json({ ack });
  }

  // All mutations require management of the job.
  if (!canManageJob(user, jobId) && !isAdminRole(user.role)) {
    return res.status(403).json({ error: 'cannot manage this job' });
  }

  // ── Action-based POSTs (Phase 9 vision endpoints) ──────
  if (req.method === 'POST' && action) {
    const body = req.body || {};
    if (action === 'set-pages') {
      const planId = (req.query && req.query.id) || body.planId;
      if (!planId) return res.status(400).json({ error: 'plan id required' });
      return handleSetPages(req, res, jobId, planId, body);
    }
    if (action === 'analyse-legend')  return handleAnalyseLegend(req, res, jobId, body);
    if (action === 'analyse-sheet')   return handleAnalyseSheet(req, res, jobId, body);
    if (action === 'set-dwelling-materials') return handleSetDwellingMaterials(req, res, jobId, body);

    if (action === 'mark-reviewed' || action === 'dismiss-dwelling') {
      const dwId = body.dwellingId;
      if (!dwId) return res.status(400).json({ error: 'dwellingId required' });
      const takeoff = await readTakeoff(jobId);
      const dw = takeoff.dwellings[dwId];
      if (!dw) return res.status(404).json({ error: 'no AI suggestions for this dwelling' });
      dw.status = action === 'mark-reviewed' ? 'reviewed' : 'dismissed';
      dw.reviewedAt = new Date().toISOString();
      dw.reviewedBy = user.username;
      await writeTakeoff(jobId, takeoff);
      return res.status(200).json({ dwelling: dw });
    }
    return res.status(400).json({ error: 'unknown action: ' + action });
  }

  // ── POST (existing upload behaviour) ───────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.dataUrl || typeof body.dataUrl !== 'string') {
      return res.status(400).json({ error: 'dataUrl required' });
    }
    const mime = body.mimeType ||
                 ((body.dataUrl.match(/^data:([^;]+);/) || [])[1]) ||
                 'application/octet-stream';
    if (!isAllowedMime(mime)) {
      return res.status(400).json({ error: 'unsupported file type (PDF or image only)' });
    }
    const base64 = String(body.dataUrl).split(',')[1];
    if (!base64) return res.status(400).json({ error: 'invalid dataUrl' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_BYTES) {
      return res.status(400).json({ error: 'file too large (max 25 MB)' });
    }

    const id = newId();
    const ext = extFor(mime);
    const blobPath = 'jobs/' + jobId + '/plans/' + id + '.' + ext;
    const uploaded = await put(blobPath, buf, {
      access: 'public',
      contentType: mime,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const now = new Date().toISOString();
    const plan = {
      id, jobId,
      fileName:      body.fileName ? String(body.fileName).slice(0, 200) : (id + '.' + ext),
      blobPath,
      url:           uploaded.url,
      mimeType:      mime,
      sizeBytes:     buf.length,
      drawingNumber: body.drawingNumber ? String(body.drawingNumber).trim() : '',
      discipline: VALID_DISCIPLINES.includes(body.discipline) ? body.discipline : '',
      revision:      body.revision ? String(body.revision).trim() : '',
      title:         body.title ? String(body.title).trim() : '',
      level:         body.level ? String(body.level).trim() : '',
      category:      body.category ? String(body.category).trim() : '',
      status:        'current',
      notes:         body.notes ? String(body.notes).trim() : '',
      // Rigidity audit R9 — explicit revision lineage. `supersedes` points
      // at the previous revision's plan id. Caller can pass it on POST;
      // we'll also auto-detect by drawingNumber if not provided. The back-
      // reference (`supersededBy`) is set on the older plan below.
      supersedes:    body.supersedes ? String(body.supersedes).trim() : '',
      supersededBy:  '',
      // #299: what changed in this revision — free text v1, shown in admin
      // and Phil; #203's auto-diff replaces it later.
      changeSummary: body.changeSummary ? String(body.changeSummary).trim().slice(0, 500) : '',
      uploadedAt:    now,
      uploadedBy:    user.username,
      uploadedByUserId: user.id,
    };

    const data = await readIndex(jobId);
    data.plans = data.plans || [];

    // #299: explicit one-step revision. `revisesPlanId` names the predecessor
    // — no string matching — and the upload INHERITS its identity fields
    // wherever the caller left them blank, so "new revision" never re-types
    // (or mistypes) the drawing number. A bad id is a hard 400: explicit
    // intent must not silently degrade into a fresh unrelated drawing.
    if (body.revisesPlanId) {
      const prev = data.plans.find(p => p.id === String(body.revisesPlanId).trim());
      if (!prev) return res.status(400).json({ error: 'revisesPlanId does not match a plan on this job' });
      plan.supersedes = prev.id;
      if (!plan.drawingNumber) plan.drawingNumber = prev.drawingNumber || '';
      if (!plan.discipline) plan.discipline = prev.discipline || '';
      if (!plan.title) plan.title = prev.title || '';
      if (!plan.level) plan.level = prev.level || '';
      if (!plan.category) plan.category = prev.category || '';
    }

    let revisionWarning = null;
    if (plan.drawingNumber) {
      const dupe = data.plans.find(p =>
        p.drawingNumber && p.drawingNumber === plan.drawingNumber && p.status === 'current'
      );
      if (dupe) {
        // #194 defect (d): by the time this string reaches the client the
        // supersede below has already run — say what HAPPENED, don't ask.
        revisionWarning = 'This drawing number already had a current revision — it is now marked superseded by this upload.';
        // Auto-fill `supersedes` if the caller didn't provide one — the
        // current plan on this drawing number is the obvious target. This
        // makes "upload a new revision" Just Work without admin extra step.
        if (!plan.supersedes) plan.supersedes = dupe.id;
      }
    }

    // If we have a supersedes link, set the back-pointer on the older
    // plan and flip its status. Validation: the target must be a plan on
    // this job; otherwise we drop the link silently (don't fail the
    // upload — the file is already saved).
    if (plan.supersedes) {
      const target = data.plans.find(p => p.id === plan.supersedes);
      if (target) {
        target.supersededBy = plan.id;
        target.status = 'superseded';
        target.updatedAt = now;
      } else {
        plan.supersedes = ''; // bad reference — clear it
      }
    }

    data.plans.push(plan);
    // #194 hardening (c): an explicit body.supersedes pointing at a DIFFERENT
    // row used to leave a second same-number current standing. One current
    // max per drawing number — demote any other current and keep lineage.
    const demoted = enforceSingleCurrent(data, plan);
    await writeIndex(jobId, data);
    await appendAuditLog({
      action: 'document.uploaded',
      actorId: user.id,
      actorName: user.username || 'Unknown',
      actorRole: user.role || null,
      jobId,
      targetType: 'document',
      targetId: plan.id,
      summary: `uploaded "${(plan.title || plan.fileName || plan.id).slice(0, 80)}"`,
      metadata: { drawingNumber: plan.drawingNumber || null, revision: plan.revision || null },
    }).catch(() => {});
    for (const d of demoted.concat(plan.supersedes ? [plan.supersedes] : [])) {
      await appendAuditLog({
        action: 'document.superseded',
        actorId: user.id,
        actorName: user.username || 'Unknown',
        actorRole: user.role || null,
        jobId,
        targetType: 'document',
        targetId: d,
        summary: `superseded by "${(plan.title || plan.fileName || plan.id).slice(0, 80)}"`,
        metadata: { supersededBy: plan.id },
      }).catch(() => {});
    }
    // #299: a real revision (it superseded something) reaches the field —
    // push every live assigned field-tier worker, deep-linked to the job's
    // plans page. Best-effort: push failures never fail the upload, and the
    // ack list — not delivery — is the only "seen" claim. First upload of a
    // drawing supersedes nothing → no notification storm.
    let notified = 0;
    if (plan.supersedes) {
      try {
        const usersBlob = await readBlob('users.json', { users: [] });
        const name = plan.drawingNumber || plan.title || plan.fileName;
        const title = 'New revision — ' + name + (plan.revision ? ' Rev ' + plan.revision : '');
        const pushBody = (plan.changeSummary || 'Tap to see the current sheet.') +
          ' Open Plans and acknowledge it.';
        for (const u of usersBlob.users || []) {
          if (!Array.isArray(u.assignedJobIds) || !u.assignedJobIds.includes(jobId)) continue;
          if (u.archived || u.disabled || u.status === 'disabled') continue;
          if (!isFieldRole(u.role) && !isLeadingHandRole(u.role)) continue;
          if (!u.pushSubscriptions || !u.pushSubscriptions.length) continue;
          try {
            const r = await sendPushToUserId(u.id, {
              title,
              body: pushBody,
              url: '/phil/jobs/' + jobId + '/plans',
              tag: 'buhl-plan-revision',
            });
            notified += (r && r.sent) || 0;
          } catch {}
        }
      } catch {}
    }
    return res.status(201).json({ plan, revisionWarning, notified });
  }

  // ── PATCH (existing metadata edit) ─────────────────────
  if (req.method === 'PATCH') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};
    const data = await readIndex(jobId);
    const idx = (data.plans || []).findIndex(p => p.id === id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });

    const editable = ['drawingNumber', 'revision', 'title', 'level', 'category', 'notes', 'supersedes'];
    for (const k of editable) {
      if (body[k] !== undefined) data.plans[idx][k] = String(body[k] || '').trim();
    }
    if (body.discipline !== undefined) {
      const d = String(body.discipline || '').trim();
      if (d && !VALID_DISCIPLINES.includes(d)) {
        return res.status(400).json({ error: 'discipline must be one of: ' + VALID_DISCIPLINES.join(', ') });
      }
      data.plans[idx].discipline = d;
    }
    // Maintain the back-reference symmetry: if admin set `supersedes`,
    // bidirectionally link the older plan and flip its status. Reset the
    // back-pointer on any previously-linked plan (admin can re-target).
    if (body.supersedes !== undefined) {
      const newTarget = String(body.supersedes || '').trim();
      // Clear any old reverse-link that pointed at THIS plan from a
      // previous supersession setup.
      for (const p of data.plans) {
        if (p.id !== data.plans[idx].id && p.supersededBy === data.plans[idx].id && p.id !== newTarget) {
          p.supersededBy = '';
          // Don't auto-flip status back to current — admin may have
          // intentionally archived the older plan. Just clear the link.
        }
      }
      if (newTarget) {
        const target = data.plans.find(p => p.id === newTarget);
        if (target) {
          target.supersededBy = data.plans[idx].id;
          target.status = 'superseded';
          target.updatedAt = new Date().toISOString();
        }
      }
    }
    // #196: spec → work-tree linkage. `areaIds` is the full set on each
    // PATCH (PUT-replace; [] clears the link). Every id must resolve to a
    // real area on the job's work tree — a bad id is a hard 400 so the
    // server never persists a dangling link (a link can only go stale
    // later if the area is removed; the read surfaces label that honestly,
    // P7). Area names are denormalised into `areaLinks` at link time so the
    // chips/Phil block don't re-join the job tree per render. `stage` is
    // optional and validated against the closed set; null/'' clears it.
    //
    // This REPLACES the write-only `linkedAreaGroups` block (#194 left it
    // with zero readers repo-wide). Migrating to the area-id model keeps
    // one vocabulary for "what does this document govern".
    if (Array.isArray(body.areaIds)) {
      const ids = body.areaIds
        .filter((x) => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean);
      const uniqueIds = [...new Set(ids)];
      const areaLinks = [];
      if (uniqueIds.length > 0) {
        const jobsBlob = await readBlob('jobs.json', null);
        if (!jobsBlob || !Array.isArray(jobsBlob.jobs)) {
          return res.status(500).json({ error: 'jobs storage unavailable' });
        }
        const job = jobsBlob.jobs.find((j) => j && j.id === jobId);
        if (!job) return res.status(404).json({ error: 'job not found' });
        for (const areaId of uniqueIds) {
          const area = findArea(job, areaId);
          if (!area) {
            return res.status(400).json({ error: 'areaId not found on job: ' + areaId });
          }
          areaLinks.push({ areaId, areaName: String(area.name || '').trim() });
        }
      }
      data.plans[idx].areaIds = uniqueIds;
      data.plans[idx].areaLinks = areaLinks;
    }
    if (body.stage !== undefined) {
      const s = String(body.stage || '').trim();
      if (s && !VALID_STAGES.includes(s)) {
        return res.status(400).json({ error: 'stage must be one of: ' + VALID_STAGES.join(', ') });
      }
      data.plans[idx].stage = s;
    }
    let madeCurrent = false;
    if (body.status && VALID_STATUSES.includes(body.status)) {
      data.plans[idx].status = body.status;
      madeCurrent = body.status === 'current';
      if (madeCurrent) {
        // #194 hardening (a): becoming current again means nothing
        // supersedes this row any more — keep lineage in step with status.
        data.plans[idx].supersededBy = '';
      }
    }
    // #194 hardening (a)+(b): one current max per drawing number, with
    // lineage pointers maintained — runs after BOTH a status flip and a
    // drawingNumber edit (editing a number onto an existing current used
    // to leave two currents standing).
    const demoted = data.plans[idx].status === 'current'
      ? enforceSingleCurrent(data, data.plans[idx])
      : [];
    data.plans[idx].updatedAt = new Date().toISOString();
    await writeIndex(jobId, data);
    if (madeCurrent) {
      await appendAuditLog({
        action: 'document.made_current',
        actorId: user.id,
        actorName: user.username || 'Unknown',
        actorRole: user.role || null,
        jobId,
        targetType: 'document',
        targetId: data.plans[idx].id,
        summary: `marked "${(data.plans[idx].title || data.plans[idx].fileName || id).slice(0, 80)}" current`,
        metadata: { drawingNumber: data.plans[idx].drawingNumber || null },
      }).catch(() => {});
    }
    for (const d of demoted) {
      await appendAuditLog({
        action: 'document.superseded',
        actorId: user.id,
        actorName: user.username || 'Unknown',
        actorRole: user.role || null,
        jobId,
        targetType: 'document',
        targetId: d,
        summary: `superseded by "${(data.plans[idx].title || data.plans[idx].fileName || id).slice(0, 80)}"`,
        metadata: { supersededBy: data.plans[idx].id },
      }).catch(() => {});
    }
    return res.status(200).json({ plan: data.plans[idx] });
  }

  // ── DELETE (existing soft-archive) ─────────────────────
  if (req.method === 'DELETE') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readIndex(jobId);
    const idx = (data.plans || []).findIndex(p => p.id === id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    data.plans[idx].status = 'archived';
    data.plans[idx].updatedAt = new Date().toISOString();
    await writeIndex(jobId, data);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
};

// Test-only exports for the spend-cap CAS (#510). The default export above stays
// the request handler; these expose the internal accounting helpers so the
// concurrency contract can be unit-tested without the Anthropic SDK / PNG fetch.
module.exports.__test = { commitTakeoff, readTakeoff, writeTakeoff, recordSpend };
