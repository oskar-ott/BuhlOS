/**
 * In-memory implementation of api/_lib/invoices/store.js — the SAME function
 * surface and return shapes, no Postgres. Handler / pipeline / webhook tests
 * inject it through require.cache so the real handlers run end to end against
 * a store whose rules (one active allocation, provider-identity replay,
 * checksum + supplier/number lookups, claim/backoff) are enforced in JS.
 * The SQL store itself is exercised by invoices-store.pg.test.ts against the
 * dev project when INVOICES_PG_TEST=1.
 */

type Row = Record<string, unknown>;
/** Loose call signature for injected store functions in tests. */
export type StoreFn = (...args: unknown[]) => Promise<unknown>;

export interface MemoryStore {
  invoices: Row[];
  documents: Row[];
  allocations: Row[];
  events: Row[];
  attempts: Row[];
  inbound: Row[];
  lines: Row[];
  learned: Row[];
  [k: string]: unknown;
}

let seq = 0;
const uuid = () => {
  seq += 1;
  const hex = seq.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
};
const now = () => new Date().toISOString();

function inv(row: Row) {
  return row;
}

export function createMemoryStore(opts: { tenantId?: string; jobUuids?: Record<string, string> } = {}): MemoryStore {
  const tenantId = opts.tenantId ?? "11111111-1111-4111-8111-111111111111";
  const store: MemoryStore = { invoices: [], documents: [], allocations: [], events: [], attempts: [], inbound: [], lines: [], learned: [] };
  const supplierPrefs = new Map<string, { alwaysReview: boolean; setBy: string | null; setAt: string | null }>();
  const MAX_ATTEMPTS = 3;

  const byId = (id: string) => store.invoices.find((r) => r.id === id) ?? null;
  const detailOf = (id: string) => {
    const invoice = byId(id);
    if (!invoice) return null;
    return {
      invoice: { ...invoice },
      documents: store.documents.filter((d) => d.invoiceId === id).map((d) => {
        const rest = { ...d };
        delete rest.blobUrl;
        delete rest.blobPathname;
        return rest;
      }),
      allocations: store.allocations.filter((a) => a.invoiceId === id).map((a) => ({ ...a })),
      events: store.events.filter((e) => e.invoiceId === id).map((e) => ({ ...e })),
      attempts: store.attempts.filter((a) => a.invoiceId === id).map((a) => ({ ...a })),
      lines: store.lines.filter((l) => l.invoiceId === id).map((l) => ({ ...l })),
    };
  };

  function baseInvoice(input: Row): Row {
    return {
      id: uuid(),
      status: (input.status as string) || "received",
      source: input.source,
      documentType: "unknown",
      supplierName: null,
      supplierKey: null,
      supplierAbn: null,
      supplierInvoiceNumber: null,
      invoiceDate: null,
      currency: "AUD",
      subtotalCents: null,
      gstCents: null,
      totalCents: null,
      totalsConsistent: null,
      ivReferenceRaw: null,
      ivReference: null,
      ivCandidates: [],
      matchedJobId: (input.matchedJobId as string) || null,
      matchStatus: (input.matchStatus as string) || "none",
      matchReason: (input.matchReason as Row) || null,
      reviewReasons: Array.isArray(input.reviewReasons) ? input.reviewReasons : [],
      failureCode: null,
      extractionMethod: null,
      fields: {},
      excerpt: null,
      attemptCount: 0,
      nextAttemptAt: null,
      duplicateOfId: null,
      duplicateReason: null,
      sourceEmailId: (input.sourceEmailId as string) || null,
      sourceMessageId: (input.sourceMessageId as string) || null,
      sourceSubject: (input.sourceSubject as string) || null,
      sourceFrom: (input.sourceFrom as string) || null,
      sourceLinks: Array.isArray(input.sourceLinks) ? input.sourceLinks : [],
      sourceTextExcerpt: (input.sourceTextExcerpt as string) || null,
      createdBy: (input.createdBy as Row | null)?.name ?? null,
      createdByLegacyId: (input.createdBy as Row | null)?.id ?? null,
      paidPersonally: input.paidPersonally === true,
      workerNote: (input.workerNote as string) || null,
      reviewedAt: null,
      reviewedBy: null,
      confirmedAt: null,
      confirmedBy: null,
      excludedReason: null,
      linesTotalCents: null,
      linesConsistent: null,
      archivedAt: null,
      autoConfirmEligible: false,
      autoConfirmAt: null,
      autoConfirmChecks: [],
      heldAt: null,
      heldBy: null,
      createdAt: now(),
      updatedAt: now(),
    };
  }

  const insertEvent = async (_sql: unknown, _t: string, invoiceId: string, e: Row) => {
    const actor = e.actor as Row | null;
    store.events.push({ id: uuid(), invoiceId, event: e.event, actor: actor?.name ?? null, actorRole: actor?.role ?? null, detail: e.detail ?? {}, at: now() });
  };

  Object.assign(store, {
    TENANT_SLUG: "buhl",
    MAX_ATTEMPTS,
    resolveTenant: async () => ({ id: tenantId, slug: "buhl" }),
    resolveJobUuid: async (_s: unknown, _t: string, jobId: string) => (opts.jobUuids && opts.jobUuids[jobId]) || null,
    createInvoice: async (_s: unknown, _t: string, input: Row) => {
      const row = baseInvoice(input);
      store.invoices.push(row);
      return inv({ ...row });
    },
    createInvoiceWithDocument: async (_s: unknown, t: string, invoiceInput: Row, docInput: Row) => {
      if (docInput.providerEmailId && docInput.providerAttachmentId) {
        const dup = store.documents.find((d) => d.providerEmailId === docInput.providerEmailId && d.providerAttachmentId === docInput.providerAttachmentId);
        if (dup) return null;
      }
      const row = baseInvoice(invoiceInput);
      store.invoices.push(row);
      const doc = { id: uuid(), invoiceId: row.id, kind: "pdf", ...docInput, byteSize: docInput.byteSize, pageCount: null, hasTextLayer: null, uploadedBy: (docInput.uploadedBy as Row | null)?.name ?? null, createdAt: now() };
      store.documents.push(doc);
      await insertEvent(null, t, row.id as string, { event: invoiceInput.source === "email" ? "received" : "uploaded", actor: invoiceInput.createdBy ?? null, detail: { filename: docInput.filename } });
      return { invoice: { ...row }, document: { ...doc } };
    },
    getInvoiceRow: async (_s: unknown, _t: string, id: string) => {
      const r = byId(id);
      return r ? { ...r } : null;
    },
    getInvoiceDetail: async (_s: unknown, _t: string, id: string) => detailOf(id),
    getDocumentWithBlob: async (_s: unknown, _t: string, invoiceId: string, documentId: string | null) => {
      const d = store.documents.find((x) => x.invoiceId === invoiceId && (!documentId || x.id === documentId));
      return d ? { ...d } : null;
    },
    listInvoices: async (_s: unknown, _t: string, f: Row = {}) => {
      const statuses = Array.isArray(f.status) ? (f.status as string[]) : f.status ? [f.status as string] : [];
      const like = (hay: unknown, needle: string) => String(hay ?? "").toLowerCase().includes(needle.toLowerCase());
      let rows = store.invoices.filter((r) => {
        if (statuses.length && !statuses.includes(r.status as string)) return false;
        if (f.supplier && r.supplierKey !== f.supplier && !like(r.supplierName, f.supplier as string)) return false;
        if (f.jobId && r.matchedJobId !== f.jobId) return false;
        if (f.autoConfirm === "pending" && !(r.autoConfirmEligible && r.autoConfirmAt && !r.heldAt && r.status === "matched")) return false;
        const d = (r.invoiceDate as string | null) ?? String(r.createdAt).slice(0, 10);
        if (f.from && d < (f.from as string)) return false;
        if (f.to && d > (f.to as string)) return false;
        if (f.q && !(like(r.supplierName, f.q as string) || like(r.supplierInvoiceNumber, f.q as string) || like(r.ivReference, f.q as string) || like(r.matchedJobId, f.q as string) || like(r.sourceSubject, f.q as string))) return false;
        return true;
      });
      rows = rows.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const limit = Math.min(100, Math.max(1, Number(f.limit) || 25));
      const page = Math.max(1, Number(f.page) || 1);
      return { rows: rows.slice((page - 1) * limit, page * limit).map((r) => ({ ...r })), total: rows.length, page, limit };
    },
    countsByStatus: async () => {
      const out: Record<string, number> = {};
      for (const r of store.invoices) out[r.status as string] = (out[r.status as string] ?? 0) + 1;
      return out;
    },
    listSuppliers: async () => {
      const m = new Map<string, { key: string; name: string | null; count: number }>();
      for (const r of store.invoices) {
        if (!r.supplierKey) continue;
        const k = r.supplierKey as string;
        const e = m.get(k) ?? { key: k, name: r.supplierName as string, count: 0 };
        e.count += 1;
        m.set(k, e);
      }
      return [...m.values()];
    },
    applyExtraction: async (_s: unknown, _t: string, id: string, p: Row) => {
      const r = byId(id);
      if (!r) return null;
      Object.assign(r, {
        supplierName: p.supplierName ?? null, supplierKey: p.supplierKey ?? null, supplierAbn: p.supplierAbn ?? null,
        supplierInvoiceNumber: p.supplierInvoiceNumber ?? null, documentType: p.documentType || "unknown", invoiceDate: p.invoiceDate ?? null,
        currency: p.currency || "AUD", subtotalCents: p.subtotalCents ?? null, gstCents: p.gstCents ?? null, totalCents: p.totalCents ?? null,
        totalsConsistent: p.totalsConsistent ?? null, ivReferenceRaw: p.ivReferenceRaw ?? null, ivReference: p.ivReference ?? null,
        ivCandidates: p.ivCandidates ?? [], matchedJobId: p.matchedJobId ?? null, matchStatus: p.matchStatus || "none", matchReason: p.matchReason ?? null,
        status: p.status, reviewReasons: p.reviewReasons ?? [], failureCode: p.failureCode ?? null, extractionMethod: p.extractionMethod ?? null,
        fields: p.fields ?? {}, excerpt: p.excerpt ?? null, duplicateOfId: p.duplicateOfId ?? null, duplicateReason: p.duplicateReason ?? null,
        excludedReason: p.excludedReason ?? null, linesTotalCents: p.linesTotalCents ?? null, linesConsistent: p.linesConsistent ?? null, nextAttemptAt: null, updatedAt: now(),
      });
      return { ...r };
    },
    updateInvoiceFields: async (_s: unknown, _t: string, id: string, p: Row) => {
      const r = byId(id);
      if (!r) return null;
      const keys = ["supplierName", "supplierKey", "supplierInvoiceNumber", "documentType", "invoiceDate", "subtotalCents", "gstCents", "totalCents", "totalsConsistent", "ivReferenceRaw", "ivReference", "matchedJobId", "matchStatus", "matchReason", "status", "reviewReasons", "fields"];
      for (const k of keys) {
        if (p[k] === undefined) continue;
        if (["supplierName", "supplierKey", "documentType", "matchStatus", "status"].includes(k) && p[k] === null) continue; // coalesce semantics
        r[k] = p[k];
      }
      const actor = p.actor as Row | undefined;
      r.reviewedAt = now();
      r.reviewedBy = actor?.name ?? null;
      r.autoConfirmAt = null;
      r.autoConfirmEligible = false;
      r.updatedAt = now();
      return { ...r };
    },
    setStatus: async (_s: unknown, _t: string, id: string, status: string, extra: Row = {}) => {
      const r = byId(id);
      if (!r) return null;
      r.status = status;
      if (extra.excludedReason !== undefined) r.excludedReason = extra.excludedReason;
      if (extra.duplicateOfId !== undefined) r.duplicateOfId = extra.duplicateOfId;
      if (extra.duplicateReason !== undefined) r.duplicateReason = extra.duplicateReason;
      if (status === "archived") r.archivedAt = now();
      else if (extra.clearArchive) r.archivedAt = null;
      if (extra.failureCode !== undefined) r.failureCode = extra.failureCode;
      if (extra.nextAttemptAt !== undefined) r.nextAttemptAt = extra.nextAttemptAt;
      if (extra.actor) { r.reviewedAt = now(); r.reviewedBy = (extra.actor as Row).name ?? null; }
      r.autoConfirmAt = null;
      r.updatedAt = now();
      return { ...r };
    },
    addDocument: async (_s: unknown, _t: string, d: Row) => {
      if (d.providerEmailId && d.providerAttachmentId && store.documents.some((x) => x.providerEmailId === d.providerEmailId && x.providerAttachmentId === d.providerAttachmentId)) return null;
      const doc = { id: uuid(), kind: "pdf", ...d, pageCount: d.pageCount ?? null, hasTextLayer: d.hasTextLayer ?? null, uploadedBy: (d.uploadedBy as Row | null)?.name ?? null, createdAt: now() };
      store.documents.push(doc);
      return { ...doc };
    },
    updateDocumentText: async (_s: unknown, _t: string, documentId: string, { pageCount, hasTextLayer }: Row) => {
      const d = store.documents.find((x) => x.id === documentId);
      if (d) { d.pageCount = pageCount ?? null; d.hasTextLayer = hasTextLayer ?? null; }
    },
    findDocumentByProvider: async (_s: unknown, _t: string, emailId: string, attId: string) => {
      const d = store.documents.find((x) => x.providerEmailId === emailId && x.providerAttachmentId === attId);
      return d ? { ...d } : null;
    },
    findInvoicesByChecksum: async (_s: unknown, _t: string, sha: string, exclude: string) => {
      const ids = new Set(store.documents.filter((d) => d.sha256 === sha && d.invoiceId !== exclude).map((d) => d.invoiceId));
      return store.invoices.filter((r) => ids.has(r.id)).map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt }));
    },
    findInvoicesBySupplierNumber: async (_s: unknown, _t: string, key: string, number: string, exclude: string) =>
      store.invoices
        .filter((r) => r.id !== exclude && r.supplierKey === key && String(r.supplierInvoiceNumber ?? "").toUpperCase().replace(/\s+/g, "") === number)
        .map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt })),
    listSupplierInvoices: async (_s: unknown, _t: string, key: string, exclude: string) =>
      store.invoices
        .filter((r) => r.id !== exclude && r.supplierKey === key && r.supplierInvoiceNumber)
        .map((r) => ({ id: r.id, supplierInvoiceNumber: r.supplierInvoiceNumber, status: r.status, documentType: r.documentType, subtotalCents: r.subtotalCents ?? null, totalCents: r.totalCents ?? null })),
    claimPending: async (_s: unknown, _t: string, { limit = 3 }: { limit?: number } = {}) => {
      const due = store.invoices.filter((r) => (r.attemptCount as number) < MAX_ATTEMPTS && (r.status === "received" && (!r.nextAttemptAt || (r.nextAttemptAt as string) <= now())));
      const claimed = due.slice(0, limit);
      for (const r of claimed) { r.status = "processing"; r.attemptCount = (r.attemptCount as number) + 1; }
      return claimed.map((r) => ({ ...r }));
    },
    claimOne: async (_s: unknown, _t: string, id: string, { resetAttempts = false } = {}) => {
      const r = byId(id);
      if (!r) return null;
      r.status = "processing";
      r.attemptCount = resetAttempts ? 1 : (r.attemptCount as number) + 1;
      return { ...r };
    },
    startAttempt: async (_s: unknown, _t: string, invoiceId: string, trigger: string) => {
      const attemptNo = store.attempts.filter((a) => a.invoiceId === invoiceId).length + 1;
      const a = { id: uuid(), invoiceId, attemptNo, trigger, startedAt: now(), finishedAt: null, outcome: null, failureCode: null, extractionMethod: null };
      store.attempts.push(a);
      return { id: a.id, attemptNo };
    },
    finishAttempt: async (_s: unknown, attemptId: string, { outcome, failureCode, extractionMethod }: Row) => {
      const a = store.attempts.find((x) => x.id === attemptId);
      if (a) Object.assign(a, { finishedAt: now(), outcome, failureCode: failureCode ?? null, extractionMethod: extractionMethod ?? null });
    },
    confirmAllocation: async (_s: unknown, t: string, invoiceId: string, a: Row) => {
      const existing = store.allocations.find((x) => x.invoiceId === invoiceId && x.status === "active");
      if (existing) {
        if (existing.jobId === a.jobLegacyId && existing.amountCents === a.amountCents) return { allocation: { ...existing }, alreadyConfirmed: true };
        return { allocation: { ...existing }, conflict: true };
      }
      const actor = a.actor as Row | undefined;
      const row = { id: uuid(), invoiceId, jobId: a.jobLegacyId, amountCents: a.amountCents, gstCents: a.gstCents ?? null, totalCents: a.totalCents ?? null, status: "active", confirmedBy: actor?.name ?? null, confirmedAt: now(), reversedAt: null, reversedBy: null, reversalReason: null };
      store.allocations.push(row);
      const r = byId(invoiceId)!;
      Object.assign(r, { status: "confirmed", matchedJobId: a.jobLegacyId, matchStatus: a.matchStatus || "manual", confirmedAt: now(), confirmedBy: actor?.name ?? null, confirmedByLegacyId: actor?.id ?? null, reviewedAt: now(), reviewedBy: actor?.name ?? null, autoConfirmAt: null });
      await insertEvent(null, t, invoiceId, { event: "confirmed", actor, detail: { jobId: a.jobLegacyId, amountCents: a.amountCents } });
      return { allocation: { ...row }, alreadyConfirmed: false };
    },
    transitionWithReversal: async (_s: unknown, t: string, invoiceId: string, { status, actor, event, detail, extra }: Row) => {
      const act = actor as Row | undefined;
      const active = store.allocations.find((x) => x.invoiceId === invoiceId && x.status === "active");
      let reversed = null;
      if (active) { Object.assign(active, { status: "reversed", reversedAt: now(), reversedBy: act?.name ?? null, reversalReason: status }); reversed = { ...active }; }
      const invoice = await (store.setStatus as StoreFn)(null, t, invoiceId, status, { ...((extra as Row) || {}), actor });
      await insertEvent(null, t, invoiceId, { event, actor, detail: { ...((detail as Row) || {}), reversedAllocationId: reversed ? reversed.id : null } });
      return { invoice, reversed };
    },
    reassignAllocation: async (_s: unknown, t: string, invoiceId: string, a: Row) => {
      const act = a.actor as Row | undefined;
      const active = store.allocations.find((x) => x.invoiceId === invoiceId && x.status === "active");
      let previous = null;
      if (active) { Object.assign(active, { status: "reversed", reversedAt: now(), reversedBy: act?.name ?? null, reversalReason: "reassigned" }); previous = { ...active }; }
      const row = { id: uuid(), invoiceId, jobId: a.jobLegacyId, amountCents: a.amountCents, gstCents: a.gstCents ?? null, totalCents: a.totalCents ?? null, status: "active", confirmedBy: act?.name ?? null, confirmedAt: now(), reversedAt: null, reversedBy: null, reversalReason: null };
      store.allocations.push(row);
      const r = byId(invoiceId)!;
      Object.assign(r, { matchedJobId: a.jobLegacyId, matchStatus: "manual", reviewedAt: now(), reviewedBy: act?.name ?? null });
      await insertEvent(null, t, invoiceId, { event: "reassigned", actor: a.actor, detail: { fromJobId: previous ? previous.jobId : null, toJobId: a.jobLegacyId, amountCents: a.amountCents } });
      return { allocation: { ...row }, previous };
    },
    jobSummary: async (_s: unknown, _t: string, jobId: string) => {
      const active = store.allocations.filter((x) => x.jobId === jobId && x.status === "active");
      return {
        jobId,
        confirmedCents: active.reduce((n, x) => n + (x.amountCents as number), 0),
        confirmedCount: active.length,
        awaitingCount: store.invoices.filter((r) => r.matchedJobId === jobId && ["matched", "needs_review"].includes(r.status as string)).length,
      };
    },
    jobSummaries: async (_s: unknown, _t: string, ids: string[]) => {
      const out: Record<string, { confirmedCents: number; confirmedCount: number }> = {};
      for (const id of ids) {
        const active = store.allocations.filter((x) => x.jobId === id && x.status === "active");
        if (active.length) out[id] = { confirmedCents: active.reduce((n, x) => n + (x.amountCents as number), 0), confirmedCount: active.length };
      }
      return out;
    },
    insertEvent,
    supplierHumanConfirmedCount: async (_s: unknown, _t: string, key: string) =>
      store.invoices.filter((r) => r.supplierKey === key && r.status === "confirmed" && r.confirmedByLegacyId !== "__auto__").length,
    supplierConfirmedOnJob: async (_s: unknown, _t: string, key: string, jobId: string) =>
      store.allocations.some((a) => a.jobId === jobId && a.status === "active" && store.invoices.some((r) => r.id === a.invoiceId && r.supplierKey === key && ["invoice", "tax_invoice"].includes(r.documentType as string))),
    getSupplierPref: async (_s: unknown, _t: string, key: string) => supplierPrefs.get(key) ?? { alwaysReview: false, setBy: null, setAt: null },
    setSupplierPref: async (_s: unknown, _t: string, key: string, { alwaysReview, actor }: Row) => {
      const v = { alwaysReview: !!alwaysReview, setBy: (actor as Row | null)?.name as string ?? null, setAt: now() };
      supplierPrefs.set(key, v);
      return v;
    },
    scheduleAutoConfirm: async (_s: unknown, _t: string, id: string, { eligible, checks, at }: Row) => {
      const r = byId(id);
      if (!r || r.status !== "matched") return null;
      r.autoConfirmEligible = !!eligible; r.autoConfirmChecks = checks ?? []; r.autoConfirmAt = at ?? null;
      return { ...r };
    },
    holdInvoice: async (_s: unknown, _t: string, id: string, actor: Row) => {
      const r = byId(id);
      if (!r) return null;
      r.autoConfirmAt = null; r.heldAt = now(); r.heldBy = actor?.name ?? null;
      return { ...r };
    },
    claimAutoConfirmDue: async (_s: unknown, _t: string, { limit = 10, now: at }: { limit?: number; now?: string } = {}) => {
      const cutoff = at ?? now();
      const due = store.invoices.filter((r) => r.status === "matched" && r.autoConfirmEligible && !r.heldAt && r.autoConfirmAt && (r.autoConfirmAt as string) <= cutoff).slice(0, limit);
      for (const r of due) r.autoConfirmAt = null;
      return due.map((r) => ({ ...r }));
    },
    digestStats: async (_s: unknown, _t: string, { since }: { since: string }) => {
      const rowOf = (r: Row, amount: unknown) => ({ id: r.id, supplierName: r.supplierName, supplierInvoiceNumber: r.supplierInvoiceNumber, matchedJobId: r.matchedJobId, amountCents: amount });
      const inv = (id: unknown) => store.invoices.find((r) => r.id === id)!;
      return {
        capturedCount: store.invoices.filter((r) => (r.createdAt as string) >= since).length,
        autoBooked: store.allocations.filter((a) => a.confirmedBy === "BuhlOS (auto)").map((a) => rowOf(inv(a.invoiceId), a.amountCents)),
        humanBooked: store.allocations.filter((a) => a.confirmedBy !== "BuhlOS (auto)" && a.status === "active").map((a) => rowOf(inv(a.invoiceId), a.amountCents)),
        pending: store.invoices.filter((r) => ["needs_review", "matched"].includes(r.status as string) && (!r.autoConfirmAt || r.heldAt)).map((r) => rowOf(r, r.subtotalCents)),
        bookingSoon: store.invoices.filter((r) => r.status === "matched" && r.autoConfirmEligible && r.autoConfirmAt && !r.heldAt).map((r) => rowOf(r, r.subtotalCents)),
        failedCount: store.invoices.filter((r) => r.status === "failed").length,
        setAsideCount: store.invoices.filter((r) => r.status === "excluded" && String(r.excludedReason ?? "").startsWith("not_an_invoice:") && (r.createdAt as string) >= since).length,
        stuckCount: 0,
        lastReceivedAt: store.inbound.length ? (store.inbound[store.inbound.length - 1]!.createdAt as string) : null,
        everReceived: store.inbound.length > 0,
      };
    },
    replaceInvoiceLines: async (_s: unknown, _t: string, invoiceId: string, lines: Row[]) => {
      store.lines = store.lines.filter((l) => l.invoiceId !== invoiceId);
      for (const l of lines) store.lines.push({ id: uuid(), invoiceId, category: "other", categorySource: "rule", confidence: "medium", unit: null, quantity: null, unitPriceCents: null, lineTotalCents: null, ...l, updatedAt: now() });
    },
    listInvoiceLines: async (_s: unknown, _t: string, invoiceId: string) => store.lines.filter((l) => l.invoiceId === invoiceId).map((l) => ({ ...l })),
    updateInvoiceLine: async (_s: unknown, _t: string, invoiceId: string, lineNo: number, patch: Row) => {
      const l = store.lines.find((x) => x.invoiceId === invoiceId && x.lineNo === lineNo);
      if (!l) return null;
      if (patch.category != null) { l.category = patch.category; l.categorySource = "manual"; }
      if (patch.description != null) l.description = patch.description;
      if (patch.descriptionKey != null) l.descriptionKey = patch.descriptionKey;
      l.updatedAt = now();
      return { ...l };
    },
    learnedCategories: async (_s: unknown, _t: string, supplierKey: string | null, keys: string[]) => {
      const out: Record<string, string> = {};
      for (const k of keys) {
        const own = store.learned.find((r) => r.descriptionKey === k && r.supplierKey === (supplierKey || ""));
        const any = store.learned.find((r) => r.descriptionKey === k && r.supplierKey === "");
        const hit = own ?? any;
        if (hit) out[k] = hit.category as string;
      }
      return out;
    },
    rememberCategory: async (_s: unknown, _t: string, { supplierKey, descriptionKey, category, actor }: Row) => {
      const key = (supplierKey as string) || "";
      const existing = store.learned.find((r) => r.descriptionKey === descriptionKey && r.supplierKey === key);
      if (existing) Object.assign(existing, { category, setBy: (actor as Row | null)?.name ?? null, setAt: now() });
      else store.learned.push({ id: uuid(), supplierKey: key, descriptionKey, category, setBy: (actor as Row | null)?.name ?? null, setAt: now() });
    },
    jobMaterialsBreakdown: async (_s: unknown, _t: string, jobLegacyId: string) => {
      const active = store.allocations.filter((a) => a.jobId === jobLegacyId && a.status === "active");
      const lines: Row[] = [];
      const withoutLines: Row[] = [];
      for (const a of active) {
        const inv = store.invoices.find((r) => r.id === a.invoiceId)!;
        const ls = store.lines.filter((l) => l.invoiceId === a.invoiceId);
        if (!ls.length) withoutLines.push({ invoiceId: inv.id, supplierName: inv.supplierName, supplierInvoiceNumber: inv.supplierInvoiceNumber, invoiceDate: inv.invoiceDate, amountCents: a.amountCents });
        const sign = inv.documentType === "credit_note" ? -1 : 1;
        for (const l of ls) lines.push({ ...l, supplierName: inv.supplierName, supplierInvoiceNumber: inv.supplierInvoiceNumber, invoiceDate: inv.invoiceDate, documentType: inv.documentType, signedCents: ((l.lineTotalCents as number) || 0) * sign });
      }
      return { lines, invoicesWithoutLines: withoutLines, confirmedCents: active.reduce((s, a) => s + (a.amountCents as number), 0), invoiceCount: active.length };
    },
    healthSnapshot: async () => {
      const dayAgo = Date.now() - 86_400_000;
      const twoHoursAgo = Date.now() - 2 * 3_600_000;
      return {
        failedCount: store.invoices.filter((r) => r.status === "failed").length,
        stuckCount: store.invoices.filter((r) => ["received", "processing"].includes(r.status as string) && Date.parse(r.createdAt as string) < twoHoursAgo).length,
        quarantinedOldCount: store.inbound.filter((x) => x.status === "quarantined" && Date.parse(x.createdAt as string) < dayAgo).length,
        forwardFailedCount: store.inbound.filter((x) => x.status === "ignored" && String(x.failureCode ?? "").startsWith("forward_failed:") && Date.parse(x.createdAt as string) >= dayAgo).length,
        lastReceivedAt: store.inbound.length ? (store.inbound[store.inbound.length - 1]!.createdAt as string) : null,
        everReceived: store.inbound.length > 0,
      };
    },
    recordInboundEvent: async (_s: unknown, e: Row) => {
      if (store.inbound.some((x) => x.svixId === e.svixId)) return { inserted: false };
      const row = { id: uuid(), svixId: e.svixId, emailId: e.emailId ?? null, toMatched: !!e.toMatched, from: e.from ?? null, subject: e.subject ?? null, attachmentCount: e.attachmentCount ?? 0, status: e.status, failureCode: e.failureCode ?? null, createdAt: now(), processedAt: null };
      store.inbound.push(row);
      return { inserted: true, id: row.id };
    },
    finishInboundEvent: async (_s: unknown, svixId: string, { status, failureCode }: Row) => {
      const r = store.inbound.find((x) => x.svixId === svixId);
      if (r) Object.assign(r, { status, failureCode: failureCode ?? null, processedAt: now() });
    },
    listQuarantined: async (_s: unknown, { limit = 20 } = {}) => store.inbound.filter((x) => x.status === "quarantined").slice(0, limit).map((x) => ({ ...x })),
    inboundStats: async () => {
      const out: Record<string, unknown> = { quarantined: 0, processed: 0, failed: 0, ignored: 0, received: 0, lastAt: null };
      for (const r of store.inbound) out[r.status as string] = ((out[r.status as string] as number) ?? 0) + 1;
      return out;
    },
    invoiceIdsForEmail: async (_s: unknown, _t: string, emailId: string) => store.invoices.filter((r) => r.sourceEmailId === emailId).map((r) => r.id),
  });
  return store;
}
