// The ONE Anthropic gateway (#170, Epic 6 foundation).
//
// Every assistant feature calls Claude through here — one client, one env
// contract, one error taxonomy — instead of hand-rolling fetch/SDK calls per
// feature. The three PRE-EXISTING call sites (api/tags.js OCR, api/quotes.js
// ai-review, api/plans.js takeoff) still carry their own calls; migrating them
// onto this gateway is a follow-up, and aiComplete's signature (system /
// messages / model / maxTokens) is shaped so that migration is mechanical.
//
// Design rules:
//   - Honest failure: no key ⇒ AiError('UNCONFIGURED') — callers surface a real
//     503, never a fake answer. Provider/network failure ⇒
//     AiError('PROVIDER_FAILED') — callers surface a 502.
//   - Bounded spend: max_tokens is always capped (MAX_TOKENS_CAP) so no caller
//     can request an unbounded completion.
//   - Usage is returned (input/output tokens) so callers can record spend the
//     way api/plans.js does (#510 cost caps).

/** Error codes: 'UNCONFIGURED' (no API key) | 'PROVIDER_FAILED' (call failed). */
class AiError extends Error {
  /**
   * @param {'UNCONFIGURED'|'PROVIDER_FAILED'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}

// Env-configurable model with a CURRENT bare-alias default, matching the
// TAGS_AI_MODEL / QUOTES_AI_MODEL / PLANS_AI_MODEL convention (#378).
const DEFAULT_MODEL = 'claude-sonnet-4-6';
function assistantModel() {
  const m = process.env.ASSISTANT_AI_MODEL;
  return m && String(m).trim() ? String(m).trim() : DEFAULT_MODEL;
}

// Hard per-call output cap — a caller may ask for less, never more.
// 4096 since #201: a full legend extraction (40+ symbol rows as strict JSON)
// doesn't fit in 2048. Still a hard bound — the cap exists so no caller can
// request an unbounded completion, not to pin the smallest workload.
const MAX_TOKENS_CAP = 4096;
const DEFAULT_MAX_TOKENS = 1024;

function isAiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Lazy singleton client — lazy-required so this module still parses without
// the SDK installed (same pattern as api/plans.js), and per-process single
// instance so serverless warm invocations reuse the connection.
let _client = null;
function client() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/**
 * One completion call. Throws AiError — never returns invented text.
 *
 * @param {{
 *   system?: string,
 *   messages: Array<{role: 'user'|'assistant', content: any}>,
 *   model?: string,
 *   maxTokens?: number,
 * }} opts
 * @returns {Promise<{
 *   text: string,
 *   usage: {inputTokens: number, outputTokens: number}|null,
 *   model: string,
 * }>}
 */
async function aiComplete({ system, messages, model, maxTokens } = {}) {
  if (!isAiConfigured()) {
    throw new AiError('UNCONFIGURED', 'ANTHROPIC_API_KEY is not set — AI features are unavailable');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AiError('PROVIDER_FAILED', 'aiComplete requires at least one message');
  }
  const requested = Number(maxTokens);
  const capped = Math.min(
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_MAX_TOKENS,
    MAX_TOKENS_CAP
  );

  let resp;
  try {
    resp = await client().messages.create({
      model: model || assistantModel(),
      max_tokens: capped,
      ...(system ? { system } : {}),
      messages,
    });
  } catch (e) {
    const msg = (e && e.message) || 'unknown provider error';
    throw new AiError('PROVIDER_FAILED', 'Anthropic request failed: ' + msg);
  }

  const text = (resp.content || [])
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
  const usage = resp.usage
    ? {
        inputTokens: Number(resp.usage.input_tokens) || 0,
        outputTokens: Number(resp.usage.output_tokens) || 0,
      }
    : null;
  return { text, usage, model: resp.model || model || assistantModel() };
}

module.exports = {
  AiError,
  isAiConfigured,
  aiComplete,
  assistantModel,
  MAX_TOKENS_CAP,
  DEFAULT_MAX_TOKENS,
};
