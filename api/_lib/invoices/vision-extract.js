'use strict';

// Read a PHOTO of a receipt or invoice (owner pull 2026-09-25: "take a photo of
// a receipt and have the data extracted"). Photos have no text layer, so the
// rule parser has nothing to read; this sends the image to Claude (vision) and
// gets back a strict JSON object — store, date, receipt number, totals, GST,
// and every line with a material category.
//
// Model: Claude Opus 5 (INVOICE_VISION_MODEL overrides), effort low, with the
// server-side refusal fallback on. Structured output (json_schema) instead of a
// forced tool call, so it stays valid with thinking on.
//
// Honesty: every figure comes back with provenance 'ocr'. Anything not legible
// is null — never guessed — and a photo the model cannot read returns null so
// the pipeline sends it to a person with the photo intact. The IV job match is
// never decided here; a receipt's job is the one the worker chose.
//
// Privacy/cost: the photo (already downscaled on the phone to ≤1600 px) goes to
// Anthropic only when ANTHROPIC_API_KEY is set and the receipt/invoice feature
// is on — the owner opts in by turning the feature on (docs/invoice-capture.md
// "Receipts from the field"). One call per photo, a few cents.

const { CATEGORIES, isCategory } = require('./categories');

const VISION_MODEL = process.env.INVOICE_VISION_MODEL || 'claude-opus-5';
const REQUEST_TIMEOUT_MS = 35_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function enabled(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY);
}

let _client = null;
function client() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
  }
  return _client;
}

const nullable = (type, extra = {}) => ({ anyOf: [{ type, ...extra }, { type: 'null' }] });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['legible', 'documentType', 'storeName', 'abn', 'receiptNumber', 'date', 'subtotalExGstCents', 'gstCents', 'totalCents', 'pricesIncludeGst', 'ivReference', 'deliveryAddress', 'lines'],
  properties: {
    legible: { type: 'boolean', description: 'false when the photo is too blurred, cropped or dark to read the total' },
    documentType: { type: 'string', enum: ['receipt', 'tax_invoice', 'invoice', 'credit_note', 'delivery_docket', 'other'] },
    storeName: nullable('string', { description: 'the business name only, e.g. "Bunnings Warehouse" — without the branch, suburb or address' }),
    abn: nullable('string'),
    receiptNumber: nullable('string', { description: 'the transaction / receipt / invoice number printed by the store' }),
    date: nullable('string', { description: 'YYYY-MM-DD' }),
    subtotalExGstCents: nullable('integer', { description: 'total EXCLUDING GST, only if printed' }),
    gstCents: nullable('integer', { description: 'the GST amount (often "GST included")' }),
    totalCents: nullable('integer', { description: 'the amount paid, including GST' }),
    pricesIncludeGst: { type: 'boolean', description: 'true when the line prices include GST (usual on retail receipts)' },
    ivReference: nullable('string', { description: 'an IV job number such as IV3232 if one is written or printed, else null' }),
    deliveryAddress: nullable('string'),
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'quantity', 'unit', 'unitPriceCents', 'lineTotalCents', 'category'],
        properties: {
          description: { type: 'string' },
          quantity: nullable('number'),
          unit: nullable('string', { description: 'ea, m, roll, pk, box …' }),
          unitPriceCents: nullable('integer'),
          lineTotalCents: nullable('integer', { description: 'as printed' }),
          category: { type: 'string', enum: CATEGORIES },
        },
      },
    },
  },
};

const PROMPT =
  'This is a photo of a receipt or invoice from an Australian supplier, bought for an electrical contracting job. ' +
  'Read what is printed and record it. Amounts are integer cents. Use null for anything not printed or not legible — never estimate. ' +
  'The total is the amount paid including GST. List every product line in order (omit subtotal, GST, total, payment and change lines) ' +
  'with its quantity, unit price and line total as printed, and file each line in the material category an electrician would use: ' +
  'cable, conduit (incl. ducting and fittings), fixings (screws, anchors, ties, brackets), switchgear (breakers, RCDs, isolators), ' +
  'boards (switchboards, enclosures), lighting, accessories (power points, switches, plates), data (Cat6, comms), consumables ' +
  '(tape, glue, blades, terminals), tools, testing (test & tag, PPE), freight, other.';

function str(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}
function int(v) {
  return Number.isInteger(v) ? v : null;
}

/** Normalise the model's JSON into the shape the pipeline consumes. Pure. */
function clean(out) {
  if (!out || typeof out !== 'object') return null;
  const date = typeof out.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(out.date) ? out.date : null;
  return {
    legible: out.legible !== false,
    documentType: ['receipt', 'tax_invoice', 'invoice', 'credit_note', 'delivery_docket', 'other'].includes(out.documentType) ? out.documentType : 'other',
    storeName: str(out.storeName, 120),
    // the column holds 11 bare digits; a printed "26 008 672 179" is normalised, anything else dropped
    abn: typeof out.abn === 'string' && /^\d{11}$/.test(out.abn.replace(/\D/g, '')) ? out.abn.replace(/\D/g, '') : null,
    receiptNumber: str(out.receiptNumber, 40),
    date,
    subtotalExGstCents: int(out.subtotalExGstCents),
    gstCents: int(out.gstCents),
    totalCents: int(out.totalCents),
    pricesIncludeGst: out.pricesIncludeGst !== false,
    ivReference: str(out.ivReference, 20),
    deliveryAddress: str(out.deliveryAddress, 200),
    lines: (Array.isArray(out.lines) ? out.lines : []).slice(0, 200).map((l) => ({
      description: str(l && l.description, 200),
      quantity: l && typeof l.quantity === 'number' && Number.isFinite(l.quantity) ? l.quantity : null,
      unit: str(l && l.unit, 12),
      unitPriceCents: int(l && l.unitPriceCents),
      lineTotalCents: int(l && l.lineTotalCents),
      category: l && isCategory(l.category) ? l.category : 'other',
    })).filter((l) => l.description),
  };
}

/**
 * @param {{ bytes: Buffer|Uint8Array, contentType: string }} input
 * @returns {Promise<object|null>} cleaned fields, or null when the model declined / returned nothing usable
 */
async function visionExtract({ bytes, contentType }) {
  const mediaType = IMAGE_TYPES.has(contentType) ? contentType : 'image/jpeg';
  const msg = await client().beta.messages.create({
    model: VISION_MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: Buffer.from(bytes).toString('base64') } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  if (!msg || msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') return null;
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  const out = clean(parsed);
  if (out) out.usage = msg.usage ? { input: msg.usage.input_tokens, output: msg.usage.output_tokens, model: msg.model || VISION_MODEL } : null;
  return out;
}

module.exports = { visionExtract, enabled, clean, SCHEMA, VISION_MODEL };
