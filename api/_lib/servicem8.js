'use strict';

// ServiceM8 REST client (daily job-sync integration).
//
// BuhlOS jobs carry a `serviceM8JobId` basics field, but the link has always
// been typed in by hand — when the office books a job in ServiceM8 and forgets
// to add it here, a field worker physically cannot log hours against it
// (time-entries only accepts ACTIVE jobs in the worker's assignedJobIds).
// This client is the read side of the daily sync-check that closes that gap.
//
// Auth: ServiceM8 "private application" API key in the X-Api-Key header
// (env SERVICEM8_API_KEY). No key configured → serviceM8Configured() is false
// and the sync skips cleanly; this module never throws for a missing key.
//
// Scope: READ-ONLY against ServiceM8 — jobs + companies GETs only. Nothing is
// ever written back to ServiceM8.

const API_BASE = 'https://api.servicem8.com/api_1.0';

// Only jobs the crew can actually be sent to. Quotes / Completed /
// Unsuccessful ServiceM8 jobs must never auto-create a BuhlOS job.
const SYNC_STATUS = 'Work Order';

function serviceM8Configured(env = process.env) {
  return !!(env.SERVICEM8_API_KEY && String(env.SERVICEM8_API_KEY).trim());
}

async function sm8Get(path, env, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetchImpl(`${API_BASE}/${path}`, {
      headers: {
        'X-Api-Key': String(env.SERVICEM8_API_KEY).trim(),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ServiceM8 ${path.split('?')[0]} responded ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(`ServiceM8 ${path.split('?')[0]} returned a non-list payload`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the active "Work Order" jobs from ServiceM8, with client (company)
 * names resolved. Throws on network/auth/API failure — the caller records
 * the error in the sync report rather than pretending "all matched".
 *
 * @returns {Promise<Array<{uuid:string, number:string, status:string,
 *   address:string, company:string, description:string}>>}
 */
async function fetchServiceM8ActiveJobs({ env = process.env, fetchImpl = fetch } = {}) {
  const filter = encodeURIComponent(`active eq 1 and status eq '${SYNC_STATUS}'`);
  const [jobs, companies] = await Promise.all([
    sm8Get(`job.json?%24filter=${filter}`, env, fetchImpl),
    // No filter: an archived client can still own an active job.
    sm8Get('company.json', env, fetchImpl),
  ]);
  const companyName = new Map(
    companies
      .filter((c) => c && c.uuid)
      .map((c) => [String(c.uuid), String(c.name || '').trim()]),
  );
  return jobs
    .filter((j) => j && j.uuid)
    .map((j) => ({
      uuid: String(j.uuid),
      number: String(j.generated_job_id ?? '').trim(),
      status: String(j.status || ''),
      address: String(j.job_address || '').trim(),
      company: companyName.get(String(j.company_uuid || '')) || '',
      description: String(j.job_description || '').trim(),
    }));
}

module.exports = { serviceM8Configured, fetchServiceM8ActiveJobs, SYNC_STATUS };
