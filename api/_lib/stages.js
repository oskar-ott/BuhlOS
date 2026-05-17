// Stage normalisation. Stages can be stored as plain strings, partially-rich
// objects, or the full rich shape. Read paths always return the full rich
// shape so Phil / Switchboard don't have to handle the variants.
//
// Full rich shape:
//   {
//     id: "stage_fitoff_test",
//     name: "Test and commission",
//     category: "roughIn" | "fitOff",
//     order: 20,
//     active: true,
//     requires: {
//       photo, note, itp, independentReview,
//       blocksSelfReview, blockIfOpenSnags,
//       blockIfSupersededPlan, blockIfMissingGear, adminSignoff
//     },
//     evidence: { minPhotos, minNotes },
//     itpTemplateId: "itp_testing_basic" | null
//   }

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stableId(category, name) {
  const base = slug(name) || 'stage';
  return `stage_${category}_${base}`;
}

function defaultRequires(name) {
  const s = String(name || '').toLowerCase();
  return {
    photo:                /test|complete|handover|rough-?in complete|certificate/.test(s),
    note:                 /handover|certificate/.test(s),
    itp:                  /test|certificate|handover/.test(s),
    independentReview:    /test|certificate|handover/.test(s),
    blocksSelfReview:     /test|certificate|handover/.test(s),
    blockIfOpenSnags:     /handover|certificate/.test(s),
    blockIfSupersededPlan: false,
    blockIfMissingGear:   false,
    adminSignoff:         /handover|certificate/.test(s),
  };
}

function normaliseRequires(r, name) {
  const d = defaultRequires(name);
  if (!r || typeof r !== 'object') return d;
  return {
    photo:                 'photo'                in r ? !!r.photo                : d.photo,
    note:                  'note'                 in r ? !!r.note                 : d.note,
    itp:                   'itp'                  in r ? !!r.itp                  : d.itp,
    independentReview:     'independentReview'    in r ? !!r.independentReview    : d.independentReview,
    blocksSelfReview:      'blocksSelfReview'     in r ? !!r.blocksSelfReview     : !!r.independentReview,
    blockIfOpenSnags:      'blockIfOpenSnags'     in r ? !!r.blockIfOpenSnags     : d.blockIfOpenSnags,
    blockIfSupersededPlan: 'blockIfSupersededPlan' in r ? !!r.blockIfSupersededPlan : d.blockIfSupersededPlan,
    blockIfMissingGear:    'blockIfMissingGear'   in r ? !!r.blockIfMissingGear   : d.blockIfMissingGear,
    adminSignoff:          'adminSignoff'         in r ? !!r.adminSignoff         : d.adminSignoff,
  };
}

function normaliseEvidence(e) {
  if (!e || typeof e !== 'object') return { minPhotos: 0, minNotes: 0 };
  const n = v => (Number.isFinite(Number(v)) && Number(v) >= 0) ? Math.floor(Number(v)) : 0;
  return { minPhotos: n(e.minPhotos), minNotes: n(e.minNotes) };
}

function normaliseStage(s, category, index) {
  if (s && typeof s === 'object') {
    const name = String(s.name || '').trim();
    if (!name) return null;
    const id = String(s.id || '').trim() || stableId(category, name);
    // Preserve aliases so a renamed stage still matches old dwelling keys.
    const legacyNames = Array.isArray(s.legacyNames)
      ? s.legacyNames.map(x => String(x).trim()).filter(Boolean).filter(n => n !== name)
      : [];
    return {
      id,
      name,
      category: String(s.category || category || 'roughIn'),
      order: Number.isFinite(Number(s.order)) ? Number(s.order) : index,
      active: s.active === false ? false : true,
      requires: normaliseRequires(s.requires, name),
      evidence: normaliseEvidence(s.evidence),
      itpTemplateId: s.itpTemplateId ? String(s.itpTemplateId) : null,
      legacyNames,
      // Preserve unknown fields so future additions don't get destroyed.
      _extra: Object.keys(s).reduce((acc, k) => {
        if (!['id', 'name', 'category', 'order', 'active', 'requires', 'evidence', 'itpTemplateId', 'legacyNames'].includes(k)) {
          acc[k] = s[k];
        }
        return acc;
      }, {}),
    };
  }
  // String form — derive defaults from the name.
  const name = String(s || '').trim();
  if (!name) return null;
  return {
    id: stableId(category, name),
    name,
    category,
    order: index,
    active: true,
    requires: defaultRequires(name),
    evidence: { minPhotos: 0, minNotes: 0 },
    itpTemplateId: null,
    legacyNames: [],
    _extra: {},
  };
}

function normaliseStageList(arr, category) {
  if (!Array.isArray(arr)) return [];
  return arr.map((s, i) => normaliseStage(s, category, i)).filter(Boolean);
}

function normaliseStages(stages) {
  if (!stages || typeof stages !== 'object') return { roughIn: [], fitOff: [] };
  return {
    roughIn: normaliseStageList(stages.roughIn, 'roughIn'),
    fitOff:  normaliseStageList(stages.fitOff,  'fitOff'),
  };
}

function withRichStages(job) {
  if (!job) return job;
  return { ...job, stages: normaliseStages(job.stages) };
}

// Flatten rich stages back into the raw form ready for storage. We strip
// `_extra` back out at the top level (it's only used to round-trip unknown
// fields through Phil/Switchboard).
function flattenForStorage(stages) {
  if (!stages) return { roughIn: [], fitOff: [] };
  const flat = arr => (Array.isArray(arr) ? arr : []).map(s => ({
    ...(s._extra || {}),
    id: s.id,
    name: s.name,
    category: s.category,
    order: s.order,
    active: s.active,
    requires: s.requires,
    evidence: s.evidence,
    itpTemplateId: s.itpTemplateId,
    legacyNames: Array.isArray(s.legacyNames) ? s.legacyNames : [],
  }));
  return { roughIn: flat(stages.roughIn), fitOff: flat(stages.fitOff) };
}

// Look up a stage in a (normalised) job by id, name, legacyNames alias, or
// case-insensitive name. The tolerant matching lets evidence / status data
// keyed by an old stage name still resolve after a rename.
function findStageInJob(job, idOrName) {
  if (!job || !idOrName) return null;
  const stages = withRichStages(job).stages;
  const all = [...stages.roughIn, ...stages.fitOff];
  const needle = String(idOrName);
  const lc = needle.toLowerCase();
  return all.find(s => s.id === needle)
      || all.find(s => s.name === needle)
      || all.find(s => Array.isArray(s.legacyNames) && s.legacyNames.indexOf(needle) >= 0)
      || all.find(s => String(s.name || '').toLowerCase() === lc)
      || all.find(s => Array.isArray(s.legacyNames) && s.legacyNames.some(n => String(n).toLowerCase() === lc))
      || null;
}

module.exports = {
  defaultRequires,
  normaliseStage,
  normaliseStageList,
  normaliseStages,
  withRichStages,
  flattenForStorage,
  findStageInJob,
};
