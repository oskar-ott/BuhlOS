// Shared per-job AI spend ledger + cost cap (#510 CAS, extracted for Epic 5).
//
// ONE ledger per job: jobs/<jobId>/ai-takeoff.json (the legacy Phase-9 name is
// kept deliberately — it is already covered by the backup manifest's jobs/
// prefix, and existing spend history keeps counting). Both the Phase-9 vision
// takeoff (api/plans.js) and the Epic 5 ai-drawings extractions
// (api/ai-drawings.js) record their vision spend here and gate on the SAME
// per-job cap, so "AI budget per job" stays one honest number no matter which
// surface spends it.
//
// commitTakeoff is the #510 fix verbatim: two concurrent analyse calls used to
// read the same spend snapshot, each record their cost, and last-write-wins
// would DROP one call's spend — silently defeating the cap. The mutation is
// RE-APPLIED onto a fresh read whenever the stored revision has moved (every
// blob write stamps __rev), so each call's spend is recorded exactly once.
// The vision call already happened and is never retried — only the local
// accounting write is.

const { readBlob, writeBlob } = require('./blob');

// Per-job cap in USD, shared across every AI-drawings/takeoff surface.
const COST_CAP_USD = Number(process.env.PLANS_MAX_USD_PER_JOB || '5');

function emptyTakeoff() {
  return {
    legendVersion: 0,
    legendItems: [],
    legendSource: null, // { planId, pageIndex }
    dwellings: {},      // dwellingId -> { suggestions, confidence, sheetIds, status, model, suggestedAt }
    sheetClassifications: {}, // 'planId:pageIndex' -> { sheetNumber, sheetTitle, dwelling, sheetType, confidence }
    sheetCache: {},     // sha256 -> { stage, result } for cheap re-runs on unchanged pages
    spend: { totalUsd: 0, calls: [] },
    createdAt: null,
    updatedAt: null,
  };
}

async function readTakeoff(jobId) {
  return await readBlob('jobs/' + jobId + '/ai-takeoff.json', emptyTakeoff());
}

async function writeTakeoff(jobId, data, opts) {
  data.updatedAt = new Date().toISOString();
  if (!data.createdAt) data.createdAt = data.updatedAt;
  await writeBlob('jobs/' + jobId + '/ai-takeoff.json', data, opts);
}

// CAS-safe commit of a takeoff mutation (#510) — see module header.
async function commitTakeoff(jobId, applyMutation) {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const takeoff = await readTakeoff(jobId);
    const expectedRev = Number.isFinite(takeoff.__rev) ? takeoff.__rev : 0;
    const payload = applyMutation(takeoff);
    try {
      await writeTakeoff(jobId, takeoff, { expectedRev });
      return payload;
    } catch (e) {
      if (e && e.code === 'stale_write' && attempt < MAX_ATTEMPTS - 1) continue;
      throw e;
    }
  }
}

// Record one AI call's cost into the ledger. `usage` accepts BOTH the raw SDK
// shape ({ input_tokens, output_tokens }) and the api/_lib/ai.js gateway shape
// ({ inputTokens, outputTokens }). `rates` are per-TOKEN USD costs — callers
// derive them from their own env-configurable per-MTok knobs so each surface
// prices at its own model's rates.
function recordSpend(takeoff, usage, kind, meta, rates) {
  const inputTokens = Number(
    (usage && (usage.input_tokens !== undefined ? usage.input_tokens : usage.inputTokens)) || 0
  );
  const outputTokens = Number(
    (usage && (usage.output_tokens !== undefined ? usage.output_tokens : usage.outputTokens)) || 0
  );
  const usd = inputTokens * rates.inputUsdPerToken + outputTokens * rates.outputUsdPerToken;
  takeoff.spend.totalUsd = Math.round((takeoff.spend.totalUsd + usd) * 1000000) / 1000000;
  takeoff.spend.calls.push({
    at: new Date().toISOString(),
    kind, meta, inputTokens, outputTokens, usd,
  });
  // Keep the call log bounded — last 200.
  if (takeoff.spend.calls.length > 200) takeoff.spend.calls = takeoff.spend.calls.slice(-200);
}

function overBudget(takeoff, capUsd) {
  const cap = capUsd === undefined ? COST_CAP_USD : capUsd;
  return takeoff.spend.totalUsd >= cap;
}

module.exports = {
  COST_CAP_USD,
  emptyTakeoff,
  readTakeoff,
  writeTakeoff,
  commitTakeoff,
  recordSpend,
  overBudget,
};
