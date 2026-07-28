// Per-feature config knobs (#760, PR 2) — the runtime-tunable settings that sit
// ON TOP of the boolean feature flags (api/_lib/feature-flags.js). Where a flag
// answers "is this feature visible", a setting answers "how does it behave"
// (upload caps, length limits, …).
//
// Mirrors the flag system's discipline:
//   * a central typed REGISTRY (typo → throw, never a phantom setting);
//   * a single runtime store (the feature-settings.json blob) read via readBlob
//     (rides the 5s TTL cache);
//   * a default that EQUALS the feature's current hardcoded constant, so
//     behaviour is byte-identical until an owner writes an override;
//   * re-validation on read — an out-of-range / wrong-type stored value silently
//     resolves to the registry default (defence in depth, dark-safe).
//
// Owner-only writes go through api/owner-settings.js (gated, CAS, audited).
// Honesty (P7): a knob only does something where the feature is WIRED to read it
// (await getSetting(...)). The registry is the extension point; each consumer is
// an individual, tested wiring — there is no automatic binding.

const { readBlob } = require('./blob');

// Local literal (matches FLAGS_KEY) so the backup-manifest guard resolves it.
const SETTINGS_KEY = 'feature-settings.json';

/**
 * @typedef {{
 *   type: 'number'|'string'|'boolean'|'enum',
 *   label: string,
 *   description: string,
 *   default: number|string|boolean,
 *   min?: number, max?: number, step?: number,
 *   maxLength?: number,
 *   options?: string[],
 *   unit?: string,
 * }} SettingDef
 */

/** @type {Record<string, Record<string, SettingDef>>} */
const SETTINGS_REGISTRY = {
  // Each default MUST equal the feature's current hardcoded constant.
  // The 2026-07-27 gut deleted every previously-registered feature; what
  // remains is the lean core's knobs.
  itp_simple: {
    maxUploadMb: {
      type: 'number',
      label: 'Max photo size (MB)',
      description: 'Largest single photo a worker can attach to a simple ITP report.',
      default: 8,
      min: 1,
      max: 25,
      step: 1,
      unit: 'MB',
    },
    maxPdfPhotos: {
      type: 'number',
      label: 'Max photos per PDF',
      description: 'Serverless memory/time guard — split the report past this many photos.',
      default: 120,
      min: 10,
      max: 400,
      step: 10,
      unit: 'photos',
    },
  },
};

function definitionOf(featureKey, key) {
  const group = SETTINGS_REGISTRY[featureKey];
  const def = group && group[key];
  if (!def) {
    throw new Error(
      `unknown feature setting "${featureKey}.${key}" — settings must be declared in api/_lib/feature-settings.js`,
    );
  }
  return def;
}

/** True when `value` is a valid value for `def` (right type + within bounds). */
function isValid(def, value) {
  if (def.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (def.min != null && value < def.min) return false;
    if (def.max != null && value > def.max) return false;
    return true;
  }
  if (def.type === 'boolean') return typeof value === 'boolean';
  if (def.type === 'enum') return Array.isArray(def.options) && def.options.includes(value);
  if (def.type === 'string') {
    if (typeof value !== 'string') return false;
    if (def.maxLength != null && value.length > def.maxLength) return false;
    return true;
  }
  return false;
}

/** Coerce a stored value to a safe resolved value — registry default on any
 *  invalid/missing/out-of-range value (the settings analogue of dark-by-default). */
function coerce(def, raw) {
  return isValid(def, raw) ? raw : def.default;
}

async function readSettingsBlob() {
  try {
    const doc = await readBlob(SETTINGS_KEY, { settings: {} });
    return doc && typeof doc.settings === 'object' && doc.settings ? doc.settings : {};
  } catch {
    return {}; // blob unavailable → all defaults (dark-safe)
  }
}

/** Resolve one setting: stored (validated) value else the registry default. */
async function getSetting(featureKey, key) {
  const def = definitionOf(featureKey, key); // throws on unknown
  const settings = await readSettingsBlob();
  const stored = settings[featureKey] ? settings[featureKey][key] : undefined;
  return coerce(def, stored);
}

/** Resolve every setting in a feature group in a single blob read. */
async function getSettings(featureKey) {
  const group = SETTINGS_REGISTRY[featureKey] || {};
  const settings = await readSettingsBlob();
  const stored = settings[featureKey] || {};
  const out = {};
  for (const [key, def] of Object.entries(group)) out[key] = coerce(def, stored[key]);
  return out;
}

/** Strict write-time validation (returns an operator message instead of silently
 *  defaulting). Used by api/owner-settings.js. */
function validateWrite(featureKey, key, value) {
  const def = definitionOf(featureKey, key); // throws → caller maps to 404
  if (isValid(def, value)) return { ok: true, value };
  let error;
  if (def.type === 'number') error = `must be a number between ${def.min} and ${def.max}`;
  else if (def.type === 'enum') error = `must be one of: ${(def.options || []).join(', ')}`;
  else if (def.type === 'string')
    error = def.maxLength != null ? `must be text up to ${def.maxLength} characters` : 'must be text';
  else error = 'must be true or false';
  return { ok: false, error };
}

/** Flattened registry listing for the owner read surface (api/owner.js). */
function listSettings() {
  const out = [];
  for (const [featureKey, group] of Object.entries(SETTINGS_REGISTRY)) {
    for (const [key, def] of Object.entries(group)) out.push({ featureKey, key, ...def });
  }
  return out;
}

module.exports = {
  SETTINGS_REGISTRY,
  SETTINGS_KEY,
  definitionOf,
  isValid,
  coerce,
  getSetting,
  getSettings,
  validateWrite,
  listSettings,
};
