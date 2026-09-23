import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";

/**
 * Inbound safety net (owner direction 2026-09-23):
 *   - stray replies to the app's own sender addresses are FORWARDED to the
 *     accounts list instead of vanishing (forward.js + webhook)
 *   - the sweep raises a mid-week alert, at most once a day per condition set
 *     (alerts.js; the sweep wiring is covered in invoices-auto-booking-api.test.ts)
 */
const requireFromHere = createRequire(import.meta.url);
const fwd = requireFromHere("../../../api/_lib/invoices/forward.js");
const alerts = requireFromHere("../../../api/_lib/invoices/alerts.js");
const { handleInboundWebhook } = requireFromHere("../../../api/_lib/invoices/webhook.js");

describe("forward — which addresses count as stray office mail", () => {
  it("matches the app's own sender local parts on the inbound domain only, case/plus-insensitive", () => {
    const opts = { domain: "buhlos.com", localParts: fwd.forwardLocalParts({}) };
    expect(fwd.matchStrayAddress(["Timesheets <Timesheets@BuhlOS.com>"], opts)).toBe("timesheets@buhlos.com");
    expect(fwd.matchStrayAddress(["pay+bounce@buhlos.com"], opts)).toBe("pay+bounce@buhlos.com");
    expect(fwd.matchStrayAddress(["invoices@buhlos.com"], opts)).toBeNull(); // the invoice address is not stray
    expect(fwd.matchStrayAddress(["random@buhlos.com"], opts)).toBeNull(); // nobody's mailbox → ignored
    expect(fwd.matchStrayAddress(["timesheets@other.example"], opts)).toBeNull();
    expect(fwd.matchStrayAddress(["timesheets@buhlos.com"], { domain: null, localParts: ["timesheets"] })).toBeNull();
  });
  it("the list is env-overridable and sanitised", () => {
    expect(fwd.forwardLocalParts({ INBOUND_FORWARD_LOCAL_PARTS: " Accounts, timesheets ,bad one,x@y " })).toEqual(["accounts", "timesheets"]);
    expect(fwd.forwardLocalParts({})).toEqual(fwd.DEFAULT_LOCAL_PARTS);
  });
  it("builds the outgoing message with the sender as reply-to, an intro, and escaped html", () => {
    const m = fwd.buildForward({
      email: { from: "Tia <tia@accounts.example>", subject: "Re: Timesheets week 38", text: "Looks wrong for Borg", html: "<p>Looks <b>wrong</b></p>" },
      address: "timesheets@buhlos.com", from: "BuhlOS <noreply@buhlos.com>", recipients: ["a@x.example"], attachments: [{ filename: "x.pdf", content: "AAAA" }],
    });
    expect(m).toMatchObject({ to: ["a@x.example"], from: "BuhlOS <noreply@buhlos.com>", replyTo: "tia@accounts.example", subject: "[timesheets@buhlos.com] Re: Timesheets week 38" });
    expect(m.text).toContain("Sent to timesheets@buhlos.com by Tia <tia@accounts.example>");
    expect(m.text).toContain("Looks wrong for Borg");
    expect(m.html).toContain("Tia &lt;tia@accounts.example&gt;");
    expect(m.html).toContain("<p>Looks <b>wrong</b></p>");
    expect(m.attachments).toHaveLength(1);
    expect(fwd.bareAddress("not an address")).toBeNull();
  });
  it("forwardStrayEmail fetches the email + attachments and sends once; refuses without recipients or a sender", async () => {
    const sent: unknown[] = [];
    const resend = {
      fetchReceivedEmail: async () => ({ from: "x@y.example", subject: "Hi", text: "body", attachments: [{ id: "a1", filename: "doc.pdf" }, { id: "logo", filename: "l.png", content_disposition: "inline" }] }),
      fetchAttachmentMeta: async (_e: string, id: string) => ({ download_url: `https://cdn/${id}` }),
      downloadAttachment: async () => Buffer.from("%PDF-1.4 x"),
    };
    const deps = { resend, apiKey: "k", sendEmail: async (m: unknown) => { sent.push(m); return { ok: true }; }, recipients: ["acc@x.example"], from: "BuhlOS <noreply@buhlos.com>" };
    const r = await fwd.forwardStrayEmail({ emailId: "e1", address: "timesheets@buhlos.com", deps });
    expect(r).toEqual({ ok: true, reason: undefined, attachments: 1 }); // the inline logo is skipped
    expect(sent).toHaveLength(1);
    expect(await fwd.forwardStrayEmail({ emailId: "e1", address: "a", deps: { ...deps, recipients: [] } })).toMatchObject({ ok: false, reason: "no_recipients" });
    expect(await fwd.forwardStrayEmail({ emailId: "e1", address: "a", deps: { ...deps, from: null } })).toMatchObject({ ok: false, reason: "no_sender" });
  });
});

describe("alerts — what needs a person, and how often it is said", () => {
  const clean = { failedCount: 0, stuckCount: 0, quarantinedOldCount: 0, forwardFailedCount: 0, lastReceivedAt: "2026-09-22T00:00:00Z", everReceived: true };
  const now = Date.parse("2026-09-23T00:00:00Z");
  it("a healthy inbox raises nothing; each condition names itself", () => {
    expect(alerts.evaluateAlerts(clean, { quietDays: 7, providerAuthFailed: false, now })).toEqual([]);
    const codes = alerts.evaluateAlerts({ ...clean, failedCount: 2, stuckCount: 1, quarantinedOldCount: 1, forwardFailedCount: 1 }, { quietDays: 7, providerAuthFailed: true, now }).map((c: { code: string }) => c.code);
    expect(codes).toEqual(["provider_auth", "failed", "stuck", "quarantined", "forward_failed"]);
  });
  it("quiet fires only after the knob's days, only once something ever arrived, and never when the knob is 0", () => {
    const quiet = { ...clean, lastReceivedAt: "2026-09-10T00:00:00Z" };
    expect(alerts.evaluateAlerts(quiet, { quietDays: 7, providerAuthFailed: false, now }).map((c: { code: string }) => c.code)).toEqual(["quiet"]);
    expect(alerts.evaluateAlerts(quiet, { quietDays: 14, providerAuthFailed: false, now })).toEqual([]);
    expect(alerts.evaluateAlerts(quiet, { quietDays: 0, providerAuthFailed: false, now })).toEqual([]);
    expect(alerts.evaluateAlerts({ ...quiet, everReceived: false, lastReceivedAt: null }, { quietDays: 7, providerAuthFailed: false, now })).toEqual([]);
  });
  it("sends on a new condition set, then at most once a day, and never for an empty set", () => {
    expect(alerts.shouldSend({ key: "", sentAt: null }, "failed", now)).toBe(true);
    expect(alerts.shouldSend({ key: "failed", sentAt: new Date(now - 3_600_000).toISOString() }, "failed", now)).toBe(false);
    expect(alerts.shouldSend({ key: "failed", sentAt: new Date(now - 25 * 3_600_000).toISOString() }, "failed", now)).toBe(true);
    expect(alerts.shouldSend({ key: "failed", sentAt: new Date(now - 60_000).toISOString() }, "failed,quiet", now)).toBe(true);
    expect(alerts.shouldSend({ key: "", sentAt: null }, "", now)).toBe(false);
    const m = alerts.buildAlertEmail([{ code: "failed", text: "2 documents <failed>" }], { inboxUrl: "https://buhlos.com/invoices" });
    expect(m.subject).toBe("BuhlOS invoices need attention — 1 thing to look at");
    expect(m.html).toContain("2 documents &lt;failed&gt;");
    expect(m.text).toContain("https://buhlos.com/invoices");
  });
});

describe("webhook — stray replies are forwarded, everything else stays ignored", () => {
  const SECRET = "whsec_" + Buffer.from("test-signing-key-32-bytes-long!!").toString("base64");
  const NOW = 1_700_000_000;
  const env = { RESEND_INBOUND_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: "re_test", INVOICE_INBOUND_DOMAIN: "buhlos.com" };
  function sign(body: string, id = "msg_1") {
    const sig = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${NOW}.${body}`).digest("base64");
    return { "svix-id": id, "svix-timestamp": String(NOW), "svix-signature": `v1,${sig}` };
  }
  const event = (to: string) => JSON.stringify({ type: "email.received", data: { email_id: "email_9", from: "tia@accounts.example", to: [to], subject: "Re: Timesheets", attachments: [] } });
  let store: MemoryStore;
  let forwards: Array<{ emailId: string; address: string }>;
  const deps = (over: Record<string, unknown> = {}) => ({
    isFlagOn: async () => true, getDb: () => ({}), store, ingest: async () => ({ created: [], skipped: [] }), resend: {}, storePdf: async () => ({}), sha256: () => "s", nowSec: NOW,
    forward: async ({ emailId, address }: { emailId: string; address: string }) => { forwards.push({ emailId, address }); return { ok: true, attachments: 0 }; },
    ...over,
  });
  beforeEach(() => { store = createMemoryStore(); forwards = []; });

  it("a reply to timesheets@ is forwarded and the receipt says so", async () => {
    const body = event("timesheets@buhlos.com");
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    expect(r).toEqual({ status: 200, body: { forwarded: true } });
    expect(forwards).toEqual([{ emailId: "email_9", address: "timesheets@buhlos.com" }]);
    expect(store.inbound[0]).toMatchObject({ status: "forwarded", toMatched: false });
    expect(store.invoices).toEqual([]);
  });
  it("mail to an address nobody owns is still ignored, nothing forwarded", async () => {
    const body = event("someone@buhlos.com");
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    expect(r.body).toEqual({ ignored: true });
    expect(forwards).toEqual([]);
    expect(store.inbound[0]!.status).toBe("ignored");
  });
  it("without a forward dependency (older wiring) the old behaviour holds", async () => {
    const body = event("timesheets@buhlos.com");
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps({ forward: undefined }) });
    expect(r.body).toEqual({ ignored: true });
  });
  it("a failed or throwing forward is recorded with its reason and still acknowledged (no provider retry)", async () => {
    const body = event("office@buhlos.com");
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps({ forward: async () => ({ ok: false, reason: "no_recipients", attachments: 0 }) }) });
    expect(r).toEqual({ status: 200, body: { forwarded: false } });
    expect(store.inbound[0]).toMatchObject({ status: "ignored", failureCode: "forward_failed:no_recipients" });
    const body2 = event("pay@buhlos.com");
    const r2 = await handleInboundWebhook({ rawBody: body2, headers: sign(body2, "msg_2"), env, deps: deps({ forward: async () => { throw Object.assign(new Error("boom"), { code: "provider_auth" }); } }) });
    expect(r2.status).toBe(200);
    expect(store.inbound[1]).toMatchObject({ status: "ignored", failureCode: "forward_failed:provider_auth" });
  });
  it("a replay of a forwarded delivery is a no-op", async () => {
    const body = event("timesheets@buhlos.com");
    await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    const r = await handleInboundWebhook({ rawBody: body, headers: sign(body), env, deps: deps() });
    expect(r.body).toEqual({ replay: true });
    expect(forwards).toHaveLength(1);
  });
});
