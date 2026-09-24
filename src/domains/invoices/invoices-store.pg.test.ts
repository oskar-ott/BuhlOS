import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The REAL Postgres store against the dev Supabase project — runs only when
 * INVOICES_PG_TEST=1 and SUPABASE_DB_URL/SUPABASE_PROJECT_REF/SUPABASE_ENV
 * point at a NON-production project (the env guard refuses production from a
 * test run anyway). Every row it creates carries a unique marker and is
 * deleted afterwards. Exercises the SQL that unit tests only mimic: the
 * transactional create, one-active-allocation index, reversal, reassignment,
 * checksum / supplier lookups, claim + attempt bookkeeping, list filters,
 * inbound replay guard, job summary.
 */
const ENABLED = process.env.INVOICES_PG_TEST === "1" && !!process.env.SUPABASE_DB_URL;
const requireFromHere = createRequire(import.meta.url);

describe.skipIf(!ENABLED)("invoices store — dev Postgres", () => {
  const store = requireFromHere("../../../api/_lib/invoices/store.js");
  const { getDb, closeDb } = requireFromHere("../../../api/_lib/supabase-db.js");
  const marker = `pgtest-${Date.now()}`;
  let sql: ReturnType<typeof getDb>;
  let tenantId: string;
  const created: string[] = [];
  const actor = { id: "u_test", name: "PG Test", role: "admin" };

  beforeAll(async () => {
    sql = getDb({ mode: "write" });
    const t = await store.resolveTenant(sql);
    expect(t).toBeTruthy();
    tenantId = t.id;
  });

  afterAll(async () => {
    if (!sql) return;
    if (created.length) {
      await sql`delete from public.supplier_invoice_events where invoice_id in ${sql(created)}`;
      await sql`delete from public.supplier_invoice_attempts where invoice_id in ${sql(created)}`;
      await sql`delete from public.supplier_invoice_allocations where invoice_id in ${sql(created)}`;
      await sql`delete from public.supplier_invoice_documents where invoice_id in ${sql(created)}`;
      await sql`update public.supplier_invoices set duplicate_of_id = null where id in ${sql(created)}`;
      await sql`delete from public.supplier_invoices where id in ${sql(created)}`;
    }
    await sql`delete from public.supplier_invoice_inbound_events where svix_message_id like ${marker + "%"}`;
    await closeDb();
  });

  async function make(sha: string, providerIds?: { emailId: string; attId: string }) {
    const r = await store.createInvoiceWithDocument(sql, tenantId,
      { source: providerIds ? "email" : "upload", sourceEmailId: providerIds?.emailId ?? null, sourceSubject: marker, createdBy: actor },
      { source: providerIds ? "email" : "upload", providerEmailId: providerIds?.emailId ?? null, providerAttachmentId: providerIds?.attId ?? null,
        filename: "t.pdf", contentType: "application/pdf", byteSize: 10, sha256: sha, blobPathname: "x", blobUrl: "https://example.invalid/x", uploadedBy: actor });
    if (r) created.push(r.invoice.id);
    return r;
  }

  it("creates invoice + document transactionally and refuses a provider replay", async () => {
    const a = await make("1".repeat(64), { emailId: `${marker}-e1`, attId: "att1" });
    expect(a.invoice.status).toBe("received");
    expect(a.document.sha256).toBe("1".repeat(64));
    const replay = await make("1".repeat(64), { emailId: `${marker}-e1`, attId: "att1" });
    expect(replay).toBeNull();
    const rows = await sql`select count(*)::int as n from public.supplier_invoices where source_subject = ${marker}`;
    expect(rows[0].n).toBe(1);
    const detail = await store.getInvoiceDetail(sql, tenantId, a.invoice.id);
    expect(detail.documents[0]).not.toHaveProperty("blobUrl");
    expect(detail.events.map((e: { event: string }) => e.event)).toEqual(["received"]);
  });

  it("claims, attempts, applies extraction, and finds duplicates by checksum and supplier+number", async () => {
    const a = await make("2".repeat(64));
    const claimed = await store.claimOne(sql, tenantId, a.invoice.id);
    expect(claimed).toMatchObject({ status: "processing", attemptCount: 1 });
    const att = await store.startAttempt(sql, tenantId, a.invoice.id, "upload");
    expect(att.attemptNo).toBe(1);
    const applied = await store.applyExtraction(sql, tenantId, a.invoice.id, {
      supplierName: "PG Test Supplies", supplierKey: "pg test supplies", supplierInvoiceNumber: "PG-1", documentType: "tax_invoice", invoiceDate: "2026-09-03",
      subtotalCents: 12345, gstCents: 1234, totalCents: 13579, totalsConsistent: true, ivReferenceRaw: "IV 0041", ivReference: "IV0041", ivCandidates: [{ raw: "IV 0041" }],
      matchStatus: "not_found", matchReason: { matchCount: 0 }, status: "needs_review", reviewReasons: ["iv_not_found"], extractionMethod: "pdf_text", fields: { subtotalCents: { value: 12345 } }, excerpt: "x",
    });
    expect(applied).toMatchObject({ subtotalCents: 12345, gstCents: 1234, totalCents: 13579, ivReference: "IV0041", supplierInvoiceNumber: "PG-1", status: "needs_review" });
    expect(typeof applied.subtotalCents).toBe("number");
    await store.finishAttempt(sql, att.id, { outcome: "ok", extractionMethod: "pdf_text" });
    const b = await make("2".repeat(64));
    expect(await store.findInvoicesByChecksum(sql, tenantId, "2".repeat(64), b.invoice.id)).toEqual([expect.objectContaining({ id: a.invoice.id })]);
    expect(await store.findInvoicesBySupplierNumber(sql, tenantId, "pg test supplies", "PG-1", b.invoice.id)).toEqual([expect.objectContaining({ id: a.invoice.id })]);
    expect(await store.findInvoicesBySupplierNumber(sql, tenantId, "other", "PG-1", b.invoice.id)).toEqual([]);
  });

  it("allows exactly one active allocation per invoice; reversal and reassignment keep history; the job figure is a live sum", async () => {
    const job = `${marker}-job`;
    const a = await make("3".repeat(64));
    await store.applyExtraction(sql, tenantId, a.invoice.id, { documentType: "tax_invoice", subtotalCents: 1000, status: "matched", matchStatus: "exact", matchedJobId: job, ivCandidates: [], reviewReasons: [], fields: {} });
    const first = await store.confirmAllocation(sql, tenantId, a.invoice.id, { jobLegacyId: job, amountCents: 1000, gstCents: 100, totalCents: 1100, matchStatus: "exact", actor });
    expect(first.alreadyConfirmed).toBe(false);
    const again = await store.confirmAllocation(sql, tenantId, a.invoice.id, { jobLegacyId: job, amountCents: 1000, matchStatus: "exact", actor });
    expect(again.alreadyConfirmed).toBe(true);
    expect(again.allocation.id).toBe(first.allocation.id);
    const other = await store.confirmAllocation(sql, tenantId, a.invoice.id, { jobLegacyId: `${job}-b`, amountCents: 1000, matchStatus: "manual", actor });
    expect(other.conflict).toBe(true);
    // the partial unique index itself refuses a second active row
    await expect(sql`insert into public.supplier_invoice_allocations (tenant_id, invoice_id, job_legacy_id, amount_ex_gst_cents) values (${tenantId}, ${a.invoice.id}, ${job}, 5)`).rejects.toMatchObject({ code: "23505" });
    expect(await store.jobSummary(sql, tenantId, job)).toMatchObject({ confirmedCents: 1000, confirmedCount: 1, awaitingCount: 0 });

    const moved = await store.reassignAllocation(sql, tenantId, a.invoice.id, { jobLegacyId: `${job}-b`, amountCents: 1000, actor });
    expect(moved.previous.status).toBe("reversed");
    expect(await store.jobSummary(sql, tenantId, job)).toMatchObject({ confirmedCents: 0, confirmedCount: 0 });
    expect(await store.jobSummary(sql, tenantId, `${job}-b`)).toMatchObject({ confirmedCents: 1000, confirmedCount: 1 });

    const ex = await store.transitionWithReversal(sql, tenantId, a.invoice.id, { status: "excluded", actor, event: "excluded", detail: {}, extra: { excludedReason: "test" } });
    expect(ex.reversed.status).toBe("reversed");
    expect(ex.invoice.status).toBe("excluded");
    expect(await store.jobSummary(sql, tenantId, `${job}-b`)).toMatchObject({ confirmedCents: 0 });
    const detail = await store.getInvoiceDetail(sql, tenantId, a.invoice.id);
    expect(detail.allocations.map((x: { status: string }) => x.status)).toEqual(["reversed", "reversed"]);
    expect(detail.events.map((e: { event: string }) => e.event)).toEqual(["uploaded", "confirmed", "reassigned", "excluded"]);
  });

  it("lists with filters + counts and records inbound receipts once", async () => {
    const list = await store.listInvoices(sql, tenantId, { q: marker, limit: 5 });
    expect(list.total).toBeGreaterThanOrEqual(3);
    expect(list.rows.every((r: { subtotalCents: unknown }) => r.subtotalCents == null || typeof r.subtotalCents === "number")).toBe(true);
    const counts = await store.countsByStatus(sql, tenantId);
    expect(typeof counts.received === "number" || counts.received === undefined).toBe(true);
    const r1 = await store.recordInboundEvent(sql, { svixId: `${marker}-msg`, tenantId, emailId: "e", toMatched: true, status: "quarantined", attachmentCount: 1 });
    const r2 = await store.recordInboundEvent(sql, { svixId: `${marker}-msg`, tenantId, emailId: "e", toMatched: true, status: "quarantined", attachmentCount: 1 });
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);
    const q = await store.listQuarantined(sql, { limit: 50 });
    expect(q.some((x: { svixId: string }) => x.svixId === `${marker}-msg`)).toBe(true);
    await store.finishInboundEvent(sql, `${marker}-msg`, { status: "processed" });
    const stats = await store.inboundStats(sql);
    expect(stats.processed).toBeGreaterThanOrEqual(1);
  });

  it("stores photo documents, link-only review items and auto set-aside reasons; the digest counts set-asides", async () => {
    // A photo (kind = image) round-trips with its own content type.
    const photo = await store.createInvoiceWithDocument(sql, tenantId,
      { source: "email", sourceEmailId: `${marker}-photo`, sourceSubject: marker, createdBy: null },
      { source: "email", kind: "image", providerEmailId: `${marker}-photo`, providerAttachmentId: "p1", filename: "IMG_1.jpg", contentType: "image/jpeg", byteSize: 10, sha256: "f".repeat(64), blobPathname: "x", blobUrl: "https://example.invalid/p", uploadedBy: null });
    created.push(photo.invoice.id);
    expect(photo.document).toMatchObject({ kind: "image", contentType: "image/jpeg" });
    expect(await store.getDocumentWithBlob(sql, tenantId, photo.invoice.id, null)).toMatchObject({ kind: "image" });
    // A link-only email becomes a review row with no document, carrying its links + excerpt.
    const linkOnly = await store.createInvoice(sql, tenantId, {
      source: "email", sourceEmailId: `${marker}-link`, sourceSubject: marker, createdBy: null,
      status: "needs_review", reviewReasons: ["no_attachment"], sourceLinks: ["https://portal.example/inv/1"], sourceTextExcerpt: "view your invoice",
    });
    created.push(linkOnly.id);
    expect(linkOnly).toMatchObject({ status: "needs_review", reviewReasons: ["no_attachment"], sourceLinks: ["https://portal.example/inv/1"], sourceTextExcerpt: "view your invoice" });
    expect(await store.invoiceIdsForEmail(sql, tenantId, `${marker}-link`)).toEqual([linkOnly.id]);
    const attached = await store.addDocument(sql, tenantId, { invoiceId: linkOnly.id, source: "upload", kind: "pdf", filename: "inv.pdf", contentType: "application/pdf", byteSize: 10, sha256: "e".repeat(64), blobPathname: "y", blobUrl: "https://example.invalid/y", uploadedBy: actor });
    expect(attached).toMatchObject({ kind: "pdf" });
    // A docket is set aside with its reason and counted by the digest.
    const docket = await make("d".repeat(64));
    await store.claimOne(sql, tenantId, docket.invoice.id);
    const ex = await store.applyExtraction(sql, tenantId, docket.invoice.id, { documentType: "delivery_docket", status: "excluded", excludedReason: "not_an_invoice:delivery_docket", extractionMethod: "pdf_text", currency: "AUD", matchStatus: "none", reviewReasons: [] });
    expect(ex).toMatchObject({ status: "excluded", documentType: "delivery_docket", excludedReason: "not_an_invoice:delivery_docket" });
    const digest = await store.digestStats(sql, tenantId, { since: new Date(Date.now() - 60_000).toISOString() });
    expect(digest.setAsideCount).toBeGreaterThanOrEqual(1);
  });

  it("lists a supplier's captured documents for the statement check, excluding the statement itself", async () => {
    const a = await make("c".repeat(64));
    await store.claimOne(sql, tenantId, a.invoice.id);
    await store.applyExtraction(sql, tenantId, a.invoice.id, { supplierName: `Statement Co ${marker}`, supplierKey: `statement-co-${marker}`, supplierInvoiceNumber: "SC-1", documentType: "tax_invoice", status: "matched", extractionMethod: "pdf_text", currency: "AUD", matchStatus: "none", reviewReasons: [], subtotalCents: 1000, gstCents: 100, totalCents: 1100 });
    const st = await make("b".repeat(64));
    const rows = await store.listSupplierInvoices(sql, tenantId, `statement-co-${marker}`, st.invoice.id);
    expect(rows).toEqual([{ id: a.invoice.id, supplierInvoiceNumber: "SC-1", status: "matched", documentType: "tax_invoice", subtotalCents: 1000, totalCents: 1100 }]);
    expect(await store.listSupplierInvoices(sql, tenantId, null, st.invoice.id)).toEqual([]);
  });

  it("records forwarded stray replies and reads the health snapshot the mid-week alert needs", async () => {
    const r = await store.recordInboundEvent(sql, { svixId: `${marker}-fwd`, tenantId, emailId: "e-fwd", toMatched: false, status: "forwarded", attachmentCount: 0 });
    expect(r.inserted).toBe(true);
    await store.finishInboundEvent(sql, `${marker}-fwd`, { status: "forwarded" });
    await store.recordInboundEvent(sql, { svixId: `${marker}-fwd2`, tenantId, emailId: "e-fwd2", toMatched: false, status: "ignored", failureCode: "forward_failed:no_recipients", attachmentCount: 0 });
    const stats = await store.inboundStats(sql);
    expect(stats.forwarded).toBeGreaterThanOrEqual(1);
    const snap = await store.healthSnapshot(sql, tenantId);
    expect(snap).toMatchObject({ everReceived: true });
    expect(snap.forwardFailedCount).toBeGreaterThanOrEqual(1);
    expect(typeof snap.failedCount).toBe("number");
    expect(typeof snap.stuckCount).toBe("number");
    expect(typeof snap.quarantinedOldCount).toBe("number");
  });

  it("stores line items, re-files one with a remembered category, and builds the job breakdown through active allocations", async () => {
    const inv = await make("e".repeat(64));
    await store.claimOne(sql, tenantId, inv.invoice.id);
    await store.applyExtraction(sql, tenantId, inv.invoice.id, { supplierName: `Lines Co ${marker}`, supplierKey: `lines-co-${marker}`, supplierInvoiceNumber: "LC-1", documentType: "tax_invoice", status: "matched", extractionMethod: "pdf_text", currency: "AUD", matchStatus: "exact", reviewReasons: [], subtotalCents: 3000, gstCents: 300, totalCents: 3300, linesTotalCents: 3000, linesConsistent: true });
    await store.replaceInvoiceLines(sql, tenantId, inv.invoice.id, [
      { lineNo: 1, description: "2.5mm TPS 100m", descriptionKey: "2 5mm tps 100m", quantity: 2, unit: "roll", unitPriceCents: 1000, lineTotalCents: 2000, category: "cable", categorySource: "rule", confidence: "high" },
      { lineNo: 2, description: "Freight", descriptionKey: "freight", quantity: 1, unit: null, unitPriceCents: 1000, lineTotalCents: 1000, category: "freight", categorySource: "rule", confidence: "medium" },
    ]);
    const detail = await store.getInvoiceDetail(sql, tenantId, inv.invoice.id);
    expect(detail.invoice).toMatchObject({ linesTotalCents: 3000, linesConsistent: true });
    expect(detail.lines.map((l: { lineNo: number; category: string; quantity: number | null }) => [l.lineNo, l.category, l.quantity])).toEqual([[1, "cable", 2], [2, "freight", 1]]);
    const refiled = await store.updateInvoiceLine(sql, tenantId, inv.invoice.id, 2, { category: "other" });
    expect(refiled).toMatchObject({ category: "other", categorySource: "manual" });
    await store.rememberCategory(sql, tenantId, { supplierKey: `lines-co-${marker}`, descriptionKey: "freight", category: "other", actor });
    await store.rememberCategory(sql, tenantId, { supplierKey: `lines-co-${marker}`, descriptionKey: "freight", category: "consumables", actor }); // upsert
    expect(await store.learnedCategories(sql, tenantId, `lines-co-${marker}`, ["freight", "nothing"])).toEqual({ freight: "consumables" });
    expect(await store.learnedCategories(sql, tenantId, "someone-else", ["freight"])).toEqual({}); // no any-supplier fallback stored
    const job = `job-lines-${marker}`;
    await store.confirmAllocation(sql, tenantId, inv.invoice.id, { jobLegacyId: job, jobUuid: null, amountCents: 3000, gstCents: 300, totalCents: 3300, matchStatus: "exact", actor });
    const b = await store.jobMaterialsBreakdown(sql, tenantId, job);
    expect(b).toMatchObject({ confirmedCents: 3000, invoiceCount: 1, invoicesWithoutLines: [] });
    expect(b.lines.map((l: { category: string; signedCents: number; supplierName: string }) => [l.category, l.signedCents])).toEqual([["cable", 2000], ["other", 1000]]);
    await sql`delete from public.supplier_line_categories where tenant_id = ${tenantId} and supplier_key = ${`lines-co-${marker}`}`;
  });

  it("accepts an evidence placement (match_status inferred) with its evidence in match_reason", async () => {
    const inv = await make("a1".repeat(32));
    await store.claimOne(sql, tenantId, inv.invoice.id);
    const row = await store.applyExtraction(sql, tenantId, inv.invoice.id, { supplierName: `Boutique ${marker}`, supplierKey: `boutique-${marker}`, supplierInvoiceNumber: "B-1", documentType: "tax_invoice", status: "matched", extractionMethod: "pdf_text", currency: "AUD", matchStatus: "inferred", matchedJobId: "birdwood", matchReason: { source: "evidence", strength: "strong", evidence: [{ kind: "address", detail: "delivery address is this job's site" }] }, reviewReasons: [], subtotalCents: 100, gstCents: 10, totalCents: 110 });
    expect(row).toMatchObject({ matchStatus: "inferred", matchedJobId: "birdwood" });
    expect(row.matchReason).toMatchObject({ source: "evidence", strength: "strong" });
  });

  it("creates a receipt from the field with the worker's job, the own-money flag and a note", async () => {
    const r = await store.createInvoice(sql, tenantId, {
      source: "receipt", createdBy: { id: "u_sparky", name: "Sam Sparky" }, sourceSubject: marker,
      matchedJobId: "birdwood", matchedJobUuid: null, matchStatus: "manual", matchReason: { source: "worker", chosenBy: "Sam Sparky" },
      paidPersonally: true, workerNote: "switchboard bits",
    });
    created.push(r.id);
    expect(r).toMatchObject({ source: "receipt", matchedJobId: "birdwood", matchStatus: "manual", paidPersonally: true, workerNote: "switchboard bits", createdBy: "Sam Sparky", createdByLegacyId: "u_sparky" });
    expect(r.matchReason).toMatchObject({ source: "worker" });
  });
});
