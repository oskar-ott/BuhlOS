'use strict';

// Job numbers issued by BuhlOS (#1152, job_code_auto — dark).
//
// A job's short reference is `IV` + 4 digits. BuhlOS issues the next one
// starting at IV4000 (owner decision 2026-11-22, replacing the earlier "7000
// range"), above ServiceM8's numbers, and runs to IV9999 — the end of the
// 4-digit format. The counter and the claims live in Postgres because
// jobs.json has no compare-and-swap and can be read stale: two creates at the
// same instant must get two different numbers.
//
//   issueNextCode   the next free number, claimed for a job — atomically
//   claimTypedCode  a number a person typed: claim it, or say who has it
//   releaseClaim    undo a TYPED claim whose job was never written
//
// Rules:
//   * A number is NEVER made up. If Postgres can't be reached the caller gets
//     a typed error and creates nothing.
//   * A number is never reused: an issued claim stays even if the job write
//     fails afterwards (the number is simply skipped).
//   * The issuer starts at IV4000 and takes the lowest number that is neither
//     on a job (the codes the caller read from jobs.json) nor claimed — so the
//     7000-series numbers the phone made up before this are simply skipped.
//
// Schema: supabase/migrations/20261124100000_job_codes.sql.

const TENANT_SLUG = 'buhl';
const SERIES = 'IV';
const FIRST = 4000;
const LAST = 9999;
const CODE_RE = /^IV(\d{4})$/;

/** No number could be issued. `reason` says why; nothing was created. */
class JobCodeError extends Error {
  /** @param {'unavailable'|'unprovisioned'|'range_exhausted'} reason */
  constructor(reason, cause) {
    super(`job code: ${reason}`);
    this.name = 'JobCodeError';
    this.reason = reason;
    if (cause) this.cause = cause;
  }
}

const codeOf = (n) => `IV${String(n).padStart(4, '0')}`;

/** "iv7013 " → "IV7013"; anything that isn't IV + 4 digits → null. */
function normaliseCode(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

/** The numbers in the issued range that the given codes already use. */
function usedNumbers(codes) {
  const used = new Set();
  for (const raw of codes || []) {
    const c = normaliseCode(raw);
    if (!c) continue;
    const n = Number(c.slice(2));
    if (n >= FIRST && n <= LAST) used.add(n);
  }
  return used;
}

async function resolveTenant(sql) {
  const t = await sql`select id from public.tenants where slug = ${TENANT_SLUG}`;
  return t.length ? { id: t[0].id } : null;
}

/**
 * Issue the next free number and claim it for `jobId`, in one transaction.
 * The counter row is locked for the duration, so concurrent callers queue and
 * each gets a different number.
 *
 * @param {object} sql  postgres.js client
 * @param {string} tenantId
 * @param {{ existingCodes?: string[], jobId?: string|null, actor?: { id?: string, name?: string }|null }} [opts]
 *   existingCodes — every code on a job today (from jobs.json); skipped.
 * @returns {Promise<string>} e.g. "IV4013"
 * @throws {JobCodeError} range_exhausted when IV9999 has been passed
 */
async function issueNextCode(sql, tenantId, opts = {}) {
  const used = usedNumbers(opts.existingCodes);
  const actor = opts.actor || null;
  return sql.begin(async (tx) => {
    await tx`
      insert into public.job_code_counters (tenant_id, series, next_value)
      values (${tenantId}, ${SERIES}, ${FIRST})
      on conflict (tenant_id, series) do nothing`;
    const cur = await tx`
      select next_value from public.job_code_counters
      where tenant_id = ${tenantId} and series = ${SERIES}
      for update`;
    let n = Number(cur[0].next_value);
    // Codes are fixed width, so a string comparison orders them correctly.
    const claimedRows = await tx`
      select code from public.job_code_claims
      where tenant_id = ${tenantId} and code >= ${codeOf(n)} and code <= ${codeOf(LAST)}`;
    const claimed = new Set(claimedRows.map((r) => r.code));
    while (n <= LAST && (used.has(n) || claimed.has(codeOf(n)))) n += 1;
    if (n > LAST) throw new JobCodeError('range_exhausted');
    const code = codeOf(n);
    await tx`
      insert into public.job_code_claims (tenant_id, code, job_legacy_id, source, claimed_by_legacy_id, claimed_by_name)
      values (${tenantId}, ${code}, ${opts.jobId || null}, 'issued', ${(actor && actor.id) || null}, ${(actor && actor.name) || null})`;
    await tx`
      update public.job_code_counters set next_value = ${n + 1}, updated_at = now()
      where tenant_id = ${tenantId} and series = ${SERIES}`;
    return code;
  });
}

/**
 * Claim a number a person typed. Idempotent for the same job (a retried
 * create). Returns `{ ok: false, heldBy }` when another job already has it.
 *
 * @returns {Promise<{ ok: true, fresh: boolean } | { ok: false, heldBy: string|null }>}
 */
async function claimTypedCode(sql, tenantId, code, opts = {}) {
  const actor = opts.actor || null;
  const jobId = opts.jobId || null;
  const ins = await sql`
    insert into public.job_code_claims (tenant_id, code, job_legacy_id, source, claimed_by_legacy_id, claimed_by_name)
    values (${tenantId}, ${code}, ${jobId}, 'typed', ${(actor && actor.id) || null}, ${(actor && actor.name) || null})
    on conflict (tenant_id, code) do nothing
    returning id`;
  if (ins.length) return { ok: true, fresh: true };
  const held = await sql`
    select job_legacy_id from public.job_code_claims
    where tenant_id = ${tenantId} and code = ${code}`;
  const heldBy = held.length ? held[0].job_legacy_id : null;
  if (jobId && heldBy === jobId) return { ok: true, fresh: false };
  return { ok: false, heldBy };
}

/** Undo a TYPED claim made for a job that was then never written. */
async function releaseClaim(sql, tenantId, code, jobId) {
  await sql`
    delete from public.job_code_claims
    where tenant_id = ${tenantId} and code = ${code} and source = 'typed' and job_legacy_id = ${jobId}`;
}

/**
 * The seam job creation uses: open the database, find the tenant, and wrap
 * every failure in a JobCodeError so a caller never sees a driver error (and
 * never falls through to a made-up number).
 *
 * @param {{ getDb?: Function }} [deps]
 */
function connect(deps = {}) {
  const getDb = deps.getDb || require('./supabase-db').getDb;
  let ready = null;
  async function open() {
    if (!ready) {
      ready = (async () => {
        let sql;
        let tenant;
        try {
          sql = getDb({ mode: 'write' });
          tenant = await resolveTenant(sql);
        } catch (e) {
          throw new JobCodeError('unavailable', e);
        }
        if (!tenant) throw new JobCodeError('unprovisioned');
        return { sql, tenantId: tenant.id };
      })();
    }
    return ready;
  }
  const wrap = async (fn) => {
    const { sql, tenantId } = await open();
    try {
      return await fn(sql, tenantId);
    } catch (e) {
      if (e instanceof JobCodeError) throw e;
      throw new JobCodeError('unavailable', e);
    }
  };
  // A typed claim doesn't take the counter lock, so it can land on the very
  // number an issue was about to claim. That issue rolls back whole (unique
  // violation) and is simply tried again: the number is now claimed and skipped.
  const issueWithRetry = async (sql, tenantId, opts) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await issueNextCode(sql, tenantId, opts);
      } catch (e) {
        if (!(e && e.code === '23505') || attempt >= 3) throw e;
      }
    }
  };
  return {
    issue: (opts) => wrap((sql, tenantId) => issueWithRetry(sql, tenantId, opts)),
    claimTyped: (code, opts) => wrap((sql, tenantId) => claimTypedCode(sql, tenantId, code, opts)),
    release: (code, jobId) => wrap((sql, tenantId) => releaseClaim(sql, tenantId, code, jobId)),
  };
}

/** The sentence a person sees when a number couldn't be issued. */
function issueFailureMessage(err) {
  if (err && err.reason === 'range_exhausted') {
    return 'All the job numbers up to IV9999 are used. Nothing was created — tell the office.';
  }
  return "Couldn't get the next job number just now, so nothing was created. Try again, or type a job number instead.";
}

module.exports = {
  SERIES, FIRST, LAST,
  JobCodeError,
  codeOf, normaliseCode, usedNumbers,
  resolveTenant, issueNextCode, claimTypedCode, releaseClaim,
  connect, issueFailureMessage,
};
