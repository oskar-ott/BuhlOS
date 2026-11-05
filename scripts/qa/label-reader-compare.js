#!/usr/bin/env node
'use strict';
// Which model should read labels at the camera table? Measured on YOUR labels, not
// argued. Replays crops from a real session through the same prompt and cleaning
// the server uses, once per model, and scores each read against the codes a person
// confirmed for that item.
//
//   1. Run a real session at /stock/intake?evidence=1 and press "Crops" in the log.
//   2. node scripts/qa/label-reader-compare.js --crops camera-table-crops-2026-11-02.json \
//        --models claude-opus-5,claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5
//      prints what it would cost and stops. Add --yes to spend it (ANTHROPIC_API_KEY).
//
// A wrong code is worse than no code: no code asks a person, a wrong code can log
// the wrong item. Set the winner with STOCK_INTAKE_VISION_MODEL.

const fs = require('fs');
const { codeKey } = require('../../api/_lib/workshop-stock/codes');

// USD per million tokens, from the Claude API's published rates (2026-10). Check before relying on them.
const PRICE = {
  'claude-opus-5': [5, 25], 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-fable-5-1': [10, 50],
};
// Rough tokens per read, for the warning before anything is spent. Real usage is reported after.
const GUESS_IN = 3000;
const GUESS_OUT = 500;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

/** One read against what a person confirmed: right code, a code that's wrong, or no code at all. Pure. */
function scoreRead(product, confirmedCodes) {
  const known = new Set((confirmedCodes || []).map((c) => codeKey(c.value)).filter(Boolean));
  const read = product ? [product.manufacturerCode, product.supplierSku, product.barcode].map((v) => (v ? codeKey(v) : null)).filter(Boolean) : [];
  if (!known.size) return read.length ? 'unverifiable' : 'no_code';
  if (!read.length) return 'no_code';
  return read.some((r) => known.has(r)) ? 'right' : 'wrong';
}

function dataUrlToBytes(dataUrl) {
  const hit = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  return hit ? { contentType: hit[1], bytes: Buffer.from(hit[2], 'base64') } : null;
}

const percentile = (values, p) => (values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : 0);

async function main() {
  const file = arg('crops');
  const models = (arg('models') || 'claude-opus-5,claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5').split(',').map((m) => m.trim()).filter(Boolean);
  if (!file) {
    console.error('Usage: node scripts/qa/label-reader-compare.js --crops <file> [--models a,b] [--yes]');
    process.exit(2);
  }
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) => r.crop && r.status === 'logged');
  console.log(`${rows.length} crops a person confirmed, ${models.length} models, ${rows.length * models.length} reads.`);
  for (const m of models) {
    const [i, o] = PRICE[m] || [0, 0];
    console.log(`  ${m}: about $${(((GUESS_IN * i + GUESS_OUT * o) / 1e6) * rows.length).toFixed(2)}${PRICE[m] ? '' : ' (no price on file)'}`);
  }
  if (!process.argv.includes('--yes')) {
    console.log('Nothing spent. Add --yes to run it.');
    return;
  }
  const vision = require('../../api/_lib/workshop-stock/vision');
  console.log('\nmodel                 right  wrong  no code  unverifiable  median   p90    cost');
  for (const model of models) {
    const tally = { right: 0, wrong: 0, no_code: 0, unverifiable: 0 };
    const times = [];
    let cost = 0;
    for (const row of rows) {
      const up = dataUrlToBytes(row.crop);
      if (!up) continue;
      const started = Date.now();
      let reading = null;
      try {
        reading = await vision.readProductPhoto({ ...up, model });
      } catch (e) {
        console.error(`  ${model}: failed (${(e && e.status) || 'network'})`);
      }
      times.push(Date.now() - started);
      tally[scoreRead(reading && reading.products[0], row.codes)] += 1;
      const [i, o] = PRICE[model] || [0, 0];
      if (reading && reading.usage) cost += (reading.usage.input * i + reading.usage.output * o) / 1e6;
    }
    console.log(`${model.padEnd(21)} ${String(tally.right).padStart(5)}  ${String(tally.wrong).padStart(5)}  ${String(tally.no_code).padStart(7)}  ${String(tally.unverifiable).padStart(12)}  ${(percentile(times, 0.5) / 1000).toFixed(1).padStart(5)}s ${(percentile(times, 0.9) / 1000).toFixed(1).padStart(5)}s  $${cost.toFixed(2)}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { scoreRead };
