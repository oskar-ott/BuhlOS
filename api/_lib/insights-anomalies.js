// #347 — deterministic anomaly rules for the insights digest.
//
// PURE module: collectAnomalies() takes injected records and returns
// structured findings; renderDeterministic() phrases them with NO model —
// it is both the honest fallback when the LLM is unavailable/refused and
// the grounding basis the LLM layer is validated against. The AI layer
// (api/insights-digest.js) only ever REPHRASES these findings — it never
// computes or invents a number (architecture is the contract).
//
// Boundary with #175 (delay-pattern flags): per-record staleness detection
// belongs to #175; this module does statistics over series/queues the office
// already owns — approvals waiting, week-over-week hours, snag ageing.
// Coverage is stated per digest (COVERAGE) so the footer can say honestly
// what the system does and does not see.

// ── week helpers (Monday-start, date-string arithmetic — no TZ surprises) ──

function toDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z');
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing dateStr (YYYY-MM-DD in, YYYY-MM-DD out). */
function weekStartOf(dateStr) {
  const d = toDate(dateStr);
  const day = d.getUTCDay(); // 0=Sun
  const back = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - back);
  return fmt(d);
}

function addDays(dateStr, n) {
  const d = toDate(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

function daysBetween(fromIsoOrDate, toDateStr) {
  const from = new Date(fromIsoOrDate);
  const to = toDate(toDateStr);
  if (Number.isNaN(from.getTime())) return null;
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ── thresholds (documented, conservative) ─────────────────────────────────

const PENDING_APPROVALS_MIN_AGE_DAYS = 3;
const PENDING_APPROVALS_RED_AGE_DAYS = 7;
const WOW_MIN_PCT = 0.3;
const WOW_MIN_HOURS = 5;
const FIRST_HOURS_MIN = 8;
const SNAG_AGEING_MIN_DAYS = 14;

/** What this digest reads — and, just as important, what it does not. */
const COVERAGE = {
  sees: [
    'hours submitted and approved (week-over-week totals, approvals queue age)',
    'open snags/defects across jobs (counts, age, urgent count)',
  ],
  doesNotSee: [
    'labour cost in dollars (rates coverage is partial)',
    'materials consumption',
    'gear/test-tag expiries (see the Gear page)',
    'per-task staleness (delay flags are a separate feature)',
  ],
};

// ── rules ─────────────────────────────────────────────────────────────────
//
// Finding shape:
//   { key, kind, severity: 'amber'|'red', facts: {…only numbers/names used in
//     prose}, text: <deterministic phrasing>, href, sources: [{store, id}] }

function sumJobHours(entry) {
  return (entry.allocations || []).reduce((s, a) => s + (Number(a && a.hours) || 0), 0);
}

/**
 * @param {{
 *   today: string,                       // YYYY-MM-DD
 *   entries: Array<{id, userId, date, status, allocations}>,
 *   snags: Array<{id, jobId, jobName, status, priority, createdAt}>,
 * }} sources
 */
function collectAnomalies({ today, entries, snags } = {}) {
  if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error('collectAnomalies requires today as YYYY-MM-DD');
  }
  const list = Array.isArray(entries) ? entries : [];
  const snagList = Array.isArray(snags) ? snags : [];
  const findings = [];

  // A — approvals waiting too long.
  const submitted = list.filter((e) => e && e.status === 'submitted');
  if (submitted.length > 0) {
    const oldestDays = Math.max(
      ...submitted.map((e) => daysBetween(e.date + 'T00:00:00Z', today) ?? 0)
    );
    if (oldestDays >= PENDING_APPROVALS_MIN_AGE_DAYS) {
      const totalHours = round1(submitted.reduce((s, e) => s + sumJobHours(e), 0));
      findings.push({
        key: 'hours.approvals_waiting',
        kind: 'approvals_waiting',
        severity: oldestDays >= PENDING_APPROVALS_RED_AGE_DAYS ? 'red' : 'amber',
        facts: { count: submitted.length, totalHours, oldestDays },
        text:
          `${submitted.length} timesheet ${submitted.length === 1 ? 'entry' : 'entries'} ` +
          `(${totalHours}h) waiting for approval — the oldest has waited ${oldestDays} days.`,
        href: '/hours/approvals',
        sources: submitted
          .slice(0, 20)
          .map((e) => ({ store: `users/${e.userId}/time-entries/${e.date}.json`, id: e.id || null })),
      });
    }
  }

  // B — hours week-over-week swing (approved + submitted; drafts/rejected
  // excluded). pct is null when last week was zero — never a fabricated %.
  const thisWeekStart = weekStartOf(today);
  const lastWeekStart = addDays(thisWeekStart, -7);
  const inWeek = (e, start) => e.date >= start && e.date < addDays(start, 7);
  const counted = list.filter((e) => e && (e.status === 'approved' || e.status === 'submitted'));
  const thisWeek = round1(counted.filter((e) => inWeek(e, thisWeekStart)).reduce((s, e) => s + sumJobHours(e), 0));
  const lastWeek = round1(counted.filter((e) => inWeek(e, lastWeekStart)).reduce((s, e) => s + sumJobHours(e), 0));
  if (lastWeek === 0 && thisWeek >= FIRST_HOURS_MIN) {
    findings.push({
      key: 'hours.first_hours_week',
      kind: 'hours_wow',
      severity: 'amber',
      facts: { thisWeek, lastWeek, pct: null },
      text: `${thisWeek}h logged this week after a zero-hour week — first hours in a fortnight.`,
      href: '/hours',
      sources: [{ store: 'users/*/time-entries/*.json', id: null }],
    });
  } else if (lastWeek > 0) {
    const delta = thisWeek - lastWeek;
    const pct = Math.abs(delta) / lastWeek;
    if (pct >= WOW_MIN_PCT && Math.abs(delta) >= WOW_MIN_HOURS) {
      const pctRounded = Math.round(pct * 100);
      findings.push({
        key: 'hours.week_over_week',
        kind: 'hours_wow',
        severity: 'amber',
        facts: { thisWeek, lastWeek, pctRounded, direction: delta > 0 ? 'up' : 'down' },
        text:
          `Hours are ${delta > 0 ? 'up' : 'down'} ${pctRounded}% week-on-week — ` +
          `${thisWeek}h this week against ${lastWeek}h last week.`,
        href: '/hours',
        sources: [{ store: 'users/*/time-entries/*.json', id: null }],
      });
    }
  }

  // C — snags ageing / urgent.
  const openStatuses = new Set(['open', 'in_progress']);
  const open = snagList.filter((s) => s && openStatuses.has(String(s.status || '').toLowerCase()));
  if (open.length > 0) {
    const oldestDays = Math.max(...open.map((s) => daysBetween(s.createdAt, today) ?? 0));
    const urgent = open.filter((s) => String(s.priority || '').toLowerCase() === 'urgent');
    if (oldestDays >= SNAG_AGEING_MIN_DAYS || urgent.length > 0) {
      findings.push({
        key: 'snags.open_ageing',
        kind: 'snags_ageing',
        severity: urgent.length > 0 ? 'red' : 'amber',
        facts: { openCount: open.length, oldestDays, urgentCount: urgent.length },
        text:
          `${open.length} snag${open.length === 1 ? '' : 's'} still open` +
          (urgent.length > 0 ? ` (${urgent.length} urgent)` : '') +
          ` — the oldest has been open ${oldestDays} days.`,
        href: '/defects',
        sources: open.slice(0, 20).map((s) => ({ store: `jobs/${s.jobId}/data.json`, id: s.id })),
      });
    }
  }

  return { weekStart: thisWeekStart, findings };
}

/** Deterministic bullets — the no-model rendering of the findings. */
function renderDeterministic(findings) {
  return (Array.isArray(findings) ? findings : []).map((f) => ({
    text: f.text,
    href: f.href,
    findingKey: f.key,
  }));
}

module.exports = {
  collectAnomalies,
  renderDeterministic,
  weekStartOf,
  addDays,
  COVERAGE,
  // thresholds exported for tests + the docs footer
  PENDING_APPROVALS_MIN_AGE_DAYS,
  PENDING_APPROVALS_RED_AGE_DAYS,
  WOW_MIN_PCT,
  WOW_MIN_HOURS,
  FIRST_HOURS_MIN,
  SNAG_AGEING_MIN_DAYS,
};
