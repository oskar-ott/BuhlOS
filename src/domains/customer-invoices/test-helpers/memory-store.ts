/**
 * In-memory stand-in for api/_lib/customer-invoices/store.js with the real
 * store's contract: the same function names, the same StoreConflict reasons,
 * the same mapped (camelCase, integer-cent) row shapes. The handler tests run
 * the REAL handler against this; the real SQL is proven separately by
 * customer-invoices-store.pg.test.ts.
 */

export type Row = Record<string, unknown> & {
  id: string;
  jobId: string;
  state: string;
  version: number;
};

type Profile = Record<string, unknown> & {
  jobId: string;
  retentionBp: number;
  xeroContactId: string | null;
  xeroContactName: string | null;
  externalTenantId: string | null;
  version: number;
  touched: number;
};

type Settings = Record<string, unknown> & { externalTenantId: string; version: number };

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

export function createMemoryStore() {
  class StoreConflict extends Error {
    reason: string;
    constructor(reason: string) {
      super(reason);
      this.name = "StoreConflict";
      this.reason = reason;
    }
  }
  const rows: Row[] = [];
  const profiles = new Map<string, Profile>();
  const settings = new Map<string, Settings>();
  const events: Array<{ event: string; jobId: string | null; invoiceId: string | null; attemptId?: string | null; detail?: unknown }> = [];
  const attempts: Array<Record<string, unknown>> = [];
  let n = 0;
  let clock = 0;
  let tenant: { id: string; slug: string } | null = { id: "t1", slug: "buhl" };
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const blank = {
    seq: null, invoiceNumber: null, grossCents: null, retentionCents: null, netCents: null,
    xeroStatus: null, xeroSubtotalCents: null, xeroTotalCents: null, xeroAmountPaidCents: null,
    xeroAmountDueCents: null, xeroDueDate: null, dueDate: null,
    // the real store maps every column, so an unsent row has these as null
    xeroInvoiceId: null, failureCategory: null, failureDetail: null, drift: null,
    invoiceDate: null, reference: null, externalTenantId: null, xeroContactId: null,
  };
  function guard(id: string, expectedVersion: number): Row {
    const r = rows.find((x) => x.id === id);
    if (!r) throw new StoreConflict("not_found");
    if (r.state !== "planned") throw new StoreConflict("not_planned");
    if (r.version !== expectedVersion) throw new StoreConflict("version");
    return r;
  }
  const publicProfile = (p: Profile) => {
    const { touched: _touched, ...rest } = p;
    void _touched;
    return clone(rest);
  };

  return {
    StoreConflict,
    rows,
    events,
    profiles,
    settings,
    setTenant(t: typeof tenant) { tenant = t; },
    async resolveTenant() { return tenant; },

    async getProfile(_sql: unknown, _t: string, jobId: string) {
      const p = profiles.get(jobId);
      return p ? publicProfile(p) : null;
    },
    async saveProfile(_sql: unknown, _t: string, jobId: string, patch: Record<string, unknown>, o: { expectedVersion: number | null }) {
      const cur = profiles.get(jobId);
      if (!cur) {
        if (o.expectedVersion != null) throw new StoreConflict("version");
        const p: Profile = {
          jobId, xeroContactId: null, xeroContactName: null, externalTenantId: null, retentionBp: 0,
          ...patch, version: 1, touched: ++clock,
        };
        profiles.set(jobId, p);
        events.push({ event: "profile_updated", jobId, invoiceId: null });
        return publicProfile(p);
      }
      if (cur.version !== o.expectedVersion) throw new StoreConflict("version");
      Object.assign(cur, patch, { version: cur.version + 1, touched: ++clock });
      events.push({ event: "profile_updated", jobId, invoiceId: null });
      return publicProfile(cur);
    },
    async latestContactAmongJobs(_sql: unknown, _t: string, jobIds: string[], externalTenantId: string | null) {
      if (!jobIds.length || !externalTenantId) return null;
      const hit = [...profiles.values()]
        .filter((p) => jobIds.includes(p.jobId) && p.externalTenantId === externalTenantId && p.xeroContactId)
        .sort((a, b) => b.touched - a.touched)[0];
      return hit ? { id: hit.xeroContactId, name: hit.xeroContactName, fromJobId: hit.jobId } : null;
    },

    async getSettings(_sql: unknown, _t: string, externalTenantId: string | null) {
      if (!externalTenantId) return null;
      const s = settings.get(externalTenantId);
      return s ? clone(s) : null;
    },
    async saveSettings(_sql: unknown, _t: string, externalTenantId: string, v: Record<string, unknown>, o: { expectedVersion: number | null }) {
      const cur = settings.get(externalTenantId);
      if (!cur) {
        if (o.expectedVersion != null) throw new StoreConflict("version");
        const s: Settings = { externalTenantId, ...v, version: 1 };
        settings.set(externalTenantId, s);
        events.push({ event: "settings_updated", jobId: null, invoiceId: null });
        return clone(s);
      }
      if (cur.version !== o.expectedVersion) throw new StoreConflict("version");
      Object.assign(cur, v, { version: cur.version + 1 });
      events.push({ event: "settings_updated", jobId: null, invoiceId: null });
      return clone(cur);
    },
    settingsComplete(s: Record<string, unknown> | null) {
      return !!(s && s.salesAccountCode && s.taxType && Number.isInteger(s.taxRateBp) && Number.isInteger(s.paymentTermsDays));
    },

    async listJobInvoices(_sql: unknown, _t: string, jobId: string) {
      return clone(rows.filter((r) => r.jobId === jobId && r.state !== "cancelled"));
    },
    async getInvoice(_sql: unknown, _t: string, id: string) {
      const r = rows.find((x) => x.id === id);
      return r ? clone(r) : null;
    },
    async createStage(_sql: unknown, _t: string, jobId: string, s: Record<string, unknown>) {
      const r = { ...blank, ...s, id: uuid(), jobId, state: "planned", version: 1 } as Row;
      rows.push(r);
      events.push({ event: "created", jobId, invoiceId: r.id });
      return clone(r);
    },
    async updateStage(_sql: unknown, _t: string, id: string, s: Record<string, unknown>, o: { expectedVersion: number }) {
      const r = guard(id, o.expectedVersion);
      Object.assign(r, s, { version: r.version + 1 });
      events.push({ event: "edited", jobId: r.jobId, invoiceId: r.id });
      return clone(r);
    },
    async removeStage(_sql: unknown, _t: string, id: string, o: { expectedVersion: number }) {
      const r = guard(id, o.expectedVersion);
      rows.splice(rows.indexOf(r), 1);
      events.push({ event: "removed", jobId: r.jobId, invoiceId: null });
      return { id, jobId: r.jobId };
    },

    // ── sending (#1150) — the same guards the SQL has ──────────────────────
    attempts,
    async insertEvent(_sql: unknown, _t: string, e: { event: string; jobId?: string | null; invoiceId?: string | null; attemptId?: string | null; detail?: unknown }) {
      events.push({ event: e.event, jobId: e.jobId ?? null, invoiceId: e.invoiceId ?? null, attemptId: e.attemptId ?? null, detail: e.detail });
    },
    async peekNextSeq(_sql: unknown, _t: string, jobId: string) {
      return Math.max(0, ...rows.filter((r) => r.jobId === jobId).map((r) => Number(r.seq) || 0)) + 1;
    },
    async beginSend(_sql: unknown, _t: string, id: string, snap: Record<string, unknown> & { jobCode: string; build: (n: string) => string }, o: { expectedVersion: number; actor?: { name?: string } }) {
      const r = guard(id, o.expectedVersion);
      const seq = Math.max(0, ...rows.filter((x) => x.jobId === r.jobId).map((x) => Number(x.seq) || 0)) + 1;
      const invoiceNumber = `${snap.jobCode}-${seq}`;
      if (rows.some((x) => x.invoiceNumber === invoiceNumber)) throw new StoreConflict("number_clash");
      const { jobCode: _code, build, ...frozen } = snap;
      void _code;
      Object.assign(r, frozen, {
        state: "sending", seq, invoiceNumber, contentHash: build(invoiceNumber),
        failureCategory: null, failureDetail: null, sentBy: o.actor?.name ?? null, version: r.version + 1,
      });
      return clone(r);
    },
    async insertAttempt(_sql: unknown, _t: string, a: Record<string, unknown>) {
      attempts.push(clone(a));
    },
    async listAttempts(_sql: unknown, _t: string, invoiceId: string) {
      return clone(attempts.filter((a) => a.invoiceId === invoiceId));
    },
    async markAccepted(_sql: unknown, _t: string, id: string, p: { xeroInvoiceId: string; mirror: Record<string, unknown>; drift: unknown }) {
      const r = rows.find((x) => x.id === id);
      if (!r || !(r.state === "sending" || r.state === "failed") || r.seq == null) return null;
      const m = p.mirror;
      Object.assign(r, {
        state: "sent", xeroInvoiceId: p.xeroInvoiceId, drift: p.drift ?? null, failureCategory: null, failureDetail: null,
        xeroStatus: m.status, xeroSubtotalCents: m.subtotalCents, xeroTaxCents: m.taxCents, xeroTotalCents: m.totalCents,
        xeroAmountDueCents: m.amountDueCents, xeroAmountPaidCents: m.amountPaidCents, xeroAmountCreditedCents: m.amountCreditedCents,
        xeroDueDate: m.dueDate, xeroFullyPaidOn: m.fullyPaidOn, version: r.version + 1,
      });
      return clone(r);
    },
    async markFailed(_sql: unknown, _t: string, id: string, f: { category: string; detail: string | null }) {
      const r = rows.find((x) => x.id === id);
      if (!r || !(r.state === "sending" || r.state === "failed")) return null;
      Object.assign(r, { state: "failed", failureCategory: f.category, failureDetail: f.detail ?? null, version: r.version + 1 });
      return clone(r);
    },
    async noteUnknown(_sql: unknown, _t: string, id: string, f: { category: string; detail: string | null }) {
      const r = rows.find((x) => x.id === id);
      if (!r || r.state !== "sending") return null;
      Object.assign(r, { failureCategory: f.category, failureDetail: f.detail ?? null, version: r.version + 1 });
      return clone(r);
    },
    async resetToPlanned(_sql: unknown, _t: string, id: string) {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new StoreConflict("not_found");
      if (!(r.state === "sending" || r.state === "failed") || r.xeroInvoiceId) throw new StoreConflict("not_resettable");
      Object.assign(r, {
        ...blank, state: "planned", contentHash: null, externalTenantId: null, xeroContactId: null, xeroContactName: null,
        invoiceDate: null, reference: null, failureCategory: null, failureDetail: null, version: r.version + 1,
      });
      events.push({ event: "edited", jobId: r.jobId, invoiceId: r.id });
      return clone(r);
    },
    async raiseAgain(_sql: unknown, _t: string, id: string) {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new StoreConflict("not_found");
      if (r.state !== "failed" || r.xeroInvoiceId) throw new StoreConflict("not_raisable");
      r.state = "cancelled";
      r.version += 1;
      const fresh = {
        ...blank, id: uuid(), jobId: r.jobId, kind: r.kind, title: r.title, basis: r.basis, percentBp: r.percentBp,
        amountCents: r.amountCents, extraLines: clone(r.extraLines), retentionBp: null, plannedDate: r.plannedDate ?? null,
        note: r.note ?? null, state: "planned", version: 1,
      } as Row;
      rows.push(fresh);
      events.push({ event: "raised_again", jobId: r.jobId, invoiceId: r.id });
      return clone(fresh);
    },
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
