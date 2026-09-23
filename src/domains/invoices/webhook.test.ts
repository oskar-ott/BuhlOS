import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore, type StoreFn } from "./test-helpers/memory-store";

const requireFromHere = createRequire(import.meta.url);
const { handleInboundWebhook } = requireFromHere("../../../api/_lib/invoices/webhook.js");
const { ingestReceivedEmail } = requireFromHere("../../../api/_lib/invoices/ingest.js");

const SECRET = "whsec_" + Buffer.from("test-signing-key-32-bytes-long!!").toString("base64");
const NOW = 1_700_000_000;
const PDF = Buffer.from("%PDF-1.4\nfake invoice bytes");

function sign(body: string, id = "msg_1") {
  const sig = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${NOW}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(NOW), "svix-signature": `v1,${sig}` };
}

function event(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "email.received",
    data: {
      email_id: "email_1", from: "Wholesaler <ap@example.com>", to: ["invoices+tok123@inbound.example.com"], received_for: [], subject: "Invoice SS-88123",
      message_id: "<m1@example.com>",
      attachments: [{ id: "att_pdf", filename: "SS-88123.pdf", content_type: "application/pdf", content_disposition: "attachment" }, { id: "att_logo", filename: "logo.png", content_type: "image/png", content_disposition: "inline" }],
      ...over,
    },
  });
}

let store: MemoryStore;
let flagOn = true;
let blobs: Record<string, Buffer>;
let resendCalls: string[];

function resendStub(attachmentBytes: Record<string, Buffer> = { att_pdf: PDF }) {
  return {
    fetchReceivedEmail: async (id: string) => {
      resendCalls.push(`email:${id}`);
      return { id, subject: "Invoice SS-88123", from: "ap@example.com", message_id: "<m1@example.com>", attachments: [
        { id: "att_pdf", filename: "SS-88123.pdf", content_type: "application/pdf" },
        { id: "att_logo", filename: "logo.png", content_type: "image/png", content_disposition: "inline" },
        { id: "att_fake", filename: "fake.pdf", content_type: "application/pdf" },
      ] };
    },
    fetchAttachmentMeta: async (_e: string, aid: string) => { resendCalls.push(`meta:${aid}`); return { id: aid, download_url: `https://cdn.example/${aid}`, expires_at: "2099-01-01T00:00:00Z" }; },
    downloadAttachment: async (url: string) => { const aid = url.split("/").pop()!; resendCalls.push(`dl:${aid}`); return attachmentBytes[aid] ?? Buffer.from("PNG not a pdf"); },
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    isFlagOn: async () => flagOn,
    getDb: () => ({}),
    store,
    ingest: ingestReceivedEmail,
    resend: resendStub(),
    storePdf: async ({ invoiceId, filename, bytes }: { invoiceId: string; filename: string; bytes: Buffer }) => { const p = `invoices/buhl/${invoiceId}/${filename}`; blobs[p] = bytes; return { url: `blob://${p}`, pathname: p }; },
    sha256: (b: Buffer) => "s".repeat(63) + (b.length % 10),
    nowSec: NOW,
    ...over,
  };
}
const env = { RESEND_INBOUND_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: "re_test", INVOICE_INBOUND_TOKEN: "tok123", INVOICE_INBOUND_DOMAIN: "inbound.example.com" };

beforeEach(() => {
  store = createMemoryStore();
  flagOn = true;
  blobs = {};
  resendCalls = [];
});

describe("inbound webhook — authentication", () => {
  it("fails closed with no secret configured", async () => {
    const body = event();
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env: { ...env, RESEND_INBOUND_WEBHOOK_SECRET: "" }, deps: deps() });
    expect(r.status).toBe(503);
    expect(store.inbound).toEqual([]);
  });
  it("rejects an invalid signature and records nothing", async () => {
    const body = event();
    const h = sign(body);
    h["svix-signature"] = "v1,AAAA";
    const r = await handleInboundWebhook({ rawBody: body, headers: h, env, deps: deps() });
    expect(r.status).toBe(401);
    expect(store.inbound).toEqual([]);
    expect(resendCalls).toEqual([]);
  });
  it("rejects a body altered after signing", async () => {
    const body = event();
    const r = await handleInboundWebhook({ rawBody: body.replace("SS-88123", "SS-99999"), headers: sign(body), env, deps: deps() });
    expect(r.status).toBe(401);
  });
});

describe("inbound webhook — receipt, replay, scoping", () => {
  it("captures the PDF attachment only, records the receipt, leaves extraction for later", async () => {
    const body = event();
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    expect(r).toEqual({ status: 200, body: { received: true, created: 1, skipped: 1, reviewItem: false, processedInline: false } });
    expect(store.inbound[0]).toMatchObject({ status: "processed", toMatched: true, emailId: "email_1" });
    expect(store.invoices).toHaveLength(1);
    expect(store.invoices[0]).toMatchObject({ status: "received", source: "email", sourceEmailId: "email_1", sourceSubject: "Invoice SS-88123" });
    expect(store.documents[0]).toMatchObject({ providerEmailId: "email_1", providerAttachmentId: "att_pdf", filename: "SS-88123.pdf", byteSize: PDF.length });
    expect(Object.keys(blobs)).toHaveLength(1);
    // the logo was never fetched; the fake .pdf was fetched, sniffed and dropped
    expect(resendCalls).toEqual(["email:email_1", "meta:att_pdf", "dl:att_pdf", "meta:att_fake", "dl:att_fake"]);
  });
  it("the same delivery twice is a no-op replay", async () => {
    const body = event();
    await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    expect(r.body).toEqual({ replay: true });
    expect(store.invoices).toHaveLength(1);
  });
  it("a re-delivery under a NEW svix id for the same email creates no second document", async () => {
    const body = event();
    await handleInboundWebhook({ rawBody: body, headers: sign(body, "msg_1"), env, deps: deps() });
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body, "msg_2"), env, deps: deps() });
    expect(r.body).toEqual({ received: true, created: 0, skipped: 2, reviewItem: false, processedInline: false });
    expect(store.invoices).toHaveLength(1);
    expect(store.documents).toHaveLength(1);
  });
  it("mail to an address without the right token is ignored — nothing fetched", async () => {
    const body = event({ to: ["invoices+wrong@inbound.example.com"] });
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    expect(r.body).toEqual({ ignored: true });
    expect(store.inbound[0]!.status).toBe("ignored");
    expect(resendCalls).toEqual([]);
    expect(store.invoices).toEqual([]);
  });
  it("with no token configured, the plain invoices@domain address is accepted and nothing else is", async () => {
    const plainEnv = { ...env, INVOICE_INBOUND_TOKEN: "" };
    const ok = event({ to: ["invoices@inbound.example.com"] });
    const r = await handleInboundWebhook({ rawBody: ok, headers: sign(ok, "msg_plain_1"), env: plainEnv, deps: deps() });
    expect(r.body).toEqual({ received: true, created: 1, skipped: 1, reviewItem: false, processedInline: false });
    const other = event({ to: ["accounts@inbound.example.com"] });
    const r2 = await handleInboundWebhook({ rawBody: other, headers: sign(other, "msg_plain_2"), env: plainEnv, deps: deps() });
    expect(r2.body).toEqual({ ignored: true });
  });
  it("other event types are acknowledged and ignored after verification", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "x" } });
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    expect(r).toEqual({ status: 200, body: { ignored: true } });
    expect(store.inbound).toEqual([]);
  });
});

describe("inbound webhook — feature disabled", () => {
  it("quarantines a genuine delivery: receipt kept by id, nothing fetched, nothing lost", async () => {
    flagOn = false;
    const body = event();
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    expect(r.body).toEqual({ quarantined: true });
    expect(store.inbound[0]).toMatchObject({ status: "quarantined", emailId: "email_1", toMatched: true });
    expect(resendCalls).toEqual([]);
    expect(store.invoices).toEqual([]);
    expect(blobs).toEqual({});
  });
  it("a quarantined delivery is re-ingested later by the sweep path", async () => {
    flagOn = false;
    const body = event();
    await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    flagOn = true;
    const waiting = (await (store.listQuarantined as StoreFn)(null, {})) as Array<{ emailId: string }>;
    expect(waiting).toHaveLength(1);
    const d = deps();
    const r = await ingestReceivedEmail({ sql: null, tenant: { id: "t", slug: "buhl" }, emailId: waiting[0]!.emailId, deps: { store, resend: d.resend, storePdf: d.storePdf, sha256: d.sha256, apiKey: "re_test" } });
    expect(r.created).toHaveLength(1);
    expect(store.invoices[0]!.status).toBe("received");
  });
});

describe("inbound webhook — robustness", () => {
  it("an oversized attachment is skipped, the email is still acknowledged", async () => {
    const body = event();
    const resend = resendStub();
    resend.downloadAttachment = async () => { const e = new Error("too big") as Error & { code: string }; e.code = "attachment_too_large"; throw e; };
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps({ resend }) });
    expect(r.body).toEqual({ received: true, created: 0, skipped: 2, reviewItem: true, processedInline: false });
    // The sender meant to send an invoice: one review item says so, with no document.
    expect(store.invoices).toHaveLength(1);
    expect(store.invoices[0]).toMatchObject({ status: "needs_review", reviewReasons: ["attachment_unreadable"], sourceEmailId: "email_1" });
    expect(store.documents).toEqual([]);
  });
  it("a provider outage during ingest leaves the receipt for the sweep and still acks", async () => {
    const body = event();
    const resend = resendStub();
    resend.fetchReceivedEmail = async () => { const e = new Error("503") as Error & { code: string }; e.code = "provider_error"; throw e; };
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps({ resend }) });
    expect(r.body).toEqual({ received: true, deferred: true });
    expect(store.inbound[0]).toMatchObject({ status: "received", processedAt: null });
  });
  it("a store outage refuses to ack so the provider retries", async () => {
    const body = event();
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps({ getDb: () => { throw new Error("no db"); } }) });
    expect(r.status).toBe(503);
  });
  it("malformed JSON with a valid signature is a 400", async () => {
    const body = "{not json";
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    expect(r.status).toBe(400);
  });
});
