// Owner Console data endpoint (docs/owner-console.md).
//
//   GET /api/owner            → the full owner-console summary
//   GET /api/owner?section=…  → reserved for future per-section reads
//
// The single authoritative source of truth for OWNER-ONLY access. The /owner
// page coarse-gates at the middleware (admin tier) and then renders from THIS
// endpoint; a non-owner admin who reaches the page gets a 403 here and the page
// 404s. Everything below is:
//   * OWNER-ONLY    — requireAuth (HMAC-verified, fresh users.json) then the
//                     canAccessOwnerConsole gate (role 'owner' OR OWNER_EMAILS).
//                     Fails CLOSED (401 unauth, 403 non-owner).
//   * READ-ONLY     — GET only. Flag WRITES live in the companion route
//                     POST /api/owner-flags (same owner gate, CAS, audit); this
//                     endpoint never mutates.
//   * HONEST (P7)   — every value is real (registry, env, the flags.json
//                     override blob, the audit journal, live health probes) or
//                     an explicit "not instrumented yet" label. Never a fake
//                     number, never a hardcoded "healthy".
//   * NO SECRETS    — never returns SESSION_SECRET, password hashes, raw env,
//                     the raw flags blob, or audit metadata payloads.
//
// Like the rest of the app's api/*.js, this does not run under `next dev`
// (PR previews are the verification surface).

const { readBlob, setNoCache } = require('./_lib/blob');
const {
  requireAuth,
  canAccessOwnerConsole,
  isOwnerRole,
} = require('./_lib/auth');
const {
  listFlags,
  isFlagOn,
  isFlagEnabled,
  isProtectedFlag,
  presentationOf,
  expiredFlags,
} = require('./_lib/feature-flags');
const { listSettings, coerce } = require('./_lib/feature-settings');
const { readMonth, VALID_ACTIONS } = require('./_lib/audit-log');
const { readErrors, MAX_ENTRIES: ERROR_LOG_CAP } = require('./_lib/error-log');

const FLAGS_KEY = 'flags.json';
const SETTINGS_KEY = 'feature-settings.json';
const EXPIRING_SOON_DAYS = 30;
const RECENT_AUDIT_LIMIT = 25;

// Mirror of feature-flags.js parseEnv (not exported there) — used only to
// report a flag's resolution SOURCE, never to resolve enablement (isFlagOn
// stays the single resolver).
function parseEnvLike(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = String(raw).toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return null;
}

function envName(key) {
  return 'FLAG_' + String(key).toUpperCase();
}

// isProtectedFlag (the data-plane / perf flags that stay ops-only and are never
// toggleable from the owner UI) is now the single source of truth in
// feature-flags.js — imported above and shared with the write route.

function daysUntil(yyyymmdd, now) {
  const then = Date.parse(yyyymmdd + 'T00:00:00Z');
  if (Number.isNaN(then)) return null;
  return Math.floor((then - now.getTime()) / 86400000);
}

function ymOf(d) {
  return d.toISOString().slice(0, 7);
}

function maskEmail(email) {
  const e = String(email == null ? '' : email).trim();
  if (!e || !e.includes('@')) return null;
  const [local, domain] = e.split('@');
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}

// ── Section builders. Each is defensive: a failure degrades THAT section to an
//    explicit error/empty state, never the whole response (the loadSnapshot
//    discipline used by /reports + /command-centre). ──────────────────────────

async function buildFlags(now) {
  const today = now.toISOString().slice(0, 10);
  let overrides = {};
  let previewOverrides = {};
  let rev;
  try {
    const doc = await readBlob(FLAGS_KEY, { flags: {} });
    overrides = doc && doc.flags && typeof doc.flags === 'object' ? doc.flags : {};
    previewOverrides =
      doc && doc.ownerPreview && typeof doc.ownerPreview === 'object' ? doc.ownerPreview : {};
    if (doc && Number.isFinite(doc.__rev)) rev = doc.__rev;
  } catch {
    overrides = {};
    previewOverrides = {};
  }

  const items = [];
  for (const f of listFlags()) {
    // resolved          = the CUSTOMER baseline (isFlagOn, no viewer).
    // resolvedForOwner  = what the OWNER sees live (env > owner-preview > baseline).
    let resolved;
    try {
      resolved = await isFlagOn(f.key);
    } catch {
      resolved = f.default;
    }
    let resolvedForOwner;
    try {
      resolvedForOwner = await isFlagEnabled(f.key, { role: 'owner' });
    } catch {
      resolvedForOwner = resolved;
    }
    const envVal = parseEnvLike(process.env[envName(f.key)]);
    const ownerPreview =
      typeof previewOverrides[f.key] === 'boolean' ? previewOverrides[f.key] : null;

    // Customer-facing resolution source.
    let source;
    if (envVal !== null) source = 'env';
    else if (typeof overrides[f.key] === 'boolean') source = 'override';
    else source = 'default';
    // Owner-facing source: env wins; else the preview override; else the baseline.
    let ownerSource;
    if (envVal !== null) ownerSource = 'env';
    else if (ownerPreview !== null) ownerSource = 'owner-preview';
    else ownerSource = source;

    const d = daysUntil(f.expires, now);
    let expiryStatus = 'ok';
    if (f.expires < today) expiryStatus = 'expired';
    else if (d !== null && d <= EXPIRING_SOON_DAYS) expiryStatus = 'expiring';

    // #760: board presentation (human label / domain / surface). Null for
    // protected data-plane flags — they render in the read-only "System" group.
    const pres = presentationOf(f.key);
    items.push({
      key: f.key,
      description: f.description,
      default: f.default,
      target: f.target,
      expires: f.expires,
      resolved,
      resolvedForOwner,
      ownerPreview,
      source,
      ownerSource,
      expiryStatus,
      protected: isProtectedFlag(f.key),
      // Protected (data-plane) flags are never toggleable from the UI. Env-pinned
      // flags ARE toggleable:true but the UI renders the control disabled (env
      // wins) — source:'env' carries that signal.
      toggleable: !isProtectedFlag(f.key),
      // #760 Feature Control Board fields (null when unlabelled/protected).
      label: pres ? pres.label : null,
      domain: pres ? pres.domain : null,
      surface: pres ? pres.surface : null,
      killSwitch: !!f.killSwitch,
      core: pres ? !!pres.core : false,
      previewHref: pres && pres.previewHref ? pres.previewHref : null,
    });
  }
  return {
    source: 'feature flag registry + env (FLAG_*) + flags.json override blob',
    rev,
    items,
  };
}

// Per-feature config knobs (#760 PR2) — the runtime-tunable settings the owner
// can adjust. Mirrors buildFlags: every registry entry with its resolved value,
// default, type/constraints, and override source. Read-modify-write lives in the
// companion api/owner-settings.js (this is the read projection only).
async function buildSettings() {
  let stored = {};
  let rev;
  try {
    const doc = await readBlob(SETTINGS_KEY, { settings: {} });
    stored = doc && doc.settings && typeof doc.settings === 'object' ? doc.settings : {};
    if (doc && Number.isFinite(doc.__rev)) rev = doc.__rev;
  } catch {
    stored = {};
  }

  const items = listSettings().map((s) => {
    const raw = stored[s.featureKey] ? stored[s.featureKey][s.key] : undefined;
    const resolved = coerce(s, raw);
    // A valid stored value that survived coercion is a real override.
    const source = raw !== undefined && resolved === raw ? 'override' : 'default';
    return {
      featureKey: s.featureKey,
      key: s.key,
      type: s.type,
      label: s.label,
      description: s.description,
      default: s.default,
      value: resolved,
      source,
      min: s.min ?? null,
      max: s.max ?? null,
      step: s.step ?? null,
      maxLength: s.maxLength ?? null,
      options: s.options ?? null,
      unit: s.unit ?? null,
    };
  });

  return {
    source: 'feature settings registry + feature-settings.json override blob',
    rev,
    items,
  };
}

async function buildHealth(now) {
  const checks = [];

  let blobOk = true;
  try {
    await readBlob(FLAGS_KEY, { flags: {} });
  } catch {
    blobOk = false;
  }
  checks.push({
    id: 'blob',
    label: 'Blob storage',
    status: blobOk ? 'ok' : 'down',
    detail: blobOk ? 'reachable' : 'read failed',
  });

  const secretOk = Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16);
  checks.push({
    id: 'session_secret',
    label: 'Session signing key',
    status: secretOk ? 'ok' : 'misconfigured',
    detail: secretOk ? 'configured' : 'missing or too short',
  });

  let expiredCount = 0;
  try {
    expiredCount = expiredFlags(now).length;
  } catch {
    expiredCount = 0;
  }
  checks.push({
    id: 'flag_expiry',
    label: 'Feature flag expiry',
    status: expiredCount > 0 ? 'warning' : 'ok',
    detail: expiredCount > 0 ? `${expiredCount} expired flag(s)` : 'all within date',
  });

  const hasHardFail = checks.some((c) => c.status === 'down' || c.status === 'misconfigured');
  const hasWarn = checks.some((c) => c.status === 'warning');
  const overall = hasHardFail ? 'needs_attention' : hasWarn ? 'warning' : 'ok';

  return {
    overall,
    checks,
    // #154: escaped errors + client crashes now land in the errors panel; a
    // true error RATE (per-request denominator) is still not instrumented.
    notInstrumented: [
      'Error rate (journal counts escaped errors only — no request denominator)',
      'Endpoint latency (p50/p95)',
      'External uptime probe',
    ],
  };
}

async function readRecentEntries(now) {
  const thisYm = ymOf(now);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevYm = ymOf(prev);
  const [a, b] = await Promise.all([readMonth(prevYm), readMonth(thisYm)]);
  const all = [...(a || []), ...(b || [])];
  all.sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0)); // newest first
  return { all, thisMonth: b || [] };
}

function buildAudit(recent) {
  const entries = recent.all.slice(0, RECENT_AUDIT_LIMIT).map((e) => ({
    id: e.id,
    ts: e.ts,
    action: e.action,
    // actorName/role are owner-visible by design (the owner already sees all
    // staff). targetId + metadata are deliberately omitted — no payloads.
    actorName: e.actorName || null,
    actorRole: e.actorRole || null,
    targetType: e.targetType || null,
    summary: e.summary || '',
  }));
  return {
    source: 'audit log — cross-job journal (audit/<yyyy-mm>.json)',
    available: entries.length > 0,
    entries,
  };
}

function buildUsage(recent, now) {
  const weekAgo = now.getTime() - 7 * 86400000;
  const last7 = recent.all.filter((e) => Date.parse(e.ts) >= weekAgo);
  const actors = new Set(last7.map((e) => e.actorId).filter(Boolean));
  const counts = new Map();
  for (const e of last7) counts.set(e.action, (counts.get(e.action) || 0) + 1);
  const topActions = [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([action, count]) => ({ action, count }));
  return {
    source: 'derived from the audit journal — business actions only',
    auditEvents7d: last7.length,
    distinctActors7d: actors.size,
    monthEntryCount: recent.thisMonth.length,
    monthCap: 5000,
    topActions,
    notInstrumented: [
      'Route / page views',
      'Feature adoption (which dark features get used)',
      'Login / session activity',
      'Time-on-task / abandoned workflows',
    ],
  };
}

// #154: the platform error journal (platform/errors.json) — escaped api/*
// errors from withErrorCapture-wrapped handlers + client render crashes
// reported by src/app/error.tsx. HONEST SCOPE: errors handled inside a route's
// own try/catch are NOT here (still console-only), so counts are a floor,
// never a rate.
const RECENT_ERROR_LIMIT = 50;
const TOP_ERROR_GROUPS = 5;

async function buildErrors(now) {
  const entries = await readErrors();
  const sorted = [...entries].sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0));
  const weekAgo = now.getTime() - 7 * 86400000;
  const count7d = sorted.filter((e) => Date.parse(e.ts) >= weekAgo).length;

  // Group by fingerprint (handler|message|statusCode) — newest entry wins the
  // display fields.
  const groups = new Map();
  for (const e of sorted) {
    const key = e.fingerprint || 'none';
    const g = groups.get(key);
    if (g) {
      g.count += 1;
    } else {
      groups.set(key, {
        fingerprint: key,
        handler: e.handler || 'unknown',
        message: e.message || '',
        source: e.source || 'api',
        count: 1,
        lastSeen: e.ts,
      });
    }
  }
  const topGroups = [...groups.values()]
    .sort((x, y) => y.count - x.count)
    .slice(0, TOP_ERROR_GROUPS);

  const recent = sorted.slice(0, RECENT_ERROR_LIMIT).map((e) => ({
    id: e.id,
    ts: e.ts,
    source: e.source || 'api',
    handler: e.handler || 'unknown',
    message: e.message || '',
    severity: e.severity || 'error',
    statusCode: e.statusCode == null ? null : e.statusCode,
    fingerprint: e.fingerprint || null,
    // stack + metadata deliberately omitted — same no-payloads discipline as
    // the audit panel.
  }));

  return {
    source:
      'platform error journal (platform/errors.json) — escaped api errors ' +
      '(wrapped handlers only) + client render crashes',
    coverageNote:
      'Partial by design: only jobs/data/time-entries/observations are wrapped, ' +
      'and errors handled inside a route are not captured.',
    available: entries.length > 0,
    count7d,
    total: entries.length,
    cap: ERROR_LOG_CAP,
    recent,
    topGroups,
  };
}

// First-pass STATIC coverage matrix. routeExists + accessGuarded are real
// knowledge of the route map; auditTracked is DERIVED from the live audit
// action registry (the namespaces that actually write to the journal);
// usage/errors are honestly "not instrumented".
function buildCoverage() {
  const auditedNamespaces = new Set([...VALID_ACTIONS].map((a) => String(a).split('.')[0]));
  const ns = (n) => (n ? auditedNamespaces.has(n) : false);

  // #154: areas whose PRIMARY api/*.js handlers are wrapped with
  // withErrorCapture (api/jobs.js, api/data.js, api/time-entries.js,
  // api/observations.js). ESCAPED errors only — a route's internal catches
  // still swallow. Areas served by other, unwrapped handlers stay false.
  const ERROR_WRAPPED_AREAS = new Set([
    'Jobs',
    'Hours',
    'Phil — Hours',
    'Observations / RFIs / Snags',
  ]);

  // [area, surface, accessGuarded, auditNamespace|null]
  const defs = [
    ['Command centre', 'BuhlOS', true, null],
    ['Jobs', 'BuhlOS', true, 'job'],
    ['Quotes', 'BuhlOS', true, 'quote'],
    ['Hours', 'BuhlOS', true, 'hours'],
    ['Gear', 'BuhlOS', true, 'gear'],
    ['Employees', 'BuhlOS', true, 'employee'],
    ['QA / ITPs', 'BuhlOS', true, 'itp'],
    ['Materials', 'BuhlOS', true, 'material_request'],
    ['Observations / RFIs / Snags', 'BuhlOS', true, 'observation'],
    ['Reports (owner numbers)', 'BuhlOS', true, null],
    ['Phil — My Day', 'Phil', true, 'evidence'],
    ['Phil — Jobs', 'Phil', true, 'snag'],
    ['Phil — Hours', 'Phil', true, 'hours'],
    ['Phil — Gear', 'Phil', true, 'gear'],
    ['Login / Auth', 'Shared', false, null],
    ['Client portal', 'Client', true, null],
  ];

  const rows = defs.map(([area, surface, accessGuarded, auditNs]) => ({
    area,
    surface,
    routeExists: true,
    accessGuarded,
    auditTracked: ns(auditNs),
    usageTracked: false,
    errorsTracked: ERROR_WRAPPED_AREAS.has(area),
  }));

  return {
    note:
      'First-pass matrix. routeExists + accessGuarded reflect the route map; ' +
      'auditTracked is derived from the live audit-action registry; usage is ' +
      'not instrumented yet; errors marks areas whose primary handlers are ' +
      'wrapped for escaped-error capture (#154) — partial, not full telemetry.',
    rows,
  };
}

function buildProblems(flags, health, usage, meta, now) {
  const problems = [];

  // Hard health failures.
  for (const c of health.checks) {
    if (c.status === 'down' || c.status === 'misconfigured') {
      problems.push({
        severity: 'blocker',
        title: `${c.label}: ${c.detail}`,
        evidence: 'live health probe (/api/owner)',
        why: 'A core dependency is unavailable or misconfigured — the platform is at risk.',
        action: `Investigate ${c.label.toLowerCase()} immediately.`,
      });
    }
  }

  // Expired + expiring flags (real, from the registry).
  for (const f of flags.items) {
    if (f.expiryStatus === 'expired') {
      problems.push({
        severity: 'high',
        title: `Feature flag "${f.key}" is past its expiry (${f.expires})`,
        evidence: 'feature flag registry + check:flag-expiry',
        why: 'Expired flags fail CI and signal dead/forgotten branches that should be removed or consciously extended.',
        action: `Remove "${f.key}" (delete the flag + dead branch) or extend its expiry.`,
      });
    } else if (f.expiryStatus === 'expiring') {
      problems.push({
        severity: 'medium',
        title: `Feature flag "${f.key}" expires soon (${f.expires})`,
        evidence: 'feature flag registry',
        why: 'A flag nearing expiry needs a decision (ship + remove, or extend) before CI breaks.',
        action: `Decide the fate of "${f.key}" before ${f.expires}.`,
      });
    }
  }

  // Honest instrumentation gaps — real product work, surfaced as such.
  problems.push({
    severity: 'not_instrumented',
    title: 'Route / feature usage is not instrumented',
    evidence: 'no analytics store found (the audit journal covers business actions only)',
    why: 'Without usage data you cannot see which surfaces are used, abandoned, or dead.',
    action: 'Add lightweight route-view instrumentation (follow-up issue).',
  });
  // #154: error telemetry now exists but is PARTIAL — say exactly what's
  // covered rather than dropping the line.
  problems.push({
    severity: 'not_instrumented',
    title: 'Error telemetry is partial (escaped errors + client render crashes only)',
    evidence:
      'platform/errors.json — withErrorCapture wraps jobs/data/time-entries/observations; ' +
      'src/app/error.tsx reports page crashes',
    why: 'Errors handled inside a route (its own try/catch) are still only console-logged, so most failed actions remain invisible.',
    action: 'Extend withErrorCapture to remaining handlers and thread captureError into hot catch blocks (follow-up issue).',
  });
  problems.push({
    severity: 'not_instrumented',
    title: 'No login / session activity log',
    evidence: 'the audit journal has no auth.* actions',
    why: 'Who signed in, when, and from where is not recorded.',
    action: 'Add login/session events to the canonical audit journal (follow-up issue).',
  });

  // Owner access durability.
  if (meta.identityBasis === 'email-allowlist') {
    problems.push({
      severity: 'low',
      title: 'Owner Console access is bootstrapped via the email allowlist',
      evidence: 'the signed-in owner holds an admin-tier role, not the dedicated "owner" role',
      why: 'Email-allowlist access is a bootstrap; a stored "owner" role makes the surface durable and auto-routes login.',
      action: 'Set a users.json account role to "owner", or configure OWNER_EMAILS for the intended owners.',
    });
  }

  return problems;
}

function buildNextActions(problems, flags, meta) {
  const actions = [];
  const expiredCount = flags.items.filter((f) => f.expiryStatus === 'expired').length;
  if (expiredCount > 0) {
    actions.push({
      title: `Clear ${expiredCount} expired feature flag(s)`,
      reason: 'Expired flags fail CI and mark dead branches.',
      priority: 'high',
      safeNow: true,
      suggestedIssue: 'Owner Console: remove/extend expired feature flags',
    });
  }
  actions.push({
    title: 'Build an owner-safe runtime feature-flag override API',
    reason: 'Toggling flags without a deploy needs an audited, CAS-guarded, protected-flag-aware write path (none exists yet).',
    priority: 'medium',
    safeNow: false,
    suggestedIssue: 'Owner Console: safe runtime feature flag override API',
  });
  actions.push({
    title: 'Instrument route / feature usage',
    reason: 'The console cannot answer "what is used / abandoned / dead" without it.',
    priority: 'medium',
    safeNow: false,
    suggestedIssue: 'Owner Console: route usage instrumentation',
  });
  actions.push({
    title: 'Extend error capture to the remaining api/* handlers',
    reason:
      'Escaped-error capture (#154) covers jobs/data/time-entries/observations + the client boundary; the other ~35 handlers and in-route catches are still console-only.',
    priority: 'medium',
    safeNow: true,
    suggestedIssue: 'Owner Console: full-coverage error capture',
  });
  actions.push({
    title: 'Record login / session activity in the audit journal',
    reason: 'No record of who signs in, when, or from where.',
    priority: 'low',
    safeNow: false,
    suggestedIssue: 'Owner Console: login/session activity log',
  });
  if (meta.identityBasis === 'email-allowlist') {
    actions.push({
      title: 'Harden owner access (assign the "owner" role / set OWNER_EMAILS)',
      reason: 'Move off email-allowlist bootstrap to a durable, auto-routing owner identity.',
      priority: 'high',
      safeNow: true,
      suggestedIssue: 'Owner Console: owner role hardening',
    });
  }
  return actions;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  // Authenticate (HMAC-verified, fresh users.json, password hash stripped).
  const me = await requireAuth(req, res, {});
  if (!me) return; // 401 already sent

  // Owner-only gate — the authoritative boundary. Fails CLOSED.
  if (!canAccessOwnerConsole(me)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const now = new Date();
  const meta = {
    asOf: now.toISOString(),
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    identityBasis: isOwnerRole(me.role) ? 'owner-role' : 'email-allowlist',
    viewer: {
      role: me.role || null,
      name: me.name || me.username || null,
      email: maskEmail(me.email),
    },
  };

  // Build sections defensively — one failure degrades that section only.
  const safe = async (fn, fallback) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const flags = await safe(() => buildFlags(now), {
    source: 'feature flag registry',
    items: [],
    error: 'flag data unavailable',
  });
  const settings = await safe(() => buildSettings(), {
    source: 'feature settings registry',
    items: [],
    error: 'settings unavailable',
  });
  const health = await safe(() => buildHealth(now), {
    overall: 'needs_attention',
    checks: [{ id: 'probe', label: 'Health probe', status: 'down', detail: 'probe failed' }],
    notInstrumented: [],
  });
  const recent = await safe(() => readRecentEntries(now), { all: [], thisMonth: [] });
  const errors = await safe(() => buildErrors(now), {
    source: 'platform error journal (platform/errors.json)',
    coverageNote: 'error journal unavailable',
    available: false,
    count7d: 0,
    total: 0,
    cap: ERROR_LOG_CAP,
    recent: [],
    topGroups: [],
    error: 'error journal unavailable',
  });
  const audit = buildAudit(recent);
  const usage = buildUsage(recent, now);
  const coverage = await safe(() => buildCoverage(), { note: 'coverage unavailable', rows: [] });
  const problems = buildProblems(flags, health, usage, meta, now);
  const nextActions = buildNextActions(problems, flags, meta);

  return res.status(200).json({
    ok: true,
    meta,
    capabilities: {
      flagToggle: true,
      flagToggleReason:
        'Flags toggle via POST /api/owner-flags (owner-gated, CAS-guarded, audited). ' +
        'Each flag has two dials — customer launch-gate + owner preview. Protected ' +
        'data-plane flags (supabase_*, phil_jobs_summary_read) stay read-only; ' +
        'env-pinned flags (FLAG_*) win and show disabled.',
      settingsWrite: true,
      settingsWriteReason:
        'Config knobs save via PUT /api/owner-settings (owner-gated, CAS-guarded, ' +
        'audited, registry-validated).',
    },
    health,
    flags,
    settings,
    usage,
    errors,
    audit,
    coverage,
    problems,
    nextActions,
  });
};
