import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Automatic booking through the real handler: trust bootstrap, scheduling,
 * the sweep booking a due invoice exactly once, hold, per-supplier
 * "always review", corrections clearing the schedule, review-only mode, the
 * cap, credit notes, and the Monday digest.
 */
const requireFromHere = createRequire(import.meta.url);
const resolve = (p: string) => requireFromHere.resolve(p);
const blobPath = resolve("../../../api/_lib/blob.js");
const authPath = resolve("../../../api/_lib/auth.js");
const flagsPath = resolve("../../../api/_lib/feature-flags.js");
const settingsPath = resolve("../../../api/_lib/feature-settings.js");
const auditPath = resolve("../../../api/_lib/audit-log.js");
const emailPath = resolve("../../../api/_lib/email.js");
const recipientsPath = resolve("../../../api/_lib/timesheet-email-settings.js");
const dbPath = resolve("../../../api/_lib/supabase-db.js");
const storePath = resolve("../../../api/_lib/invoices/store.js");
const pdfTextPath = resolve("../../../api/_lib/invoices/pdf-text.js");
const docStorePath = resolve("../../../api/_lib/invoices/document-store.js");
const pipelinePath = resolve("../../../api/_lib/invoices/pipeline.js");
const handlerPath = resolve("../../../api/invoices.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let store: MemoryStore;
let docs: Map<string, Buffer>;
let sent: Array<{ to: string[]; subject: string; text: string; html: string }>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
function createRes() {
  return {
    statusCode: 200, body: null as unknown, headers: {} as Record<string, string>, ended: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; return this; },
    end(payload?: unknown) { this.ended = payload ?? null; return this; },
  };
}
const cookie = () => `buhl_session=${auth.signSession({ userId: "u_admin", role: "admin", exp: Date.now() + 60_000 })}`;
async function call(opts: { method?: string; query?: Record<string, string>; body?: unknown; cron?: boolean }): Promise<Res> {
  const res = createRes();
  await handler({ method: opts.method || "GET", query: opts.query || {}, body: opts.body, headers: opts.cron ? { authorization: "Bearer cs" } : { cookie: cookie() } }, res);
  return res;
}
const pdfOf = (text: string) => Buffer.from("%PDF-1.4\n" + text);
const dataUrl = (text: string) => `data:application/pdf;base64,${pdfOf(text).toString("base64")}`;
type Inv = Record<string, unknown> & { id: string; status: string; autoConfirmAt: string | null; autoConfirmEligible: boolean; heldAt: string | null; confirmedBy: string | null; autoConfirmChecks: Array<{ code: string; ok: boolean }> };
async function upload(text: string): Promise<Inv> {
  const r = await call({ method: "POST", query: { action: "upload" }, body: { filename: "inv.pdf", dataUrl: dataUrl(text) } });
  expect(r.statusCode).toBe(201);
  return (r.body as { invoice: Inv }).invoice;
}
const failedChecks = (inv: Inv) => inv.autoConfirmChecks.filter((c) => !c.ok).map((c) => c.code);
const invoiceOf = (id: string) => store.invoices.find((r) => r.id === id) as Inv;
const sweep = () => call({ query: { action: "sweep" }, cron: true });
const settings = (over: Record<string, unknown>) =>
  blob.set("feature-settings.json", { settings: { invoice_capture: { autoConfirm: true, autoConfirmCapDollars: 5000, autoConfirmGraceHours: 12, autoConfirmLookbackDays: 90, ...over } } });
const journal = () => {
  const out: Array<{ action: string; actorName: string; metadata?: Record<string, unknown> }> = [];
  for (const [k, v] of blob) if (k.startsWith("audit/")) out.push(...((v as { entries: typeof out }).entries || []));
  return out;
};
// a second, different invoice from the same supplier (new number, new bytes)
const SECOND = F.TAX_INVOICE_IV0041.replace("SS-88123", "SS-88124").replace("2.5mm TPS cable 100m", "4mm TPS cable 100m");
const THIRD = F.TAX_INVOICE_IV0041.replace("SS-88123", "SS-88125");

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_INVOICE_CAPTURE = "true";
  process.env.CRON_SECRET = "cs";
  vi.useFakeTimers({ now: new Date("2026-09-22T00:00:00Z"), toFake: ["Date"] });
  blob = new Map<string, unknown>([
    ["jobs.json", { jobs: F.JOBS }],
    ["users.json", { users: [{ id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] }] }],
    ["timesheet-email-settings.json", { recipients: ["accounts@example.com"], updatedAt: null, updatedBy: null }],
  ]);
  settings({});
  store = createMemoryStore();
  docs = new Map();
  sent = [];
  for (const p of [authPath, flagsPath, settingsPath, auditPath, recipientsPath, pipelinePath, handlerPath]) delete requireFromHere.cache[p];
  const mock = (path: string, exports: unknown) => { requireFromHere.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module; };
  mock(blobPath, {
    readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
    writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
    setNoCache: vi.fn(),
  });
  mock(dbPath, { getDb: () => ({}) });
  mock(storePath, store);
  mock(emailPath, { sendEmail: vi.fn(async (m: { to: string[]; subject: string; text: string; html: string }) => { sent.push(m); return { ok: true, id: "e" }; }), isEmailConfigured: () => true });
  mock(pdfTextPath, { extractPdfText: async (bytes: Buffer) => { const text = bytes.toString().replace(/^%PDF-1\.4\n/, ""); return { text, pageCount: 1, hasTextLayer: true }; } });
  mock(docStorePath, {
    storeInvoicePdf: async ({ invoiceId, filename, bytes }: { invoiceId: string; filename: string; bytes: Buffer }) => { const p = `invoices/buhl/${invoiceId}/${filename}`; docs.set(p, bytes); return { url: `blob://${p}`, pathname: p }; },
    fetchInvoicePdf: async (url: string) => docs.get(url.slice("blob://".length))!,
    sha256Hex: (b: Buffer) => requireFromHere("node:crypto").createHash("sha256").update(b).digest("hex"),
  });
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.FLAG_INVOICE_CAPTURE;
  delete process.env.CRON_SECRET;
});

/** Bootstrap trust: a person confirms the supplier's first invoice. */
async function trustSupplier(): Promise<Inv> {
  const first = await upload(F.TAX_INVOICE_IV0041);
  expect(first.status).toBe("matched");
  expect(first.autoConfirmEligible).toBe(false);
  expect(failedChecks(first)).toEqual(["supplier_trusted"]);
  expect((await call({ method: "POST", query: { action: "confirm", id: first.id } })).statusCode).toBe(200);
  return first;
}

describe("automatic booking — scheduling and the sweep", () => {
  it("the first invoice from a supplier always waits for a person; the next clean one schedules itself", async () => {
    await trustSupplier();
    const second = await upload(SECOND);
    expect(second.status).toBe("matched");
    expect(second.autoConfirmEligible).toBe(true);
    expect(second.autoConfirmAt).toBe("2026-09-22T12:00:00.000Z");
    expect(store.events.filter((e) => e.invoiceId === second.id).map((e) => e.event)).toContain("auto_confirm_scheduled");
    const soon = (await call({ query: { autoConfirm: "pending", status: "matched" } })).body as { invoices: Inv[]; autoConfirmPendingCount: number };
    expect(soon.invoices.map((i) => i.id)).toEqual([second.id]);
    expect(soon.autoConfirmPendingCount).toBe(1);
  });

  it("the sweep books a due invoice exactly once, attributed to BuhlOS (auto), and never before its time", async () => {
    await trustSupplier();
    const second = await upload(SECOND);
    let r = await sweep();
    expect((r.body as { booked: unknown[] }).booked).toEqual([]);
    expect(invoiceOf(second.id).status).toBe("matched");
    vi.setSystemTime(new Date("2026-09-22T12:30:00Z"));
    r = await sweep();
    expect((r.body as { booked: Array<{ id: string; booked: boolean }> }).booked).toEqual([{ id: second.id, booked: true }]);
    const inv = invoiceOf(second.id);
    expect(inv).toMatchObject({ status: "confirmed", confirmedBy: "BuhlOS (auto)", autoConfirmAt: null });
    expect(store.allocations.filter((a) => a.invoiceId === second.id && a.status === "active")).toHaveLength(1);
    expect(store.events.filter((e) => e.invoiceId === second.id).map((e) => e.event)).toContain("auto_confirmed");
    expect(journal().find((e) => e.action === "invoice.auto_confirmed")).toMatchObject({ actorName: "BuhlOS (auto)" });
    // a second sweep finds nothing to book and nothing changes
    r = await sweep();
    expect((r.body as { booked: unknown[] }).booked).toEqual([]);
    expect(store.allocations.filter((a) => a.status === "active")).toHaveLength(2);
    const summary = (await call({ query: { action: "job-summary", jobId: "birdwood" } })).body as Record<string, unknown>;
    expect(summary).toMatchObject({ confirmedCents: 216000, confirmedCount: 2, awaitingCount: 0 });
  });

  it("a human confirmation before the deadline wins, and the sweep does nothing", async () => {
    await trustSupplier();
    const second = await upload(SECOND);
    expect((await call({ method: "POST", query: { action: "confirm", id: second.id } })).statusCode).toBe(200);
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
    expect(((await sweep()).body as { booked: unknown[] }).booked).toEqual([]);
    expect(invoiceOf(second.id).confirmedBy).toBe("Karen Boss");
    expect(store.allocations.filter((a) => a.invoiceId === second.id)).toHaveLength(1);
  });
});

describe("automatic booking — the ways a person keeps control", () => {
  it("Hold stops the booking; a person can still confirm", async () => {
    await trustSupplier();
    const second = await upload(SECOND);
    const held = (await call({ method: "POST", query: { action: "hold", id: second.id } })).body as { invoice: Inv };
    expect(held.invoice).toMatchObject({ autoConfirmAt: null, heldBy: "Karen Boss" });
    expect(held.invoice.heldAt).toBeTruthy();
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
    expect(((await sweep()).body as { booked: unknown[] }).booked).toEqual([]);
    expect(invoiceOf(second.id).status).toBe("matched");
    expect(journal().map((e) => e.action)).toContain("invoice.held");
    expect((await call({ method: "POST", query: { action: "confirm", id: second.id } })).statusCode).toBe(200);
  });

  it("'always review this supplier' holds the current invoice and makes later ones ineligible", async () => {
    await trustSupplier();
    const second = await upload(SECOND);
    const r = (await call({ method: "POST", query: { action: "supplier-pref", id: second.id }, body: { alwaysReview: true } })).body as { invoice: Inv; supplierPref: { alwaysReview: boolean } };
    expect(r.supplierPref.alwaysReview).toBe(true);
    expect(r.invoice.autoConfirmAt).toBeNull();
    const third = await upload(THIRD);
    expect(third.autoConfirmEligible).toBe(false);
    expect(failedChecks(third)).toEqual(["supplier_not_flagged"]);
    expect(journal().map((e) => e.action)).toContain("invoice.supplier_pref_changed");
  });

  it("any correction or job change clears the schedule — a person's edit means a person finishes it", async () => {
    await trustSupplier();
    const second = await upload(SECOND);
    const fixed = (await call({ method: "PUT", query: { id: second.id }, body: { invoiceDate: "2026-09-04" } })).body as { invoice: Inv };
    expect(fixed.invoice).toMatchObject({ autoConfirmAt: null, autoConfirmEligible: false, status: "matched" });
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
    expect(((await sweep()).body as { booked: unknown[] }).booked).toEqual([]);
  });

  it("if the job stops being active before the deadline, the sweep skips it", async () => {
    await trustSupplier();
    const second = await upload(SECOND);
    blob.set("jobs.json", { jobs: F.JOBS.map((j) => (j.id === "birdwood" ? { ...j, status: "complete" } : j)) });
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
    expect(((await sweep()).body as { booked: Array<{ booked: boolean }> }).booked).toEqual([{ id: second.id, booked: false }]);
    expect(invoiceOf(second.id).status).toBe("matched");
    expect(store.events.filter((e) => e.invoiceId === second.id).map((e) => e.event)).toContain("auto_confirm_skipped");
  });
});

describe("automatic booking — knobs and document rules", () => {
  it("review-only mode (knob off) records the verdict but never books", async () => {
    settings({ autoConfirm: false });
    await trustSupplier();
    const second = await upload(SECOND);
    expect(second).toMatchObject({ autoConfirmEligible: true, autoConfirmAt: null });
    expect(store.events.filter((e) => e.invoiceId === second.id).map((e) => e.event)).toContain("auto_confirm_eligible");
    vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    expect(((await sweep()).body as { booked: unknown[] }).booked).toEqual([]);
    const setup = (await call({ query: { action: "setup" } })).body as { autoConfirm: { enabled: boolean } };
    expect(setup.autoConfirm.enabled).toBe(false);
  });

  it("the cap keeps big invoices human", async () => {
    await trustSupplier();
    settings({ autoConfirmCapDollars: 1000 });
    const second = await upload(SECOND); // $1,080 ex GST
    expect(failedChecks(second)).toEqual(["under_cap"]);
  });

  it("a clean credit note schedules only once the supplier has a confirmed invoice on that job", async () => {
    const cn = await upload(F.CREDIT_NOTE_IV0041);
    expect(failedChecks(cn)).toEqual(expect.arrayContaining(["supplier_trusted", "credit_has_invoice"]));
    await trustSupplier();
    const cn2 = await upload(F.CREDIT_NOTE_IV0041.replace("CN-2001", "CN-2002"));
    expect(cn2.autoConfirmEligible).toBe(true);
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
    await sweep();
    expect(store.allocations.find((a) => a.invoiceId === cn2.id)).toMatchObject({ amountCents: -12000, confirmedBy: "BuhlOS (auto)" });
  });

  it("a statement, an unknown IV or inconsistent totals never schedule", async () => {
    await trustSupplier();
    for (const text of [F.STATEMENT, F.INVOICE_UNKNOWN_IV, F.INVOICE_GST_INCONSISTENT]) {
      const inv = await upload(text);
      expect(inv.autoConfirmAt).toBeNull();
      expect(inv.autoConfirmEligible).toBe(false);
    }
  });
});

describe("the Monday digest", () => {
  it("emails the accounts list a summary with links and the health line", async () => {
    await trustSupplier();
    const second = await upload(SECOND);
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
    await sweep();
    await upload(F.INVOICE_UNKNOWN_IV); // waiting on a person
    const r = await call({ query: { action: "digest" }, cron: true });
    expect(r.body).toMatchObject({ sent: true, recipients: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["accounts@example.com"]);
    expect(sent[0]!.subject).toContain("1 booked automatically, 1 waiting on you");
    expect(sent[0]!.text).toContain("SS-88124");
    expect((sent[0] as { html: string }).html).toContain(`/invoices/${second.id}`);
    expect(sent[0]!.text).toContain("IV0041 · Birdwood");
  });
  it("sends nothing when there are no recipients, and needs the cron secret", async () => {
    blob.set("timesheet-email-settings.json", { recipients: [], updatedAt: null, updatedBy: null });
    expect((await call({ query: { action: "digest" }, cron: true })).body).toEqual({ skipped: "no_recipients" });
    const res = createRes();
    await handler({ method: "GET", query: { action: "digest" }, headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(sent).toEqual([]);
  });
});

describe("mid-week alerts from the sweep (2026-09-23)", () => {
  const alertsSent = () => sent.filter((m) => m.subject.startsWith("BuhlOS invoices need attention"));
  it("a healthy inbox sends nothing and leaves no state", async () => {
    const r = await sweep();
    expect((r.body as { alert: { key: string; sent: boolean } }).alert).toEqual({ key: "", sent: false });
    expect(alertsSent()).toEqual([]);
    expect(blob.has("invoices/alert-state.json")).toBe(false);
  });
  it("a failed document alerts the accounts list once, not again on the next sweep, again after a day, and clears when fixed", async () => {
    store.invoices.push({ ...(await (store.createInvoice as (...a: unknown[]) => Promise<Record<string, unknown>>)(null, "t", { source: "upload" })), status: "failed" } as never);
    // createInvoice already pushed the row; keep only the failed copy
    store.invoices.splice(store.invoices.length - 2, 1);
    let r = await sweep();
    expect((r.body as { alert: { key: string; sent: boolean } }).alert).toEqual({ key: "failed", sent: true });
    expect(alertsSent()).toHaveLength(1);
    expect(alertsSent()[0]!.to).toEqual(["accounts@example.com"]);
    expect(alertsSent()[0]!.text).toContain("could not be read after three attempts");
    r = await sweep();
    expect((r.body as { alert: { sent: boolean } }).alert.sent).toBe(false);
    expect(alertsSent()).toHaveLength(1);
    vi.setSystemTime(new Date("2026-09-23T01:00:00Z"));
    r = await sweep();
    expect((r.body as { alert: { sent: boolean } }).alert.sent).toBe(true);
    expect(alertsSent()).toHaveLength(2);
    // fixed by a person → the state clears, so a NEW problem later alerts at once
    store.invoices[0]!.status = "archived";
    r = await sweep();
    expect((r.body as { alert: { key: string } }).alert.key).toBe("");
    expect(blob.get("invoices/alert-state.json")).toMatchObject({ key: "" });
    store.invoices[0]!.status = "failed";
    r = await sweep();
    expect((r.body as { alert: { sent: boolean } }).alert.sent).toBe(true);
  });
  it("a long silence alerts according to the owner knob; 0 turns it off", async () => {
    store.inbound.push({ id: "i1", svixId: "old", emailId: "e", toMatched: true, status: "processed", createdAt: "2026-09-10T00:00:00Z", processedAt: null } as never);
    settings({ alertQuietDays: 7 });
    let r = await sweep();
    expect((r.body as { alert: { key: string; sent: boolean } }).alert).toEqual({ key: "quiet", sent: true });
    expect(alertsSent()[0]!.text).toContain("No supplier email has arrived for 12 days");
    settings({ alertQuietDays: 0 });
    blob.delete("invoices/alert-state.json");
    r = await sweep();
    expect((r.body as { alert: { key: string } }).alert.key).toBe("");
  });
});
