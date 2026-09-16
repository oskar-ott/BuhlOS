import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const requireFromHere = createRequire(import.meta.url);
const inbound = requireFromHere("../../../api/_lib/invoices/resend-inbound.js");

const SECRET = "whsec_" + Buffer.from("test-signing-key-32-bytes-long!!").toString("base64");

export function signSvix(body: string, { id = "msg_1", ts = 1_700_000_000, secret = SECRET } = {}) {
  const key = Buffer.from(secret.slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` };
}

describe("verifySvixSignature", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });
  it("accepts a valid signature within the tolerance window", () => {
    const headers = signSvix(body);
    expect(inbound.verifySvixSignature({ secret: SECRET, headers, rawBody: body, nowSec: 1_700_000_100 })).toEqual({ ok: true, id: "msg_1" });
  });
  it("accepts one valid signature among several", () => {
    const h = signSvix(body);
    h["svix-signature"] = `v1,bogus ${h["svix-signature"]} v2,other`;
    expect(inbound.verifySvixSignature({ secret: SECRET, headers: h, rawBody: body, nowSec: 1_700_000_000 }).ok).toBe(true);
  });
  it("rejects a tampered body, a wrong secret, missing headers and a stale timestamp", () => {
    const headers = signSvix(body);
    expect(inbound.verifySvixSignature({ secret: SECRET, headers, rawBody: body + " ", nowSec: 1_700_000_000 })).toEqual({ ok: false, reason: "bad_signature" });
    expect(inbound.verifySvixSignature({ secret: "whsec_" + Buffer.from("other").toString("base64"), headers, rawBody: body, nowSec: 1_700_000_000 })).toEqual({ ok: false, reason: "bad_signature" });
    expect(inbound.verifySvixSignature({ secret: SECRET, headers: {}, rawBody: body })).toEqual({ ok: false, reason: "missing_headers" });
    expect(inbound.verifySvixSignature({ secret: SECRET, headers, rawBody: body, nowSec: 1_700_000_000 + 600 })).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(inbound.verifySvixSignature({ secret: undefined, headers, rawBody: body })).toEqual({ ok: false, reason: "no_secret" });
    expect(inbound.verifySvixSignature({ secret: SECRET, headers: { ...headers, "svix-timestamp": "abc" }, rawBody: body })).toEqual({ ok: false, reason: "bad_timestamp" });
  });
});

describe("parseReceivedEvent", () => {
  it("keeps metadata only and ignores other event types", () => {
    const e = inbound.parseReceivedEvent({
      type: "email.received",
      data: {
        email_id: "e1", from: "Wholesaler <ap@example.com>", to: ["invoices+tok@inbound.example.com"], received_for: [], subject: "Inv", message_id: "<m@x>",
        attachments: [
          { id: "a1", filename: "inv.pdf", content_type: "application/pdf", content_disposition: "attachment" },
          { id: "a2", filename: "logo.png", content_type: "image/png", content_disposition: "inline", content_id: "img" },
          { bogus: true },
        ],
      },
    });
    expect(e).toMatchObject({ emailId: "e1", subject: "Inv", to: ["invoices+tok@inbound.example.com"] });
    expect(e.attachments).toHaveLength(2);
    expect(inbound.parseReceivedEvent({ type: "email.sent", data: { email_id: "e1" } })).toBeNull();
    expect(inbound.parseReceivedEvent({ type: "email.received", data: {} })).toBeNull();
    expect(inbound.parseReceivedEvent(null)).toBeNull();
  });
});

describe("matchInboundAddress", () => {
  const expected = { token: "s3cr3tT0ken", localPart: "invoices", domain: "inbound.example.com" };
  it("matches only the exact local part + token (+ domain when configured)", () => {
    expect(inbound.matchInboundAddress(["invoices+s3cr3tT0ken@inbound.example.com"], expected)).toBe(true);
    expect(inbound.matchInboundAddress(["Accounts <INVOICES+S3CR3TT0KEN@INBOUND.EXAMPLE.COM>"], expected)).toBe(true);
    expect(inbound.matchInboundAddress(["invoices+wrong@inbound.example.com"], expected)).toBe(false);
    expect(inbound.matchInboundAddress(["invoices@inbound.example.com"], expected)).toBe(false);
    expect(inbound.matchInboundAddress(["other+s3cr3tT0ken@inbound.example.com"], expected)).toBe(false);
    expect(inbound.matchInboundAddress(["invoices+s3cr3tT0ken@evil.example.com"], expected)).toBe(false);
    expect(inbound.matchInboundAddress(["invoices+s3cr3tT0ken@anywhere.example"], { token: "s3cr3tT0ken" })).toBe(true);
    expect(inbound.matchInboundAddress(["invoices+s3cr3tT0ken@inbound.example.com"], { token: undefined })).toBe(false);
  });
  it("accepts the plain invoices@domain address when no token is configured — domain required", () => {
    const plain = { token: null, localPart: "invoices", domain: "buhlos.com" };
    expect(inbound.matchInboundAddress(["invoices@buhlos.com"], plain)).toBe(true);
    expect(inbound.matchInboundAddress(["Accounts <INVOICES@BUHLOS.COM>"], plain)).toBe(true);
    expect(inbound.matchInboundAddress(["invoices+anything@buhlos.com"], plain)).toBe(false);
    expect(inbound.matchInboundAddress(["invoice@buhlos.com"], plain)).toBe(false);
    expect(inbound.matchInboundAddress(["invoices@evil.example"], plain)).toBe(false);
    expect(inbound.matchInboundAddress(["invoices@buhlos.com"], { token: null, domain: null })).toBe(false);
    // a configured token still requires the plus form
    expect(inbound.matchInboundAddress(["invoices@buhlos.com"], { token: "t", domain: "buhlos.com" })).toBe(false);
  });
  it("reports the configured address and readiness", () => {
    expect(inbound.inboundAddress({ INVOICE_INBOUND_DOMAIN: "buhlos.com" })).toBe("invoices@buhlos.com");
    expect(inbound.inboundAddress({ INVOICE_INBOUND_DOMAIN: "buhlos.com", INVOICE_INBOUND_TOKEN: "abc" })).toBe("invoices+abc@buhlos.com");
    expect(inbound.inboundAddress({ INVOICE_INBOUND_TOKEN: "abc" })).toBeNull();
    expect(inbound.inboundConfigured({ RESEND_INBOUND_WEBHOOK_SECRET: "s", RESEND_API_KEY: "k", INVOICE_INBOUND_DOMAIN: "buhlos.com" })).toBe(true);
    expect(inbound.inboundConfigured({ RESEND_INBOUND_WEBHOOK_SECRET: "s", RESEND_API_KEY: "k" })).toBe(false);
  });
});

describe("selectPdfAttachments", () => {
  it("keeps PDFs by type or extension, drops inline images, caps the count", () => {
    const atts = [
      { id: "1", filename: "a.pdf", contentType: "application/pdf" },
      { id: "2", filename: "b.PDF", contentType: "application/octet-stream" },
      { id: "3", filename: "logo.png", contentType: "image/png", disposition: "inline" },
      { id: "4", filename: "photo.jpg", contentType: "image/jpeg" },
      { id: "5", filename: "notes.txt", contentType: "text/plain" },
    ];
    expect(inbound.selectPdfAttachments(atts).map((a: { id: string }) => a.id)).toEqual(["1", "2"]);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: String(i), filename: `${i}.pdf`, contentType: "application/pdf" }));
    expect(inbound.selectPdfAttachments(many)).toHaveLength(inbound.MAX_ATTACHMENTS);
  });
});

describe("downloadAttachment", () => {
  const okResponse = (bytes: Buffer, headers: Record<string, string> = {}) => ({
    ok: true,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    body: null,
  });
  it("refuses non-https URLs and oversized bodies", async () => {
    await expect(inbound.downloadAttachment("http://cdn.example/x", { maxBytes: 10, fetchImpl: async () => okResponse(Buffer.alloc(1)) })).rejects.toMatchObject({ code: "provider_error" });
    await expect(inbound.downloadAttachment("https://cdn.example/x", { maxBytes: 10, fetchImpl: async () => okResponse(Buffer.alloc(11)) })).rejects.toMatchObject({ code: "attachment_too_large" });
    await expect(inbound.downloadAttachment("https://cdn.example/x", { maxBytes: 10, fetchImpl: async () => okResponse(Buffer.alloc(1), { "content-length": "999" }) })).rejects.toMatchObject({ code: "attachment_too_large" });
  });
  it("returns the bytes of a small https download", async () => {
    const buf = await inbound.downloadAttachment("https://cdn.example/x", { maxBytes: 10, fetchImpl: async () => okResponse(Buffer.from("%PDF-1")) });
    expect(buf.toString()).toBe("%PDF-1");
  });
});
