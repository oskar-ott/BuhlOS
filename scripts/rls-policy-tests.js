#!/usr/bin/env node
// RLS allow/deny suite for the Phase 1 policy migration (issue #153).
//
//   supabase/migrations/20260703230000_phase1_rls_policies.sql
//   docs/architecture/supabase-rls-access-matrix.md      (the spec)
//   docs/architecture/supabase-rls-identity-bridge-adr.md (the JWT contract)
//
// WHAT THIS IS: an ON-DEMAND script, run by a human against a DEV Supabase
// project AFTER the policy migration has been applied there. It is NOT wired
// into CI, it was NOT run as part of the PR that added it (no live project
// access from that session — the migration merges unapplied), and it REFUSES
// to run against the production project ref.
//
// WHAT IT DOES:
//   1. Service-role seeds fixtures: two tenants; users per tier; jobs with
//      and without assignment incl. draft/archived/soft-deleted; job_members;
//      tasks; time entries; snags (incl. one soft-deleted); an audit_logs row.
//   2. Mints short-TTL HS256 JWTs per tier from the fixture records — the
//      exact claim shape the identity bridge specifies:
//      { sub, role:'authenticated', tier, tenant_id, user_id, iat, exp }.
//   3. Asserts ALLOW and DENY per pilot table for every tier, that anon gets
//      nothing, that a second-tenant JWT sees zero first-tenant rows, that
//      writes are denied to every tier, and that a service-role insert
//      succeeds (the #152/#160 importer regression guard).
//   4. Cleans up all seeded rows (also in failure paths).
//
// USAGE (dev project only):
//   RLS_TEST_SUPABASE_URL=https://<dev-ref>.supabase.co \
//   RLS_TEST_SERVICE_ROLE_KEY=<dev service_role key> \
//   RLS_TEST_ANON_KEY=<dev anon key> \
//   RLS_TEST_JWT_SECRET=<dev JWT secret (legacy HS256)> \
//   node scripts/rls-policy-tests.js
//
// The RLS_TEST_* prefix is deliberate: these are ad-hoc shell variables for
// this script only, distinct from the runtime SUPABASE_* env contract in
// docs/supabase-environment.md (which says SERVICE_ROLE_KEY is not part of
// the app runtime). Requires Node >= 18 (global fetch). No dependencies.

'use strict';

const crypto = require('crypto');

const PROD_REF = 'wetctlrhsycfwhuxlarv';

const URL_BASE = process.env.RLS_TEST_SUPABASE_URL;
const SERVICE_KEY = process.env.RLS_TEST_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.RLS_TEST_ANON_KEY;
const JWT_SECRET = process.env.RLS_TEST_JWT_SECRET;

function fatal(msg) {
  console.error(`rls-policy-tests: ${msg}`);
  process.exit(1);
}

if (!URL_BASE || !SERVICE_KEY || !ANON_KEY || !JWT_SECRET) {
  fatal(
    'missing env. Required: RLS_TEST_SUPABASE_URL, RLS_TEST_SERVICE_ROLE_KEY, RLS_TEST_ANON_KEY, RLS_TEST_JWT_SECRET (see script header).'
  );
}
if (URL_BASE.includes(PROD_REF)) {
  fatal(`refusing to run against the PRODUCTION project (${PROD_REF}). Dev projects only.`);
}

// ── JWT minting (mirrors the identity-bridge ADR claim shape) ──────────────

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Tier mapping mirrors api/_lib/auth.js ADMIN_ROLES / LEADING_HAND_ROLES /
// FIELD_ROLES — policies only ever see the TIER, never the raw role.
const TIER_BY_ROLE = {
  admin: 'admin', boss: 'admin', owner: 'admin', manager: 'admin',
  office: 'admin', pm: 'admin', estimator: 'admin',
  leadinghand: 'leading_hand', leading_hand: 'leading_hand',
  'leading-hand': 'leading_hand', lh: 'leading_hand',
  tradie: 'field', apprentice: 'field', labourer: 'field', electrician: 'field',
  client: 'client',
};

function mintJwt(user) {
  const tier = TIER_BY_ROLE[String(user.role).toLowerCase()];
  if (!tier) throw new Error(`no tier for role ${user.role}`);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: user.id,
      user_id: user.id, // mirror claim per the issue's stated shape
      role: 'authenticated', // PostgREST database role — NOT the tier
      tier,
      tenant_id: user.tenant_id,
      iss: 'buhlos-rls-test',
      iat: now,
      exp: now + 600, // generous for a test run; the bridge itself uses <=60s
    })
  );
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

// ── PostgREST helpers ────────────────────────────────────────────────────────

async function rest(method, path, { token, body, prefer } = {}) {
  const headers = {
    apikey: token ? ANON_KEY : SERVICE_KEY,
    Authorization: `Bearer ${token || SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { status: res.status, json, text };
}

async function anonGet(path) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: res.status, json };
}

async function seed(table, rows) {
  const { status, json, text } = await rest('POST', table, {
    body: rows,
    prefer: 'return=representation',
  });
  if (status !== 201) throw new Error(`seed ${table} failed (${status}): ${text}`);
  return json;
}

// ── assertions ──────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function idSet(rows) {
  return new Set((rows || []).map((r) => r.id));
}
function sameIds(rows, expectedIds) {
  const got = idSet(rows);
  return got.size === expectedIds.length && expectedIds.every((id) => got.has(id));
}

async function expectIds(name, token, path, expectedIds) {
  const { status, json } = await rest('GET', `${path}${path.includes('?') ? '&' : '?'}select=id`, { token });
  if (status !== 200 || !Array.isArray(json)) {
    check(name, false, `status ${status}`);
    return;
  }
  check(name, sameIds(json, expectedIds), `got ${json.length} rows [${[...idSet(json)].join(', ')}]`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const marker = `rls-test-${Date.now()}`;
  console.log(`Seeding fixtures (${marker}) …`);

  // tenants
  const [tenantA, tenantB] = await seed('tenants', [
    { name: 'RLS Test Tenant A', slug: `${marker}-a` },
    { name: 'RLS Test Tenant B', slug: `${marker}-b` },
  ]);
  const tenants = [tenantA.id, tenantB.id];

  try {
    // users — raw roles on purpose: minting must collapse them to tiers
    // ('boss' → admin, 'leadinghand' → leading_hand, 'tradie' → field).
    const [uAdmin, uLh, uField, uMate, uClient, uB] = await seed('user_profiles', [
      { tenant_id: tenantA.id, username: `${marker}-boss`, role: 'boss' },
      { tenant_id: tenantA.id, username: `${marker}-lh`, role: 'leadinghand' },
      { tenant_id: tenantA.id, username: `${marker}-tradie`, role: 'tradie' },
      { tenant_id: tenantA.id, username: `${marker}-sparky`, role: 'electrician' },
      { tenant_id: tenantA.id, username: `${marker}-client`, role: 'client' },
      { tenant_id: tenantB.id, username: `${marker}-b-tradie`, role: 'tradie' },
    ]);

    // jobs — the assignment × status grid the matrix gates on
    const [jobActive, jobUnassigned, jobDraft, jobArchived, jobDeleted, jobClient, jobB] =
      await seed('jobs', [
        { tenant_id: tenantA.id, name: `${marker} active assigned`, status: 'active' },
        { tenant_id: tenantA.id, name: `${marker} active unassigned`, status: 'active' },
        { tenant_id: tenantA.id, name: `${marker} draft assigned`, status: 'draft' },
        { tenant_id: tenantA.id, name: `${marker} archived assigned`, status: 'archived' },
        { tenant_id: tenantA.id, name: `${marker} soft-deleted assigned`, status: 'active', deleted_at: new Date().toISOString() },
        { tenant_id: tenantA.id, name: `${marker} client job`, status: 'active', client_user_id: uClient.id },
        { tenant_id: tenantB.id, name: `${marker} tenant-b job`, status: 'active' },
      ]);

    // memberships — field worker is deliberately a member of draft/archived/
    // soft-deleted jobs too: policies must STILL hide those jobs.
    const members = await seed('job_members', [
      { tenant_id: tenantA.id, job_id: jobActive.id, user_id: uLh.id, role: 'lead' },
      { tenant_id: tenantA.id, job_id: jobActive.id, user_id: uField.id },
      { tenant_id: tenantA.id, job_id: jobDraft.id, user_id: uField.id },
      { tenant_id: tenantA.id, job_id: jobArchived.id, user_id: uField.id },
      { tenant_id: tenantA.id, job_id: jobDeleted.id, user_id: uField.id },
      { tenant_id: tenantB.id, job_id: jobB.id, user_id: uB.id },
    ]);
    const activeMemberRows = members.filter((m) => m.job_id === jobActive.id).map((m) => m.id);

    const [tActive, tUnassigned, tDraft] = await seed('tasks', [
      { tenant_id: tenantA.id, job_id: jobActive.id, stage: 'roughIn', name: `${marker} task active` },
      { tenant_id: tenantA.id, job_id: jobUnassigned.id, stage: 'roughIn', name: `${marker} task unassigned` },
      { tenant_id: tenantA.id, job_id: jobDraft.id, stage: 'roughIn', name: `${marker} task draft` },
    ]);

    const [teLh, teField, teMate] = await seed('time_entries', [
      { tenant_id: tenantA.id, user_id: uLh.id, work_date: '2026-06-29', total_hours: 8, ordinary_hours: 8, overtime_hours: 0 },
      { tenant_id: tenantA.id, user_id: uField.id, work_date: '2026-06-29', total_hours: 8, ordinary_hours: 8, overtime_hours: 0 },
      { tenant_id: tenantA.id, user_id: uMate.id, work_date: '2026-06-29', total_hours: 8, ordinary_hours: 8, overtime_hours: 0 },
    ]);

    const [snagActive, snagUnassigned, snagDeleted, snagB] = await seed('snags', [
      { tenant_id: tenantA.id, job_id: jobActive.id, title: `${marker} snag active`, source: 'phil' },
      { tenant_id: tenantA.id, job_id: jobUnassigned.id, title: `${marker} snag unassigned`, source: 'admin' },
      { tenant_id: tenantA.id, job_id: jobActive.id, title: `${marker} snag deleted`, source: 'phil', deleted_at: new Date().toISOString() },
      { tenant_id: tenantB.id, job_id: jobB.id, title: `${marker} snag tenant-b`, source: 'phil' },
    ]);

    const [auditRow] = await seed('audit_logs', [
      { tenant_id: tenantA.id, action: 'rls.test', entity_type: 'rls_test', entity_id: marker },
    ]);

    const tok = {
      admin: mintJwt(uAdmin),
      lh: mintJwt(uLh),
      field: mintJwt(uField),
      client: mintJwt(uClient),
      tenantB: mintJwt(uB),
    };

    // ── admin tier: whole tenant incl. draft/archived/soft-deleted ─────────
    console.log('\nadmin tier (role "boss" → tier admin)');
    await expectIds('admin sees ALL tenant-A jobs (draft+archived+deleted incl.), no tenant-B', tok.admin, 'jobs', [
      jobActive.id, jobUnassigned.id, jobDraft.id, jobArchived.id, jobDeleted.id, jobClient.id,
    ]);
    await expectIds('admin sees all tenant-A snags incl. soft-deleted', tok.admin, 'snags',
      [snagActive.id, snagUnassigned.id, snagDeleted.id]);
    await expectIds('admin sees audit_logs', tok.admin, `audit_logs?entity_id=eq.${marker}`, [auditRow.id]);
    await expectIds('admin sees all tenant-A time entries', tok.admin, 'time_entries',
      [teLh.id, teField.id, teMate.id]);

    // ── leading-hand tier ───────────────────────────────────────────────────
    console.log('\nleading_hand tier (role "leadinghand")');
    await expectIds('LH sees only the live assigned job', tok.lh, 'jobs', [jobActive.id]);
    await expectIds('LH sees only tasks of that job', tok.lh, 'tasks', [tActive.id]);
    await expectIds('LH sees only that job\'s snags (soft-deleted excluded)', tok.lh, 'snags', [snagActive.id]);
    await expectIds('LH sees only OWN time entries', tok.lh, 'time_entries', [teLh.id]);
    await expectIds('LH sees the crew of their job only', tok.lh, 'job_members', activeMemberRows);
    await expectIds('LH gets ZERO audit_logs (admin-or-nothing)', tok.lh, 'audit_logs', []);
    await expectIds('LH gets ZERO payroll_runs (admin-or-nothing)', tok.lh, 'payroll_runs', []);

    // ── field tier ───────────────────────────────────────────────────────────
    console.log('\nfield tier (role "tradie")');
    await expectIds(
      'field sees only the live assigned job (draft/archived/soft-deleted memberships hidden)',
      tok.field, 'jobs', [jobActive.id]
    );
    await expectIds('field sees only tasks of live assigned jobs', tok.field, 'tasks', [tActive.id]);
    await expectIds('field sees only OWN time entries', tok.field, 'time_entries', [teField.id]);
    {
      const { status, json } = await rest('GET', 'user_profiles?select=id', { token: tok.field });
      const ids = idSet(json);
      check(
        'field reads the tenant directory (live profiles, no tenant-B)',
        status === 200 && ids.has(uLh.id) && ids.has(uAdmin.id) && !ids.has(uB.id),
        `status ${status}, ${json && json.length} rows`
      );
    }

    // ── client tier ──────────────────────────────────────────────────────────
    console.log('\nclient tier');
    await expectIds('client sees only their linked live job', tok.client, 'jobs', [jobClient.id]);
    await expectIds('client gets ZERO tasks', tok.client, 'tasks', []);
    await expectIds('client gets ZERO snags', tok.client, 'snags', []);
    await expectIds('client gets ZERO time entries', tok.client, 'time_entries', []);
    await expectIds('client sees only their own profile', tok.client, 'user_profiles', [uClient.id]);

    // ── tenant isolation ─────────────────────────────────────────────────────
    console.log('\nsecond-tenant JWT');
    await expectIds('tenant-B user sees only tenant-B jobs', tok.tenantB, 'jobs', [jobB.id]);
    await expectIds('tenant-B user sees only tenant-B snags', tok.tenantB, 'snags', [snagB.id]);
    await expectIds('tenant-B user sees ZERO tenant-A time entries', tok.tenantB, 'time_entries', []);
    await expectIds('tenant-B user sees ZERO tenant-A tasks', tok.tenantB, 'tasks', []);

    // ── anon gets nothing ────────────────────────────────────────────────────
    console.log('\nanon');
    for (const table of ['jobs', 'tasks', 'time_entries', 'snags', 'job_members', 'audit_logs']) {
      const { status, json } = await anonGet(`${table}?select=id&limit=5`);
      const ok = (status === 200 && Array.isArray(json) && json.length === 0) || status === 401 || status === 403;
      check(`anon gets nothing from ${table}`, ok, `status ${status}, ${Array.isArray(json) ? json.length : '?'} rows`);
    }

    // ── writes are denied to every tier (reads-only phase) ─────────────────
    console.log('\nwrite denial (no write policies exist)');
    {
      const { status } = await rest('POST', 'snags', {
        token: tok.field,
        body: { tenant_id: tenantA.id, job_id: jobActive.id, title: `${marker} forbidden`, source: 'phil' },
        prefer: 'return=representation',
      });
      check('field INSERT into snags denied', status >= 400, `status ${status}`);
    }
    {
      const { status, json } = await rest('PATCH', `tasks?id=eq.${tActive.id}`, {
        token: tok.lh,
        body: { status: 'complete' },
        prefer: 'return=representation',
      });
      const ok = status >= 400 || status === 204 || (Array.isArray(json) && json.length === 0);
      check('LH UPDATE on tasks denied (zero rows updatable)', ok, `status ${status}`);
    }
    {
      const { status } = await rest('POST', 'jobs', {
        token: tok.admin,
        body: { tenant_id: tenantA.id, name: `${marker} forbidden job`, status: 'draft' },
        prefer: 'return=representation',
      });
      check('even admin-tier INSERT denied (writes are service-role only)', status >= 400, `status ${status}`);
    }

    // ── service role unaffected (importer / #152 / #160 regression guard) ──
    console.log('\nservice role');
    {
      const rows = await seed('snags', [
        { tenant_id: tenantA.id, job_id: jobActive.id, title: `${marker} service insert`, source: 'system' },
      ]);
      check('service-role INSERT succeeds (RLS bypassed)', rows.length === 1);
    }
  } finally {
    console.log('\nCleaning up …');
    const tenantFilter = `tenant_id=in.(${tenants.join(',')})`;
    // reverse dependency order; ignore individual failures but report them
    for (const table of [
      'audit_logs', 'snags', 'time_entry_allocations', 'time_entries',
      'tasks', 'job_members', 'jobs', 'user_profiles',
    ]) {
      const { status, text } = await rest('DELETE', `${table}?${tenantFilter}`);
      if (status >= 300) console.error(`  cleanup ${table} -> ${status}: ${text}`);
    }
    const { status: tStatus, text: tText } = await rest('DELETE', `tenants?id=in.(${tenants.join(',')})`);
    if (tStatus >= 300) console.error(`  cleanup tenants -> ${tStatus}: ${tText}`);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('rls-policy-tests: aborted —', err.message || err);
  process.exit(1);
});
