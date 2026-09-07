// Birdwood Townhouses 1–7 — the outstanding-electrical walk-through
// (owner, 2026-09) as importable job structure. ONE-OFF data + pure helpers
// shared by the two importers (scripts/import-birdwood-outstanding.js and
// the owner-gated api/birdwood-import.js); delete all three together once
// the import has run on production.
//
// Shape: one area group "Townhouses 1–7", an area per townhouse, every
// outstanding item a fit-off task. Items that can't be finished yet carry
// the stated reason inline in site language ("— waiting: benchtop") so the
// field sees WHY a task sits (P7 — the reason is real, never invented; the
// one unstated blocker says exactly that). Items the walk-through recorded
// as already done (TH6 upstairs bathroom light + fan) are not imported.

const { validateAreaGroups, findDuplicateLiveAreaId } = require('./validation');

const GROUP_NAME = 'Townhouses 1–7';
const DEFAULT_JOB_NAME = 'Birdwood Townhouses 1–7';

// label = task name as the site says it; wait = why it can't be done yet.
const TOWNHOUSES = [
  { name: 'Townhouse 1', items: [
    { label: 'Front external wall light' },
    { label: 'Spotlight', wait: 'ceiling to be completed' },
    { label: 'Kitchen lights', wait: 'kitchen ceiling to be completed' },
    { label: 'Kitchen cooktop', wait: 'benchtop' },
    { label: 'Kitchen oven', wait: 'benchtop' },
    { label: 'Splashback electrical fit-off', wait: 'splashback not ready' },
    { label: 'Bathroom ceiling fit-off / light', wait: 'bathroom ceiling to be finished' },
    { label: 'Bathroom exhaust fan', wait: 'ceiling to be finished' },
    { label: 'Upstairs ceiling lights', wait: 'upstairs ceilings to be completed' },
    { label: 'Distribution board (DB) — complete fit-off' },
  ]},
  { name: 'Townhouse 2', items: [
    { label: 'Front external wall light' },
    { label: 'Kitchen fridge GPO' },
    { label: 'Kitchen LED' },
    { label: 'Range hood' },
    { label: 'Kitchen cooktop', wait: 'benchtop' },
    { label: 'Kitchen oven', wait: 'benchtop' },
    { label: 'Laundry ceiling fit-off', wait: 'ceiling to be sanded and painted' },
    { label: 'Ground-floor switch' },
    { label: 'Bathroom switch' },
    { label: 'Master bedroom light' },
    { label: 'Walk-in wardrobe light' },
    { label: 'Upstairs bathroom light' },
    { label: 'Upstairs bathroom exhaust fan' },
    { label: 'USB GPOs in bedrooms' },
    { label: 'Bulbs / lights in the two rear bedrooms' },
  ]},
  { name: 'Townhouse 3', items: [
    { label: 'Front external wall light' },
    { label: 'Fridge GPO' },
    { label: 'Kitchen LED' },
    { label: 'Kitchen switch' },
    { label: 'Upstairs bathroom ceiling light' },
    { label: 'Upstairs bathroom exhaust fan' },
    { label: 'USB GPOs in all bedrooms' },
  ]},
  { name: 'Townhouse 4', items: [
    { label: 'Front external wall light' },
    { label: 'Living room GPO — mount / fit off' },
    { label: 'Kitchen switch', wait: 'wall to be rendered' },
    { label: 'Fridge GPO' },
    { label: 'Cooktop', wait: 'benchtop' },
    { label: 'Oven', wait: 'benchtop' },
    { label: 'Range hood' },
    { label: 'Kitchen LED' },
    { label: 'Downstairs bathroom exhaust fan — cut out' },
    { label: 'Downstairs bathroom ceiling light', wait: 'ceiling to be patched and painted' },
    { label: 'All upstairs ceiling lights' },
    { label: 'USB GPOs in upstairs bedrooms' },
    { label: 'Upstairs stair switch' },
  ]},
  { name: 'Townhouse 5', items: [
    { label: 'Front external wall light' },
    { label: 'Living room GPOs' },
    { label: 'Living room ceiling light', wait: 'first coat of paint' },
    { label: 'Living room switch' },
    { label: 'Stair switch' },
    { label: 'Downstairs bathroom switch' },
    { label: 'Fridge GPO' },
    { label: 'Kitchen switch' },
    { label: 'Kitchen range hood' },
    { label: 'Kitchen LEDs' },
    { label: 'Kitchen light', wait: 'blocker not stated on site' },
    { label: 'Cooktop', wait: 'benchtop' },
    { label: 'Oven', wait: 'benchtop' },
    { label: 'Downstairs bathroom exhaust fan — cut out' },
    { label: 'Downstairs bathroom ceiling light', wait: 'ceiling to be sanded and painted' },
    { label: 'Upstairs ceiling lights', wait: 'sanded — need first coat of paint' },
    { label: 'Upstairs bedroom GPOs' },
    { label: 'Upstairs bedroom switches' },
    { label: 'Additional upstairs GPO from inspection — exact location to confirm' },
    { label: 'Upstairs bathroom light' },
    { label: 'Upstairs bathroom ceiling / exhaust fan' },
  ]},
  { name: 'Townhouse 6', items: [
    { label: 'Front external wall light' },
    { label: 'Downstairs bathroom switch' },
    { label: 'Kitchen LEDs' },
    { label: 'Kitchen ceiling light' },
    { label: 'Fridge GPO' },
    { label: 'Range hood' },
    { label: 'Downstairs bathroom exhaust fan — cut out' },
    { label: 'Downstairs bathroom exhaust fan — final fit-off', wait: 'ceiling to be patched and painted' },
    { label: 'Downstairs bathroom ceiling light', wait: 'ceiling to be patched and painted' },
    { label: 'Lights in the two rear upstairs bedrooms' },
    { label: 'USB GPOs in upstairs bedrooms' },
    { label: 'Upstairs bathroom GPO — fit off' },
  ]},
  { name: 'Townhouse 7', items: [
    { label: 'Front external wall light' },
    { label: 'Lounge room spotlight', wait: 'painting to be completed' },
    { label: 'Kitchen LED' },
    { label: 'Range hood' },
    { label: 'Fridge GPO — inspect and pick mounting point' },
    { label: 'Cooktop isolation switch / above-bench fit-off', wait: 'above-bench area not ready' },
    { label: 'Kitchen switch' },
    { label: 'Kitchen ceiling light', wait: 'ceiling patching' },
    { label: 'Downstairs bathroom exhaust / ceiling fan — cut out' },
    { label: 'Downstairs bathroom light', wait: 'ceiling to be painted' },
    { label: 'Upstairs bathroom GPO — fit off' },
    { label: 'Upstairs bathroom ceiling fan', wait: 'ceiling patching' },
    { label: 'Upstairs bathroom light', wait: 'painting' },
    { label: 'USB GPOs in all upstairs bedrooms' },
    { label: 'Wall switches in upstairs bedrooms' },
    { label: 'Hallway wall switches' },
    { label: 'Master bedroom ceiling / light fit-off', wait: 'sanding / upstairs painting not complete' },
  ]},
];

function taskName(item) {
  return item.wait ? `${item.label} — waiting: ${item.wait}` : item.label;
}

/** The raw (id-less) group — every write path re-validates it and the
 *  server-side validator mints the ids. */
function buildGroup() {
  return {
    name: GROUP_NAME,
    areas: TOWNHOUSES.map((th, i) => ({
      name: th.name,
      spaceType: 'Townhouse',
      order: i,
      fitOffTasks: th.items.map((item, j) => ({ name: taskName(item), order: j })),
    })),
  };
}

/** Per-townhouse + total counts for dry-run plans and responses. */
function planCounts() {
  const townhouses = TOWNHOUSES.map((th) => ({
    name: th.name,
    tasks: th.items.length,
    waiting: th.items.filter((i) => i.wait).length,
  }));
  return {
    townhouses,
    total: townhouses.reduce((s, t) => s + t.tasks, 0),
    waiting: townhouses.reduce((s, t) => s + t.waiting, 0),
  };
}

/** Jobs that look like the Birdwood site (name or id), any status. */
function findBirdwoodJobs(jobs) {
  return (jobs || []).filter(
    (j) => j && (/birdwood/i.test(j.name || '') || /birdwood/i.test(j.id || ''))
  );
}

/** True when the job already carries a LIVE import group — the re-run guard. */
function hasLiveBirdwoodGroup(job) {
  return ((job && job.areaGroups) || []).some(
    (g) => g && g.name === GROUP_NAME && !g.archived
  );
}

/**
 * Append the validated group to an EXISTING job (mutates `job`). The
 * live-area-id invariant runs over the COMBINED structure with the same
 * shared guard every other write path uses. Returns { ok: true } or
 * { ok: false, error } with nothing mutated on failure.
 */
function addGroupToJob(job) {
  const parsed = validateAreaGroups([buildGroup()], 'areaGroups');
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const combined = [...(job.areaGroups || []), ...parsed.groups];
  const dup = findDuplicateLiveAreaId(combined);
  if (dup) return { ok: false, error: `live area id collision after merge: ${dup}` };
  job.areaGroups = combined;
  job.updatedAt = new Date().toISOString();
  return { ok: true };
}

module.exports = {
  GROUP_NAME,
  DEFAULT_JOB_NAME,
  TOWNHOUSES,
  buildGroup,
  planCounts,
  findBirdwoodJobs,
  hasLiveBirdwoodGroup,
  addGroupToJob,
};
