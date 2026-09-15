'use strict';

// OPTIONAL structured-AI rung for supplier-invoice extraction — OFF unless the
// operator sets INVOICE_AI_EXTRACTION=1 (and ANTHROPIC_API_KEY exists, which
// api/plans.js already requires for plan takeoff — same provider, no new third
// party). Sends ONLY the PDF's text layer (bounded), never the bytes, and
// returns a strict JSON object via tool-use. It fills fields the rule parser
// left null; it never decides the IV job match and never auto-confirms.
//
// Cost/privacy: one short call per document that needs it (max ~4k input
// tokens, 400 output). Invoice text is business data — the owner opts in
// knowingly (docs/invoice-capture.md "AI rung").

const AI_MODEL = process.env.INVOICE_AI_MODEL || 'claude-sonnet-4-5';
const MAX_TEXT_CHARS = 12_000;

function enabled(env = process.env) {
  return env.INVOICE_AI_EXTRACTION === '1' && Boolean(env.ANTHROPIC_API_KEY);
}

let _client = null;
function client() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const TOOL = {
  name: 'record_invoice_fields',
  description: 'Record the fields printed on an Australian supplier invoice / credit note. Use null for anything not printed. Amounts are integer cents.',
  input_schema: {
    type: 'object',
    properties: {
      documentType: { type: 'string', enum: ['invoice', 'tax_invoice', 'credit_note', 'statement', 'quote', 'unknown'] },
      supplierName: { type: ['string', 'null'] },
      supplierInvoiceNumber: { type: ['string', 'null'], description: "The SUPPLIER's own invoice/credit-note number. Never an IV#### job reference." },
      invoiceDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      subtotalCents: { type: ['integer', 'null'], description: 'Total excluding GST, integer cents' },
      gstCents: { type: ['integer', 'null'] },
      totalCents: { type: ['integer', 'null'], description: 'Total including GST, integer cents' },
      confidence: {
        type: 'object',
        properties: {
          supplierName: { type: 'string', enum: ['high', 'medium', 'low'] },
          supplierInvoiceNumber: { type: 'string', enum: ['high', 'medium', 'low'] },
          invoiceDate: { type: 'string', enum: ['high', 'medium', 'low'] },
          subtotalCents: { type: 'string', enum: ['high', 'medium', 'low'] },
          gstCents: { type: 'string', enum: ['high', 'medium', 'low'] },
          totalCents: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    required: ['documentType'],
  },
};

function clean(out) {
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return {
    documentType: ['invoice', 'tax_invoice', 'credit_note', 'statement', 'quote', 'unknown'].includes(out.documentType) ? out.documentType : 'unknown',
    supplierName: str(out.supplierName, 120),
    supplierInvoiceNumber: str(out.supplierInvoiceNumber, 40),
    invoiceDate: typeof out.invoiceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(out.invoiceDate) ? out.invoiceDate : null,
    subtotalCents: int(out.subtotalCents),
    gstCents: int(out.gstCents),
    totalCents: int(out.totalCents),
    confidence: out.confidence && typeof out.confidence === 'object' ? out.confidence : {},
  };
}

/**
 * @param {string} text the PDF text layer
 * @returns {Promise<object|null>} cleaned fields, or null when the model gave nothing usable
 */
async function aiExtract(text) {
  const msg = await client().messages.create({
    model: AI_MODEL,
    max_tokens: 400,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{
      role: 'user',
      content:
        'Read this supplier document text and record its fields. Rules: amounts are integer cents; ' +
        'the supplier invoice number is the supplier\'s own document number and must never be an IV#### job code; ' +
        'use null for anything not printed; do not compute GST unless the document prints it.\n\n' +
        String(text || '').slice(0, MAX_TEXT_CHARS),
    }],
  });
  const use = (msg.content || []).find((b) => b.type === 'tool_use');
  if (!use || !use.input || typeof use.input !== 'object') return null;
  const out = clean(use.input);
  out.usage = msg.usage ? { input: msg.usage.input_tokens, output: msg.usage.output_tokens, model: AI_MODEL } : null;
  return out;
}

module.exports = { aiExtract, enabled, AI_MODEL };
