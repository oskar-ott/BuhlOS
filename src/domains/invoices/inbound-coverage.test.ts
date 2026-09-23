import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore, type StoreFn } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Inbound coverage (owner direction 2026-09-22): everything a wholesaler
 * mailbox sends that is NOT a clean PDF tax invoice has a defined outcome —
 * dockets/confirmations/remittances are set aside, photos go to manual entry,
 * link-only / .eml / zip emails become a review item carrying the links, a
 * one-digit-off IV number offers "Did you mean…?", and the common
 * one-invoice email is read inline by the webhook.
 */
const requireFromHere = createRequire(import.meta.url);
const inbound = requireFromHere("../../../api/_lib/invoices/resend-inbound.js");
const safe = requireFromHere("../../../api/_lib/invoices/safe-file.js");
const ivm = requireFromHere("../../../api/_lib/invoices/iv-match.js");
const { ingestReceivedEmail, extractLinks, textExcerpt, looksLikeInvoiceEmail } = requireFromHere("../../../api/_lib/invoices/ingest.js");
const { processInvoice } = requireFromHere("../../../api/_lib/invoices/pipeline.js");
const { handleInboundWebhook } = requireFromHere("../../../api/_lib/invoices/webhook.js");
const { extractInvoiceFromText } = requireFromHere("../../../api/_lib/invoices/extract.js");

const T = "tenant";
const PDF = Buffer.from("%PDF-1.4\n" + F.TAX_INVOICE_IV0041);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60_000, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60_000, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(100)]);

const DOCKET = `Sparky Supplies Pty Ltd
DELIVERY DOCKET
Docket No: DD-5512
Date: 03/09/2026
Job Number: IV 0041
Qty   Description
10    2.5mm TPS cable 100m
Received by: ____________`;
const ORDER_CONFIRMATION = `Wholesale Wires Pty Ltd
ORDER CONFIRMATION
Sales Order: SO-778
Job Number: IV0041
Sub Total 50.00
GST 5.00
Total 55.00`;
const REMITTANCE = `Buhl Electrical
REMITTANCE ADVICE
Paid invoices: SS-88123
Amount 1,188.00`;
const INVOICE_AND_DOCKET = `Sparky Supplies Pty Ltd
TAX INVOICE / DELIVERY DOCKET
Tax Invoice No: SS-1
Invoice Date: 03/09/2026
Job Number: IV 0041
Sub Total 100.00
GST 10.00
Total 110.00`;

let store: MemoryStore;
beforeEach(() => {
  store = createMemoryStore();
});

describe("classifyAttachments", () => {
  it("sorts PDFs, real photos, .eml forwards, zips and the rest; drops inline / tiny images", () => {
    const g = inbound.classifyAttachments([
      { id: "a", filename: "inv.pdf", contentType: "application/pdf" },
      { id: "b", filename: "IMG_1.jpg", contentType: "image/jpeg", size: 900_000 },
      { id: "c", filename: "logo.png", contentType: "image/png", disposition: "inline", size: 900_000 },
      { id: "d", filename: "sig.png", contentType: "image/png", size: 12_000 },
      { id: "e", filename: "fwd.eml", contentType: "message/rfc822" },
      { id: "f", filename: "docs.zip", contentType: "application/zip" },
      { id: "g", filename: "sheet.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { id: "h", filename: "scan.PDF", contentType: "application/octet-stream" },
      { filename: "no-id.pdf", contentType: "application/pdf" },
    ]);
    expect(g.pdfs.map((a: { id: string }) => a.id)).toEqual(["a", "h"]);
    expect(g.images.map((a: { id: string }) => a.id)).toEqual(["b"]);
    expect(g.emls.map((a: { id: string }) => a.id)).toEqual(["e"]);
    expect(g.zips.map((a: { id: string }) => a.id)).toEqual(["f"]);
    expect(g.others.map((a: { id: string }) => a.id)).toEqual(["c", "d", "g"]);
  });
});

describe("sniffDocument / sanitiseFilenameFor", () => {
  it("recognises PDFs and the three photo formats by bytes, refuses everything else", () => {
    expect(safe.sniffDocument(PDF)).toEqual({ kind: "pdf", contentType: "application/pdf" });
    expect(safe.sniffDocument(PNG)).toEqual({ kind: "image", contentType: "image/png" });
    expect(safe.sniffDocument(JPEG)).toEqual({ kind: "image", contentType: "image/jpeg" });
    expect(safe.sniffDocument(WEBP)).toEqual({ kind: "image", contentType: "image/webp" });
    expect(safe.sniffDocument(Buffer.from("GIF89a not supported"))).toBeNull();
    expect(safe.sniffDocument(Buffer.from("MZ exe pretending.jpg"))).toBeNull();
  });
  it("forces the extension to match the sniffed type", () => {
    expect(safe.sanitiseFilenameFor("photo.pdf", "image/jpeg")).toBe("photo.jpg");
    expect(safe.sanitiseFilenameFor("../../etc/passwd", "application/pdf")).toBe("passwd.pdf");
    expect(safe.sanitiseFilenameFor("", "image/png")).toMatch(/\.png$/);
  });
});

describe("document type rules — non-invoice paperwork", () => {
  it("recognises dockets, confirmations and remittances by their own headings", () => {
    expect(extractInvoiceFromText(DOCKET).documentType).toBe("delivery_docket");
    expect(extractInvoiceFromText(ORDER_CONFIRMATION).documentType).toBe("order_confirmation");
    expect(extractInvoiceFromText(REMITTANCE).documentType).toBe("remittance");
  });
  it("an invoice heading outranks a docket heading on the same page", () => {
    expect(extractInvoiceFromText(INVOICE_AND_DOCKET).documentType).toBe("tax_invoice");
  });
});

describe("nearMissJobs — Did you mean…?", () => {
  const index = ivm.buildJobCodeIndex([
    { id: "j41", name: "Birdwood", code: "IV0041", status: "active" },
    { id: "j14", name: "Swap", code: "IV0014", status: "active" },
    { id: "j91", name: "Nine", code: "IV0091", status: "active" },
    { id: "dupA", name: "Dup A", code: "IV0049", status: "active" },
    { id: "dupB", name: "Dup B", code: "IV0049", status: "active" },
    { id: "far", name: "Far", code: "IV7777", status: "active" },
  ]);
  it("offers adjacent-swap first, then single-digit changes, unique codes only, never the exact code", () => {
    expect(ivm.nearMissJobs("IV0014", index).map((j: { id: string }) => j.id)).toEqual(["j41"]);
    expect(ivm.nearMissJobs("IV0041", index).map((j: { id: string }) => j.id)).toEqual(["j14", "j91"]);
    expect(ivm.nearMissJobs("IV0999", index)).toEqual([]);
    // A code shared by two jobs is never OFFERED (ambiguous)…
    expect(ivm.nearMissJobs("IV0048", index).map((j: { id: string }) => j.id)).toEqual(["j41"]);
    // …but a printed code that happens to collide still gets its own near misses.
    expect(ivm.nearMissJobs("IV0049", index).map((j: { id: string }) => j.id)).toEqual(["j41"]);
    expect(ivm.nearMissJobs("garbage", index)).toEqual([]);
  });
});

describe("email body helpers", () => {
  it("pulls bounded https links from text and html, strips tags for the excerpt", () => {
    const links = extractLinks("View it at https://portal.example.com/inv/123. Thanks", '<a href="https://portal.example.com/inv/123">x</a> <a href="https://other.example/a">y</a> <a href="http://insecure.example/">z</a>');
    expect(links).toEqual(["https://portal.example.com/inv/123", "https://other.example/a"]);
    expect(textExcerpt("", "<p>Hello <b>there</b></p><style>x{}</style>")).toBe("Hello there");
    expect(textExcerpt("x".repeat(5000), null)?.length).toBe(1500);
  });
  it("only invoice-looking emails become review items", () => {
    expect(looksLikeInvoiceEmail("Your invoice is ready", "", [])).toBe(true);
    expect(looksLikeInvoiceEmail("Re: site visit", "the amount due is attached", [])).toBe(true);
    expect(looksLikeInvoiceEmail("Out of office", "I am away", [])).toBe(false);
    expect(looksLikeInvoiceEmail("Hi", "", ["https://x.example/y"])).toBe(true);
  });
});

function resendStub(email: Record<string, unknown>, bytes: Record<string, Buffer>) {
  return {
    fetchReceivedEmail: async () => email,
    fetchAttachmentMeta: async (_e: string, aid: string) => ({ id: aid, download_url: `https://cdn.example/${aid}` }),
    downloadAttachment: async (url: string) => bytes[url.split("/").pop()!] ?? Buffer.from("nope"),
  };
}
function ingestDeps(email: Record<string, unknown>, bytes: Record<string, Buffer> = {}) {
  return {
    store,
    resend: resendStub(email, bytes),
    storePdf: async ({ invoiceId, filename, contentType }: { invoiceId: string; filename: string; contentType: string }) => ({ url: `blob://${invoiceId}/${filename}`, pathname: `${invoiceId}/${filename}`, contentType }),
    sha256: () => "s".repeat(64),
    apiKey: "re_test",
  };
}

describe("ingestReceivedEmail — every arrival has an outcome", () => {
  it("a photo attachment is captured as an image document", async () => {
    const r = await ingestReceivedEmail({ sql: null, tenant: { id: T, slug: "buhl" }, emailId: "e1", deps: ingestDeps(
      { subject: "Docket photo", from: "x@y", attachments: [{ id: "p1", filename: "IMG_2001.jpg", content_type: "image/jpeg", size: 800_000 }] },
      { p1: JPEG },
    ) });
    expect(r.created).toHaveLength(1);
    expect(store.documents[0]).toMatchObject({ kind: "image", contentType: "image/jpeg", filename: "IMG_2001.jpg" });
  });
  it("a file that claims to be a PDF but is neither PDF nor photo is skipped", async () => {
    const r = await ingestReceivedEmail({ sql: null, tenant: { id: T, slug: "buhl" }, emailId: "e2", deps: ingestDeps(
      { subject: "Invoice", from: "x@y", attachments: [{ id: "x1", filename: "inv.pdf", content_type: "application/pdf" }] },
      { x1: Buffer.from("MZ not a pdf at all") },
    ) });
    expect(r.created).toEqual([]);
    expect(r.skipped).toEqual([{ attachmentId: "x1", reason: "not_pdf_or_image" }]);
    // The sender meant to send an invoice → a review item so nothing is lost, with the real reason.
    expect(r.reviewItem).not.toBeNull();
    expect(store.invoices[0]).toMatchObject({ status: "needs_review", reviewReasons: ["attachment_unreadable"] });
  });
  it("a link-only invoice email becomes ONE review item carrying the links and an excerpt", async () => {
    const email = { subject: "Your tax invoice WW-9 is ready", from: "ap@wholesaler.example", text: "Hi, view your invoice at https://portal.wholesaler.example/inv/WW-9 — thanks", html: "", attachments: [] };
    const r = await ingestReceivedEmail({ sql: null, tenant: { id: T, slug: "buhl" }, emailId: "e3", deps: ingestDeps(email) });
    expect(r.created).toEqual([]);
    expect(r.reviewItem).toBe(store.invoices[0]!.id);
    expect(store.invoices[0]).toMatchObject({
      status: "needs_review", source: "email", sourceEmailId: "e3", reviewReasons: ["no_attachment"],
      sourceLinks: ["https://portal.wholesaler.example/inv/WW-9"],
    });
    expect(store.invoices[0]!.sourceTextExcerpt).toContain("view your invoice");
    expect(store.events.map((e) => e.event)).toEqual(["received", "review_required"]);
    // Re-delivery of the same email is a no-op.
    const again = await ingestReceivedEmail({ sql: null, tenant: { id: T, slug: "buhl" }, emailId: "e3", deps: ingestDeps(email) });
    expect(again.reviewItem).toBeNull();
    expect(again.skipped).toEqual([{ attachmentId: null, reason: "already_captured" }]);
    expect(store.invoices).toHaveLength(1);
  });
  it("an Outlook forward-as-attachment (.eml) and a zip each name their fix", async () => {
    await ingestReceivedEmail({ sql: null, tenant: { id: T, slug: "buhl" }, emailId: "e4", deps: ingestDeps({ subject: "FW: stuff", from: "x@y", attachments: [{ id: "m", filename: "Invoice.eml", content_type: "message/rfc822" }] }) });
    await ingestReceivedEmail({ sql: null, tenant: { id: T, slug: "buhl" }, emailId: "e5", deps: ingestDeps({ subject: "FW: stuff", from: "x@y", attachments: [{ id: "z", filename: "docs.zip", content_type: "application/zip" }] }) });
    expect(store.invoices.map((r) => r.reviewReasons)).toEqual([["forwarded_as_attachment"], ["zip_attachment"]]);
  });
  it("chatter with no attachment and nothing invoice-like is ignored, not queued", async () => {
    const r = await ingestReceivedEmail({ sql: null, tenant: { id: T, slug: "buhl" }, emailId: "e6", deps: ingestDeps({ subject: "Out of office", from: "x@y", text: "I am away until Monday.", attachments: [] }) });
    expect(r.reviewItem).toBeNull();
    expect(r.skipped).toEqual([{ attachmentId: null, reason: "not_invoice_like" }]);
    expect(store.invoices).toEqual([]);
  });
});

let seedNo = 0;
async function seed(text: string, kind = "pdf") {
  const sha = String(++seedNo).padStart(64, "0"); // distinct bytes per document — the checksum rule is tested elsewhere
  const r = (await (store.createInvoiceWithDocument as StoreFn)(null, T,
    { source: "upload", createdBy: { id: "u", name: "Office" } },
    { source: "upload", kind, filename: kind === "pdf" ? "doc.pdf" : "doc.jpg", contentType: kind === "pdf" ? "application/pdf" : "image/jpeg", byteSize: 100, sha256: sha, blobPathname: "p", blobUrl: `blob://${encodeURIComponent(text)}` })) as { invoice: { id: string } };
  await (store.claimOne as StoreFn)(null, T, r.invoice.id);
  return r.invoice.id;
}
function pipelineDeps() {
  return {
    store,
    fetchPdf: async (url: string) => Buffer.from(decodeURIComponent(url.slice("blob://".length))),
    extractText: async (bytes: Buffer) => ({ text: bytes.toString(), pageCount: 1, hasTextLayer: true }),
    readJobs: async () => F.JOBS,
    aiExtract: null,
  };
}

describe("processInvoice — set aside, photos, suggestions", () => {
  it("a delivery docket is set aside automatically with the reason recorded — nothing to review, nothing booked", async () => {
    const id = await seed(DOCKET);
    const r = await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: pipelineDeps() });
    expect(r).toEqual({ ok: true, status: "excluded" });
    expect(store.invoices[0]).toMatchObject({ status: "excluded", documentType: "delivery_docket", excludedReason: "not_an_invoice:delivery_docket", matchedJobId: "birdwood" });
    expect(store.allocations).toEqual([]);
    expect(store.events.map((e) => e.event)).toContain("auto_excluded");
  });
  it("an order confirmation and a remittance are set aside too; a statement still goes to review", async () => {
    for (const text of [ORDER_CONFIRMATION, REMITTANCE, F.STATEMENT]) {
      const id = await seed(text);
      await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: pipelineDeps() });
    }
    expect(store.invoices.map((r) => [r.documentType, r.status])).toEqual([["order_confirmation", "excluded"], ["remittance", "excluded"], ["statement", "needs_review"]]);
  });
  it("a photo goes straight to review for manual entry — no text extraction attempted", async () => {
    const id = await seed("not text", "image");
    const r = await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: { ...pipelineDeps(), extractText: async () => { throw new Error("must not be called"); } } });
    expect(r).toEqual({ ok: true, status: "needs_review" });
    expect(store.invoices[0]).toMatchObject({ status: "needs_review", reviewReasons: ["image_only"], extractionMethod: "none" });
  });
  it("an unknown IV number carries near-miss suggestions, but is never matched to one", async () => {
    const jobs = [...F.JOBS, { id: "j0099", name: "Ninety-nine", code: "IV0099", status: "active" }];
    const id = await seed(F.INVOICE_UNKNOWN_IV); // IV0999
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: { ...pipelineDeps(), readJobs: async () => jobs } });
    const inv = store.invoices[0]!;
    expect(inv).toMatchObject({ status: "needs_review", matchStatus: "not_found", matchedJobId: null });
    expect((inv.matchReason as { suggestions: Array<{ id: string }> }).suggestions.map((s) => s.id)).toEqual(["j0099"]);
  });
});

describe("webhook — the one-invoice email is read inline", () => {
  const SECRET = "whsec_" + Buffer.from("test-signing-key-32-bytes-long!!").toString("base64");
  const NOW = 1_700_000_000;
  const env = { RESEND_INBOUND_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: "re_test", INVOICE_INBOUND_DOMAIN: "buhlos.com" };
  function sign(body: string, id = "msg_1") {
    const sig = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${NOW}.${body}`).digest("base64");
    return { "svix-id": id, "svix-timestamp": String(NOW), "svix-signature": `v1,${sig}` };
  }
  const body = JSON.stringify({ type: "email.received", data: { email_id: "email_1", from: "ap@example.com", to: ["invoices@buhlos.com"], subject: "Invoice", attachments: [{ id: "att_pdf", filename: "inv.pdf", content_type: "application/pdf" }] } });
  const email = { subject: "Invoice", from: "ap@example.com", attachments: [{ id: "att_pdf", filename: "inv.pdf", content_type: "application/pdf" }] };

  it("reads and matches the single document before acking, and reports it", async () => {
    const processed: string[] = [];
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: {
      isFlagOn: async () => true, getDb: () => ({}), ingest: ingestReceivedEmail, nowSec: NOW,
      ...ingestDeps(email, { att_pdf: PDF }),
      processOne: async ({ invoiceId }: { invoiceId: string }) => {
        processed.push(invoiceId);
        await (store.claimOne as StoreFn)(null, T, invoiceId);
        return processInvoice({ sql: null, tenantId: T, invoiceId, trigger: "webhook", deps: { ...pipelineDeps(), fetchPdf: async () => PDF } });
      },
    } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, created: 1, processedInline: true });
    expect(processed).toEqual([store.invoices[0]!.id]);
    expect(store.invoices[0]).toMatchObject({ status: "matched", matchedJobId: "birdwood" });
    expect(store.allocations).toEqual([]);
  });
  it("a failing or slow inline read still acks — the row stays received for the sweep", async () => {
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: {
      isFlagOn: async () => true, getDb: () => ({}), ingest: ingestReceivedEmail, nowSec: NOW,
      ...ingestDeps(email, { att_pdf: PDF }),
      processOne: async () => { throw new Error("boom"); },
    } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, created: 1, processedInline: false });
    expect(store.invoices[0]).toMatchObject({ status: "received" });
    expect(store.inbound[0]).toMatchObject({ status: "processed" });
  });
});
