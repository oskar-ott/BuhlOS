import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";

/**
 * Catch-up path (owner, 2026-09-27: "send a bunch of past emails"): Outlook's
 * forward-as-attachment wraps each original email as a .eml with the PDF
 * inside. The ingest unpacks it — every document inside becomes its own
 * record, keyed so a replay is a no-op — and provider calls retry through a
 * burst instead of failing the webhook.
 */
const requireFromHere = createRequire(import.meta.url);
const { parseEml, parseParam, decodeWords } = requireFromHere("../../../api/_lib/invoices/eml.js");
const { ingestReceivedEmail } = requireFromHere("../../../api/_lib/invoices/ingest.js");
const inbound = requireFromHere("../../../api/_lib/invoices/resend-inbound.js");

const PDF = Buffer.from("%PDF-1.4\n% a real enough pdf for the sniffer");
const PNG_BIG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60_000, 1)]);
const b64 = (b: Buffer) => b.toString("base64").match(/.{1,76}/g)!.join("\r\n");

function innerEmail(over: { subject?: string; extra?: string } = {}) {
  return [
    "From: AP <ap@sparky.example>",
    `Subject: ${over.subject ?? "=?UTF-8?B?VGF4IEludm9pY2UgU1MtODgxMjM=?="}`,
    'Content-Type: multipart/mixed; boundary="inner1"',
    "",
    "--inner1",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Please find attached =E2=80=94 thanks",
    "--inner1",
    'Content-Type: application/pdf; name="SS-88123.pdf"',
    "Content-Disposition: attachment; filename*=UTF-8''SS-88123%20Sept.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    b64(PDF),
    "--inner1",
    'Content-Type: image/png; name="logo.png"',
    "Content-Disposition: inline; filename=logo.png",
    "Content-Transfer-Encoding: base64",
    "",
    b64(PNG_BIG),
    over.extra ?? "",
    "--inner1--",
    "",
  ].join("\r\n");
}
function outerForward(inners: string[]) {
  return [
    "From: Office <office@buhl.example>",
    "Subject: FW: 2 invoices",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    "Content-Type: text/plain",
    "",
    "see attached",
    ...inners.flatMap((inner, i) => ["--outer", `Content-Type: message/rfc822; name="Invoice ${i + 1}.eml"`, "Content-Disposition: attachment", "", inner]),
    "--outer--",
    "",
  ].join("\r\n");
}

describe("parseEml", () => {
  it("reads a forwarded email: decoded subject, the PDF with its RFC 2231 name, the inline logo flagged", () => {
    const r = parseEml(Buffer.from(innerEmail()));
    expect(r.subject).toBe("Tax Invoice SS-88123");
    expect(r.from).toBe("AP <ap@sparky.example>");
    expect(r.parts.map((p: { filename: string; contentType: string; inline: boolean; bytes: Buffer }) => [p.filename, p.contentType, p.inline, p.bytes.length])).toEqual([
      ["SS-88123 Sept.pdf", "application/pdf", false, PDF.length],
      ["logo.png", "image/png", true, PNG_BIG.length],
    ]);
    expect(r.parts[0].bytes.equals(PDF)).toBe(true);
  });
  it("walks into nested message/rfc822 parts (several emails forwarded at once) and keeps the outer subject", () => {
    const r = parseEml(outerForward([innerEmail(), innerEmail({ subject: "Invoice SS-88200" })]));
    expect(r.subject).toBe("FW: 2 invoices");
    expect(r.parts.filter((p: { contentType: string }) => p.contentType === "application/pdf")).toHaveLength(2);
  });
  it("header helpers: quoted and RFC 2231 params, encoded words, junk", () => {
    expect(parseParam('application/pdf; name="a b.pdf"')).toEqual({ value: "application/pdf", params: { name: "a b.pdf" } });
    expect(parseParam("attachment; filename*=UTF-8''My%20Invoice.pdf").params.filename).toBe("My Invoice.pdf");
    expect(decodeWords("=?UTF-8?Q?Caf=C3=A9_invoice?=")).toBe("Café invoice");
    expect(parseEml("not an email at all").parts).toEqual([]);
    expect(parseEml("").subject).toBeNull();
  });
});

describe("ingest — a forwarded-as-attachment email is unpacked", () => {
  let store: MemoryStore;
  const T = "tenant";
  const deps = (attachments: Array<Record<string, unknown>>, bytes: Record<string, Buffer>) => ({
    store,
    resend: {
      fetchReceivedEmail: async () => ({ subject: "FW: invoices", from: "office@buhl.example", attachments }),
      fetchAttachmentMeta: async (_e: string, id: string) => ({ download_url: `https://cdn/${id}` }),
      downloadAttachment: async (url: string) => bytes[url.split("/").pop()!],
    },
    storePdf: async ({ invoiceId, filename }: { invoiceId: string; filename: string }) => ({ url: `blob://${invoiceId}/${filename}`, pathname: `${invoiceId}/${filename}` }),
    sha256: (b: Buffer) => requireFromHere("node:crypto").createHash("sha256").update(b).digest("hex"),
    apiKey: "k",
  });
  beforeEach(() => { store = createMemoryStore(); });

  it("two emails forwarded at once → two invoice records, each with its own subject and PDF; logos skipped; a replay adds nothing", async () => {
    const d = deps([{ id: "eml1", filename: "Invoice 1.eml", content_type: "message/rfc822" }, { id: "eml2", filename: "Invoice 2.eml", content_type: "message/rfc822" }],
      { eml1: Buffer.from(innerEmail()), eml2: Buffer.from(innerEmail({ subject: "Invoice SS-88200" })) });
    const r = await ingestReceivedEmail({ sql: null, tenant: { id: T, slug: "buhl" }, emailId: "e1", deps: d });
    expect(r.created).toHaveLength(2);
    expect(r.reviewItem).toBeNull();
    expect(store.invoices.map((i) => i.sourceSubject)).toEqual(["Tax Invoice SS-88123", "Invoice SS-88200"]);
    expect(store.invoices[0]!.sourceFrom).toBe("AP <ap@sparky.example>");
    expect(store.documents.map((doc) => [doc.providerAttachmentId, doc.filename, doc.kind])).toEqual([["eml1#1", "SS-88123 Sept.pdf", "pdf"], ["eml2#1", "SS-88123 Sept.pdf", "pdf"]]);
    const again = await ingestReceivedEmail({ sql: null, tenant: { id: T, slug: "buhl" }, emailId: "e1", deps: d });
    expect(again.created).toEqual([]);
    expect(store.invoices).toHaveLength(2);
  });
  it("a .eml with nothing usable inside still becomes one review item that says so", async () => {
    const d = deps([{ id: "eml9", filename: "note.eml", content_type: "message/rfc822" }], { eml9: Buffer.from("Subject: hi\r\nContent-Type: text/plain\r\n\r\njust words") });
    const r = await ingestReceivedEmail({ sql: null, tenant: { id: T, slug: "buhl" }, emailId: "e2", deps: d });
    expect(r.skipped).toEqual([{ attachmentId: "eml9", reason: "eml_no_documents" }]);
    expect(store.invoices[0]).toMatchObject({ status: "needs_review", reviewReasons: ["forwarded_as_attachment"] });
  });
});

describe("provider calls retry through a burst", () => {
  it("a 429 with retry-after is retried and then succeeds; a 404 is not retried; a persistent 429 gives up with its code", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) return { ok: false, status: 429, headers: { get: (h: string) => (h === "retry-after" ? "1" : null) } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: "email_1" }) };
    };
    const out = await inbound.fetchReceivedEmail("email_1", { apiKey: "k", fetchImpl: flaky, retry: { sleep, baseMs: 10 } });
    expect(out).toEqual({ id: "email_1" });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 1000]); // the provider's hint wins over the base backoff

    let notFound = 0;
    await expect(inbound.fetchReceivedEmail("x", { apiKey: "k", fetchImpl: async () => { notFound++; return { ok: false, status: 404, headers: { get: () => null } }; }, retry: { sleep, baseMs: 10 } })).rejects.toMatchObject({ code: "provider_not_found" });
    expect(notFound).toBe(1);

    let limited = 0;
    await expect(inbound.fetchReceivedEmail("y", { apiKey: "k", fetchImpl: async () => { limited++; return { ok: false, status: 429, headers: { get: () => null } }; }, retry: { sleep, baseMs: 10 } })).rejects.toMatchObject({ code: "provider_rate_limited" });
    expect(limited).toBe(3);
  });
});
