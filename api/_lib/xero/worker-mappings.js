// Worker ↔ Xero employee mapping store + board (#248).
//
// The rules (payroll-boundary ADR + the issue's audit ruling):
//   * a link exists ONLY after an explicit admin confirm — suggestions
//     (../xero/employee-matching.js) and legacy free-text ids never link
//   * links store the immutable Xero EmployeeID plus confirm-time name and
//     employment-status snapshots (drift stays displayable)
//   * 1:1 both directions — a conflicting link is a NAMED error, never a
//     silent overwrite
//   * org-scoped: links confirmed against another Xero organisation render
//     as org-mismatched, never silently hidden or silently reused
//   * unmapped workers are the export blockers #249's pre-flight names —
//     mappingReadiness() is that seam
//
// Storage: public.xero_mappings (epic-wide store — #611/#254 add kinds).
// Postgres reads are fresh by construction, resolving the audit comment's
// 5s-blob-cache hazard for just-confirmed links.
//
// Roster rule (RECORDED DECISION, per the issue's open question): the board
// lists live hours-tracked workers (isHoursTrackedWorker), PLUS any disabled
// worker that still has a confirmed link or a legacy xeroEmployeeId — flagged
// "disabled" so a final-pay week is never invisible here. Full
// disabled-with-unexported-approved-hours detection stays with #249's
// pre-flight, which derives blockers from the entries themselves and so can
// never miss a worker this roster filter would.

const { readBlob } = require('../blob');
const { getDb } = require('../supabase-db');
const store = require('./token-store');
const { XeroError } = require('./errors');
const { isHoursTrackedWorker, isFieldRole, isLeadingHandRole, isDisabledUser } = require('../auth');
const { suggestEmployeeMatches } = require('./employee-matching');

const KIND = 'worker_employee';

function db(sql, mode) {
  return sql || getDb({ mode: mode || 'write' });
}

async function currentConnection(deps = {}) {
  const s = deps.store || store;
  const row = await s.getConnection({ sql: deps.sql });
  if (!row) throw new XeroError('not_connected');
  if (row.status === 'pending_selection' || !row.external_tenant_id) {
    throw new XeroError('pending_selection');
  }
  return row;
}

async function loadEmployeeCache(sql, conn) {
  const rows = await sql`
    select xero_id, name, active, payload
    from public.xero_reference_items
    where tenant_id = ${conn.tenant_id}
      and external_tenant_id = ${conn.external_tenant_id}
      and kind = 'employee'
    order by name
  `;
  return rows.map((r) => ({
    xeroId: r.xero_id,
    name: r.name,
    active: r.active,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
  }));
}

async function lastEmployeeSync(sql, conn) {
  const rows = await sql`
    select status, item_count, error_category, created_at
    from public.xero_reference_syncs
    where tenant_id = ${conn.tenant_id}
      and external_tenant_id = ${conn.external_tenant_id}
      and sync_group = 'employees'
    order by created_at desc
    limit 1
  `;
  return rows.length ? rows[0] : null;
}

async function loadMappings(sql, conn) {
  // ALL of the tenant's worker links, every org — mismatches must be visible.
  return sql`
    select * from public.xero_mappings
    where tenant_id = ${conn.tenant_id} and kind = ${KIND}
  `;
}

/** Workers the mapping board lists (see roster rule above). */
function boardWorkers(users, { mappedIds, legacyIds }) {
  const out = [];
  for (const u of users) {
    if (isHoursTrackedWorker(u)) {
      out.push({ user: u, disabled: false });
      continue;
    }
    // disabled field/LH accounts stay visible while payroll links linger
    const fieldish = isFieldRole(u.role) || isLeadingHandRole(u.role);
    if (fieldish && isDisabledUser(u) && (mappedIds.has(u.id) || (u.xeroEmployeeId && String(u.xeroEmployeeId).trim()))) {
      out.push({ user: u, disabled: true });
    }
  }
  return out;
}

/**
 * The mapping board: every listed worker with their link state, suggestion,
 * legacy-id validity, and org-mismatch flags — plus the employee picker list
 * and honest cache provenance (empty-because-failed ≠ org-has-none).
 */
async function getWorkerMappingBoard(deps = {}) {
  const sql = db(deps.sql, 'read');
  const conn = await currentConnection(deps);
  const [usersDoc, employees, mappings, employeesSync] = await Promise.all([
    (deps.readBlob || readBlob)('users.json', { users: [] }),
    loadEmployeeCache(sql, conn),
    loadMappings(sql, conn),
    lastEmployeeSync(sql, conn),
  ]);

  const mappingByWorker = new Map(mappings.map((m) => [m.local_id, m]));
  const users = Array.isArray(usersDoc.users) ? usersDoc.users : [];
  const workers = boardWorkers(users, {
    mappedIds: new Set(mappings.map((m) => m.local_id)),
    legacyIds: null,
  });

  const employeeById = new Map(employees.map((e) => [e.xeroId, e]));
  const suggestions = suggestEmployeeMatches(
    workers.map(({ user }) => ({
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      xeroEmployeeId: user.xeroEmployeeId,
    })),
    employees
  );
  const nameOf = new Map(users.map((u) => [u.id, u.name || u.username || u.id]));

  const rows = workers.map(({ user, disabled }) => {
    const m = mappingByWorker.get(user.id) || null;
    const s = suggestions.get(user.id) || { suggestion: null, invalidLegacyId: null, legacyConflictWith: [] };
    const cacheEmployee = m ? employeeById.get(m.xero_id) || null : null;
    return {
      workerId: user.id,
      workerName: user.name || user.username || user.id,
      workerEmail: user.email || null,
      disabled,
      mapping: m
        ? {
            employeeId: m.xero_id,
            employeeName: m.xero_name_snapshot,
            statusSnapshot: m.xero_status_snapshot,
            linkedByName: m.linked_by_name,
            linkedAt: m.created_at,
            source: m.source,
            // reconnect-to-a-different-org: link visible, honestly mismatched
            orgMismatch: m.external_tenant_id !== conn.external_tenant_id,
            // Xero-side drift since confirm time (terminated / renamed / gone)
            employeeMissingFromCache: m.external_tenant_id === conn.external_tenant_id && !cacheEmployee,
            employeeInactive: Boolean(cacheEmployee && !cacheEmployee.active),
          }
        : null,
      suggestion: m ? null : s.suggestion,
      invalidLegacyId: s.invalidLegacyId,
      legacyConflictWith: s.legacyConflictWith.map((id) => nameOf.get(id) || id),
    };
  });

  return {
    organisationName: conn.external_tenant_name,
    workers: rows,
    unmappedCount: rows.filter((r) => !r.mapping && !r.disabled).length,
    employees: employees.map((e) => ({
      xeroId: e.xeroId,
      name: e.name,
      active: e.active,
      email: (e.payload && e.payload.email) || null,
      status: (e.payload && e.payload.status) || null,
    })),
    employeeCache: {
      count: employees.length,
      lastSync: employeesSync
        ? { at: employeesSync.created_at, status: employeesSync.status, errorCategory: employeesSync.error_category }
        : null,
      // zero employees is only trustworthy after a successful sync (P7)
      trustworthy: Boolean(employeesSync && employeesSync.status === 'ok'),
    },
  };
}

/**
 * Confirm (or re-confirm to a different employee = remap) one link.
 * Throws XeroError('conflict') with the existing holder named when the
 * employee is already linked to another worker.
 */
async function confirmMapping({ workerId, employeeId, source, actor, deps = {} }) {
  const sql = db(deps.sql, 'write');
  const conn = await currentConnection(deps);

  const usersDoc = await (deps.readBlob || readBlob)('users.json', { users: [] });
  const worker = (usersDoc.users || []).find((u) => u.id === workerId);
  if (!worker) throw new XeroError('validation', { detail: 'unknown_worker' });

  const employees = await loadEmployeeCache(sql, conn);
  const employee = employees.find((e) => e.xeroId === employeeId);
  if (!employee) throw new XeroError('validation', { detail: 'unknown_employee' });

  const mappings = await loadMappings(sql, conn);
  const sameOrg = mappings.filter((m) => m.external_tenant_id === conn.external_tenant_id);
  const holder = sameOrg.find((m) => m.xero_id === employeeId && m.local_id !== workerId);
  if (holder) {
    const holderName = ((usersDoc.users || []).find((u) => u.id === holder.local_id) || {}).name || holder.local_id;
    const err = new XeroError('conflict', { detail: 'employee_already_linked' });
    err.conflictWith = { workerId: holder.local_id, workerName: holderName };
    throw err;
  }

  const previous = sameOrg.find((m) => m.local_id === workerId) || null;
  const status = (employee.payload && employee.payload.status) || (employee.active ? 'ACTIVE' : 'TERMINATED');
  const src = ['manual', 'email_suggestion', 'name_suggestion', 'legacy_import'].includes(source) ? source : 'manual';

  const rows = await sql`
    insert into public.xero_mappings (
      tenant_id, external_tenant_id, kind, local_id, xero_id,
      xero_name_snapshot, xero_status_snapshot, source,
      linked_by_legacy_id, linked_by_name
    ) values (
      ${conn.tenant_id}, ${conn.external_tenant_id}, ${KIND}, ${workerId}, ${employeeId},
      ${employee.name}, ${status}, ${src},
      ${actor ? String(actor.id) : null}, ${actor ? String(actor.name || actor.username || '') : null}
    )
    on conflict (tenant_id, external_tenant_id, kind, local_id) do update set
      xero_id = excluded.xero_id,
      xero_name_snapshot = excluded.xero_name_snapshot,
      xero_status_snapshot = excluded.xero_status_snapshot,
      source = excluded.source,
      linked_by_legacy_id = excluded.linked_by_legacy_id,
      linked_by_name = excluded.linked_by_name
    returning *
  `;

  return {
    mapping: rows[0],
    workerName: worker.name || worker.username || workerId,
    employeeName: employee.name,
    employeeInactive: !employee.active,
    previousEmployeeId: previous ? previous.xero_id : null,
  };
}

/** Remove one link (hard delete — the audit journal keeps the history). */
async function removeMapping({ workerId, deps = {} }) {
  const sql = db(deps.sql, 'write');
  const conn = await currentConnection(deps);
  const rows = await sql`
    delete from public.xero_mappings
    where tenant_id = ${conn.tenant_id}
      and external_tenant_id = ${conn.external_tenant_id}
      and kind = ${KIND}
      and local_id = ${workerId}
    returning *
  `;
  return rows.length ? rows[0] : null;
}

/**
 * The #249/#894 seam: which of the given worker ids are unmapped for the
 * CURRENT organisation. Fresh read every call — never cached.
 */
async function mappingReadiness(workerIds, deps = {}) {
  const sql = db(deps.sql, 'read');
  const conn = await currentConnection(deps);
  const rows = await sql`
    select local_id, xero_id from public.xero_mappings
    where tenant_id = ${conn.tenant_id}
      and external_tenant_id = ${conn.external_tenant_id}
      and kind = ${KIND}
  `;
  const byWorker = new Map(rows.map((r) => [r.local_id, r.xero_id]));
  return workerIds.map((id) => ({
    workerId: id,
    employeeId: byWorker.get(id) || null,
    mapped: byWorker.has(id),
  }));
}

module.exports = {
  KIND,
  getWorkerMappingBoard,
  confirmMapping,
  removeMapping,
  mappingReadiness,
};
