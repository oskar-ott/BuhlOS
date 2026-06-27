// Rule-based task generation engine (#224) — the SINGLE source of truth.
//
// A rule says "areas matching THIS condition get THESE per-stage task lists".
// The builder's "Generate tasks" (api/generate-tasks.js) runs the rules over a
// job's areas and fills the matching ones; api/task-rules.js maintains the rule
// set. Deterministic, no AI (the AI version is Epic 6): same job + rules always
// produce the same structure.
//
// CJS so both serverless handlers can require it; the TS side (src/domains/jobs/
// task-rules.ts) holds only types + advisory UI validation. The behaviour here
// is pinned by src/domains/jobs/task-rules.test.ts (which requires THIS file).
//
// Re-uses the by-name id-preserving merge semantics from api/job-templates.js.

const MAX_RULES = 100;
const MAX_TASKS_PER_STAGE = 50;
const MAX_PATTERN = 120;

function cleanNames(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const n of arr) {
    if (typeof n !== 'string') continue;
    const t = n.trim();
    if (t) out.push(t.slice(0, 200));
    if (out.length >= MAX_TASKS_PER_STAGE) break;
  }
  return out;
}

/** True when a rule applies to (jobType, areaName). Absent conditions wildcard. */
function ruleMatchesArea(rule, jobType, areaName) {
  if (rule.jobType != null && rule.jobType !== '' && rule.jobType !== jobType) {
    return false;
  }
  const pattern = String(rule.areaPattern == null ? '' : rule.areaPattern).trim().toLowerCase();
  if (pattern !== '' && !String(areaName == null ? '' : areaName).toLowerCase().includes(pattern)) {
    return false;
  }
  return true;
}

/** Deduped union of task names every matching rule would seed, in rule order. */
function matchedTaskNames(rules, jobType, areaName) {
  const roughIn = [];
  const fitOff = [];
  const seenRough = new Set();
  const seenFit = new Set();
  let matched = false;
  for (const rule of rules || []) {
    if (!ruleMatchesArea(rule, jobType, areaName)) continue;
    matched = true;
    for (const n of cleanNames(rule.roughIn)) {
      if (!seenRough.has(n)) { seenRough.add(n); roughIn.push(n); }
    }
    for (const n of cleanNames(rule.fitOff)) {
      if (!seenFit.has(n)) { seenFit.add(n); fitOff.push(n); }
    }
  }
  return { roughIn, fitOff, matched };
}

/** Merge generated names into an existing stage list, id-preserving by name. */
function mergeStage(existing, generatedNames, newId, counter) {
  const byName = new Map();
  for (const t of existing) byName.set(t.name, t);
  const result = existing.map((t) => ({ id: t.id, name: t.name }));
  let added = 0;
  for (const name of generatedNames) {
    if (byName.has(name)) continue;
    result.push({ id: newId(name, counter.n++), name });
    added++;
  }
  return { tasks: result, added };
}

function freshStage(names, newId, counter) {
  return names.map((name) => ({ id: newId(name, counter.n++), name }));
}

/**
 * Apply generation rules to a job's areas → { areaGroups, summary }. Pure (does
 * not mutate `job`). mode 'fill-empty' (default) only sets a stage list that is
 * currently EMPTY; mode 'merge' merges generated names into existing lists
 * (id-preserving). `newId(name, index)` mints ids for new tasks.
 */
function generateTasksForJob(job, rules, opts) {
  const options = opts || {};
  const mode = options.mode === 'merge' ? 'merge' : 'fill-empty';
  const newId = options.newId || ((name, i) => `rt_gen_${i}`);
  const counter = { n: 0 };
  const jobType = job && job.type != null ? job.type : null;

  let areasMatched = 0;
  let areasFilled = 0;
  let roughInAdded = 0;
  let fitOffAdded = 0;
  let areasSkippedNonEmpty = 0;

  const groups = ((job && job.areaGroups) || []).map((g) => {
    // Archived groups are frozen — never generate into them (draft/archived guard).
    if (g && g.archived) return g;
    const areas = ((g && g.areas) || []).map((a) => {
      // Archived areas are frozen too.
      if (a && a.archived) return a;
      const { roughIn, fitOff, matched } = matchedTaskNames(rules, jobType, (a && a.name) || '');
      if (!matched) return a;
      areasMatched++;

      const existingRough = (a && a.roughInTasks) || [];
      const existingFit = (a && a.fitOffTasks) || [];
      let nextRough = existingRough;
      let nextFit = existingFit;
      let changed = false;
      let skipped = false;

      if (roughIn.length > 0) {
        if (existingRough.length === 0) {
          nextRough = freshStage(roughIn, newId, counter);
          roughInAdded += nextRough.length;
          changed = changed || nextRough.length > 0;
        } else if (mode === 'merge') {
          const m = mergeStage(existingRough, roughIn, newId, counter);
          nextRough = m.tasks; roughInAdded += m.added; changed = changed || m.added > 0;
        } else { skipped = true; }
      }
      if (fitOff.length > 0) {
        if (existingFit.length === 0) {
          nextFit = freshStage(fitOff, newId, counter);
          fitOffAdded += nextFit.length;
          changed = changed || nextFit.length > 0;
        } else if (mode === 'merge') {
          const m = mergeStage(existingFit, fitOff, newId, counter);
          nextFit = m.tasks; fitOffAdded += m.added; changed = changed || m.added > 0;
        } else { skipped = true; }
      }

      if (changed) areasFilled++;
      if (skipped && !changed) areasSkippedNonEmpty++;
      if (!changed) return a;
      return Object.assign({}, a, { roughInTasks: nextRough, fitOffTasks: nextFit });
    });
    return Object.assign({}, g, { areas });
  });

  return {
    areaGroups: groups,
    summary: { areasMatched, areasFilled, roughInAdded, fitOffAdded, areasSkippedNonEmpty },
  };
}

/** Normalise + validate one rule. Returns { rule } or { error }. */
function normaliseRule(raw, nanoid) {
  if (!raw || typeof raw !== 'object') return { error: 'rule must be an object' };
  const jobType = raw.jobType == null || raw.jobType === '' ? null : String(raw.jobType).slice(0, 100);
  const patternRaw = raw.areaPattern == null ? '' : String(raw.areaPattern).trim();
  if (patternRaw.length > MAX_PATTERN) return { error: 'area pattern is too long' };
  const areaPattern = patternRaw === '' ? null : patternRaw;
  const roughIn = cleanNames(raw.roughIn);
  const fitOff = cleanNames(raw.fitOff);
  if (roughIn.length === 0 && fitOff.length === 0) {
    return { error: 'a rule needs at least one rough-in or fit-off task' };
  }
  const id = raw.id && typeof raw.id === 'string' ? raw.id : nanoid('tr_');
  return { rule: { id, jobType, areaPattern, roughIn, fitOff } };
}

/** Validate + normalise a full rules array. Returns { rules } or { error }. */
function normaliseRules(incoming, nanoid) {
  if (!Array.isArray(incoming)) return { error: 'rules must be an array' };
  if (incoming.length > MAX_RULES) return { error: `too many rules (max ${MAX_RULES})` };
  const rules = [];
  for (let i = 0; i < incoming.length; i++) {
    const { rule, error } = normaliseRule(incoming[i], nanoid);
    if (error) return { error: `rule ${i + 1}: ${error}` };
    rules.push(rule);
  }
  return { rules };
}

module.exports = {
  MAX_RULES,
  MAX_TASKS_PER_STAGE,
  MAX_PATTERN,
  cleanNames,
  ruleMatchesArea,
  matchedTaskNames,
  generateTasksForJob,
  normaliseRule,
  normaliseRules,
};
