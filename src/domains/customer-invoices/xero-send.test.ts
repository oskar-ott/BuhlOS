import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeXero, type FakeXero } from "./test-helpers/fake-xero";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";

/**
 * api/_lib/customer-invoices/xero-send.js (#1150) — the ONE write to Xero.
 * The real service runs against an in-memory store with the SQL's guards and
 * a stand-in Xero that can be made to time out, refuse, or lose its answer.
 *
 * The property everything here defends: A SEND CAN NEVER CREATE TWO INVOICES,
 * whatever fails and however often someone presses the button.
 */
const requireFromHere = createRequire(import.meta.url);
const S = requireFromHere("../../../api/_lib/customer-invoices/xero-send.js");

const tenant = { id: "t1" };
const actor = { id: "u_admin", name: "Karen Boss" };
const job = { id: "tower", name: "Tower Fit-out", code: "IV3345", siteAddress: "12 Smith St", contractValue: 250000 };
const SETTINGS = { salesAccountCode: "200", salesAccountName: "Sales", taxType: "OUTPUT", taxName: "GST on Income", taxRateBp: 1000, paymentTermsDays: 30 };
const ENV = { APP_BASE_URL: "https://buhlos.com" };

let mem: MemoryStore;
let xero: FakeXero;
let ready: { state: string; organisationName: string | null; externalTenantId: string | null };
let ids: number;

const deps = () => ({
  sql: {},
  store: mem,
  xeroFetch: xero.xeroFetch,
  lookups: { readiness: async () => ready },
  env: ENV,
  newId: () => `attempt-${++ids}`,
});

async function addStage(over: Record<string, unknown> = {}) {
  return mem.createStage({}, "t1", "tower", {
    kind: "stage", title: "Deposit", basis: "percent", percentBp: 2000, amountCents: null, extraLines: [], retentionBp: null, plannedDate: null, note: null, ...over,
  });
}
const row = (id: string) => mem.rows.find((r) => r.id === id)!;
const send = (id: string, options: Record<string, unknown> = {}) =>
  S.send({ tenant, invoice: row(id), job, options: { expectedVersion: row(id).version, invoiceDate: "2026-11-22", ...options }, actor, deps: deps() });
const retry = (id: string) => S.retry({ tenant, invoice: row(id), job, actor, deps: deps() });
const reset = (id: string) => S.reset({ tenant, invoice: row(id), job, actor, deps: deps() });
const eventsOf = (id: string) => mem.events.filter((e) => e.invoiceId === id).map((e) => e.event);
const attemptsOf = (id: string) => mem.attempts.filter((a) => a.invoiceId === id).map((a) => a.outcome);

beforeEach(async () => {
  mem = createMemoryStore();
  xero = createFakeXero();
  ids = 0;
  ready = { state: "connected", organisationName: "Buhl Electrical", externalTenantId: "org-1" };
  await mem.saveProfile({}, "t1", "tower", { xeroContactId: "c-built", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1", retentionBp: 0 }, { expectedVersion: null });
  await mem.saveSettings({}, "t1", "org-1", SETTINGS, { expectedVersion: null });
});

describe("preview", () => {
  it("shows exactly what would be sent, the number it would get, and writes nothing", async () => {
    const s = await addStage();
    const p = await S.preview({ tenant, invoice: row(s.id), job, options: { invoiceDate: "2026-11-22" }, deps: deps() });
    expect(p.blockers).toEqual([]);
    expect(p.invoice).toMatchObject({
      invoiceNumber: "IV3345-1", contactName: "Built Pty Ltd", organisationName: "Buhl Electrical",
      invoiceDate: "2026-11-22", dueDate: "2026-12-22", reference: "IV3345 Tower Fit-out",
      netCents: 50_000_00, estimatedTaxCents: 5_000_00, estimatedTotalCents: 55_000_00,
      salesAccountCode: "200", taxName: "GST on Income", taxRateBp: 1000,
    });
    expect(p.invoice.lines).toEqual([{ description: "Deposit (20% of contract)\nTower Fit-out, 12 Smith St", amountCents: 50_000_00 }]);
    expect(xero.calls).toEqual([]);
    expect(row(s.id)).toMatchObject({ state: "planned", version: 1, seq: null });
    expect(mem.attempts).toEqual([]);
  });

  it("names what is stopping it, and still shows the invoice when it can be worked out", async () => {
    const s = await addStage();
    ready = { state: "missing_permission", organisationName: "Buhl Electrical", externalTenantId: "org-1" };
    const p = await S.preview({ tenant, invoice: row(s.id), job, deps: deps() });
    expect(p.blockers.map((b: { code: string }) => b.code)).toEqual(["xero_not_ready"]);
    expect(p.invoice).not.toBeNull();
  });

  it("shows no invoice when the defaults aren't chosen", async () => {
    mem.settings.clear();
    const s = await addStage();
    const p = await S.preview({ tenant, invoice: row(s.id), job, deps: deps() });
    expect(p.blockers.map((b: { code: string }) => b.code)).toContain("settings_incomplete");
    expect(p.invoice).toBeNull();
  });
});

describe("send — the happy path", () => {
  it("creates ONE draft in Xero, reads it back, and stores Xero's own figures", async () => {
    const s = await addStage();
    const out = await send(s.id);
    expect(out).toMatchObject({ outcome: "sent", verified: true, mismatches: [], invoiceNumber: "IV3345-1" });

    expect(xero.invoices).toHaveLength(1);
    const inv = xero.invoices[0]!;
    expect(inv).toMatchObject({ Type: "ACCREC", Status: "DRAFT", InvoiceNumber: "IV3345-1", Contact: { ContactID: "c-built" }, SubTotal: 50000, TotalTax: 5000, Total: 55000, Url: "https://buhlos.com/v2/jobs/tower" });

    expect(row(s.id)).toMatchObject({
      state: "sent", seq: 1, invoiceNumber: "IV3345-1", xeroInvoiceId: inv.InvoiceID, xeroStatus: "DRAFT",
      grossCents: 50_000_00, netCents: 50_000_00, invoiceDate: "2026-11-22", dueDate: "2026-12-22",
      xeroSubtotalCents: 50_000_00, xeroTaxCents: 5_000_00, xeroTotalCents: 55_000_00, drift: null,
      externalTenantId: "org-1", xeroContactId: "c-built",
    });
  });

  it("writes `pending` BEFORE calling Xero, then accepted, then verified — and one immutable attempt", async () => {
    const s = await addStage();
    // Record what the store held at the moment Xero was called.
    let eventsAtCall: string[] = [];
    let stateAtCall = "";
    const real = xero.xeroFetch;
    const spy = async (url: string, opts: { method?: string } = {}) => {
      if (opts.method === "PUT") {
        eventsAtCall = eventsOf(s.id);
        stateAtCall = row(s.id).state;
      }
      return real(url, opts);
    };
    await S.send({ tenant, invoice: row(s.id), job, options: { expectedVersion: 1, invoiceDate: "2026-11-22" }, actor, deps: { ...deps(), xeroFetch: spy } });
    expect(stateAtCall).toBe("sending");
    expect(eventsAtCall).toEqual(["created", "pending"]);
    expect(eventsOf(s.id)).toEqual(["created", "pending", "accepted_by_xero", "verified_against_xero"]);
    expect(attemptsOf(s.id)).toEqual(["accepted"]);
    expect(mem.attempts[0]).toMatchObject({ invoiceNumber: "IV3345-1", xeroInvoiceId: xero.invoices[0]!.InvoiceID, httpStatus: 200 });
  });

  it("sends a create-only PUT with an Idempotency-Key, then reads the invoice back", async () => {
    const s = await addStage();
    await send(s.id);
    expect(xero.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "PUT /api.xro/2.0/Invoices",
      `GET /api.xro/2.0/Invoices/${xero.invoices[0]!.InvoiceID}`,
    ]);
    expect(xero.puts()[0]!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{64}$/);
    expect(mem.attempts[0]!.idempotencyKey).toBe(xero.puts()[0]!.headers["Idempotency-Key"]);
  });

  it("numbers a job's stages in the order they are SENT, whatever order they were planned in", async () => {
    const a = await addStage({ title: "First planned" });
    const b = await addStage({ title: "Second planned" });
    expect((await send(b.id)).invoiceNumber).toBe("IV3345-1");
    expect((await send(a.id)).invoiceNumber).toBe("IV3345-2");
    expect(xero.invoices.map((i) => i.InvoiceNumber)).toEqual(["IV3345-1", "IV3345-2"]);
  });

  it("takes retention off as a negative line and freezes the retention used", async () => {
    await mem.saveProfile({}, "t1", "tower", { retentionBp: 500 }, { expectedVersion: 1 });
    const s = await addStage({ basis: "amount", percentBp: null, amountCents: 12_000_50, extraLines: [{ description: "Variation 3", amountCents: 1_200_00 }] });
    const out = await send(s.id);
    expect(out.verified).toBe(true);
    expect(xero.invoices[0]!.LineItems.map((l) => l.UnitAmount)).toEqual([12000.5, 1200, -660.03]);
    expect(row(s.id)).toMatchObject({ grossCents: 13_200_50, retentionBp: 500, retentionCents: 660_03, netCents: 12_540_47, xeroSubtotalCents: 12_540_47 });
  });

  it("uses the reference and date given at send", async () => {
    const s = await addStage();
    await send(s.id, { invoiceDate: "2026-12-01", reference: "PO 7781" });
    expect(xero.invoices[0]).toMatchObject({ Reference: "PO 7781", DateString: "2026-12-01T00:00:00", DueDateString: "2026-12-31T00:00:00" });
  });
});

describe("send — refused before anything reaches Xero", () => {
  it("is blocked, with the reasons, when the job isn't ready — and claims no number", async () => {
    const s = await addStage();
    ready = { state: "reconnect_required", organisationName: null, externalTenantId: "org-1" };
    const out = await send(s.id);
    expect(out.outcome).toBe("blocked");
    expect(out.blockers.map((b: { code: string }) => b.code)).toEqual(["xero_not_ready"]);
    expect(xero.calls).toEqual([]);
    expect(row(s.id)).toMatchObject({ state: "planned", seq: null, version: 1 });
  });

  it("a second send of the same stage loses at the claim — Xero is called once", async () => {
    const s = await addStage();
    const stale = { ...row(s.id) };
    await send(s.id);
    await expect(
      S.send({ tenant, invoice: stale, job, options: { expectedVersion: stale.version, invoiceDate: "2026-11-22" }, actor, deps: deps() })
    ).rejects.toMatchObject({ reason: "not_planned" });
    expect(xero.puts()).toHaveLength(1);
    expect(xero.invoices).toHaveLength(1);
  });

  it("a stale version (edited since the page loaded) is refused before Xero", async () => {
    const s = await addStage();
    await expect(
      S.send({ tenant, invoice: row(s.id), job, options: { expectedVersion: 99, invoiceDate: "2026-11-22" }, actor, deps: deps() })
    ).rejects.toMatchObject({ reason: "version" });
    expect(xero.calls).toEqual([]);
  });
});

describe("send — Xero says no (nothing exists there)", () => {
  it("a validation refusal: failed, with XERO'S OWN SENTENCE, and a rejected attempt", async () => {
    const s = await addStage();
    xero.failNext("validation", "Account code '999' is not a valid code for this document.");
    const out = await send(s.id);
    expect(out).toMatchObject({ outcome: "failed", category: "validation", detail: "Account code '999' is not a valid code for this document." });
    expect(row(s.id)).toMatchObject({ state: "failed", failureCategory: "validation", failureDetail: "Account code '999' is not a valid code for this document.", invoiceNumber: "IV3345-1", xeroInvoiceId: null });
    expect(attemptsOf(s.id)).toEqual(["rejected"]);
    expect(eventsOf(s.id)).toEqual(["created", "pending", "rejected"]);
    expect(xero.invoices).toEqual([]);
  });

  it("rate-limited: failed (nothing was created), and it can simply be tried again", async () => {
    const s = await addStage();
    xero.failNext("rate_limit");
    expect(await send(s.id)).toMatchObject({ outcome: "failed", category: "rate_limit", retryAfterSeconds: 60 });
    const again = await retry(s.id);
    expect(again).toMatchObject({ outcome: "sent", verified: true, invoiceNumber: "IV3345-1" });
    expect(xero.invoices).toHaveLength(1);
    expect(attemptsOf(s.id)).toEqual(["rejected", "accepted"]);
  });

  it("the number is already used in Xero by someone else's invoice: failed as number_taken", async () => {
    xero.seed({ InvoiceNumber: "IV3345-1" });
    const s = await addStage();
    const out = await send(s.id);
    expect(out).toMatchObject({ outcome: "failed", category: "number_taken" });
    expect(row(s.id)).toMatchObject({ state: "failed", failureCategory: "number_taken" });
    expect(xero.invoices).toHaveLength(1); // only the one that was already there
  });
});

describe("send — no answer from Xero (it may or may not exist)", () => {
  it("a timeout AFTER Xero stored it: the stage stays `sending`; the check ADOPTS it — no second create", async () => {
    const s = await addStage();
    xero.failNext("timeout_after");
    const out = await send(s.id);
    expect(out).toMatchObject({ outcome: "unknown", category: "timeout" });
    expect(row(s.id)).toMatchObject({ state: "sending", failureCategory: "timeout", xeroInvoiceId: null });
    expect(xero.invoices).toHaveLength(1); // it IS there — BuhlOS just doesn't know yet

    const checked = await retry(s.id);
    expect(checked).toMatchObject({ outcome: "adopted", verified: true, invoiceNumber: "IV3345-1" });
    expect(xero.invoices).toHaveLength(1);
    expect(xero.puts()).toHaveLength(1); // still exactly ONE create, ever
    expect(row(s.id)).toMatchObject({ state: "sent", xeroInvoiceId: xero.invoices[0]!.InvoiceID, xeroSubtotalCents: 50_000_00, failureCategory: null });
    expect(attemptsOf(s.id)).toEqual(["error", "adopted"]);
    expect(eventsOf(s.id)).toEqual(["created", "pending", "retry_required", "adopted", "verified_against_xero"]);
  });

  it("a 500 after Xero stored it is the same: unknown, then adopted", async () => {
    const s = await addStage();
    xero.failNext("server_after");
    expect((await send(s.id)).outcome).toBe("unknown");
    expect((await retry(s.id)).outcome).toBe("adopted");
    expect(xero.invoices).toHaveLength(1);
  });

  it("a timeout BEFORE it reached Xero: the check finds nothing and sends — with the SAME idempotency key", async () => {
    const s = await addStage();
    xero.failNext("timeout_before");
    expect((await send(s.id)).outcome).toBe("unknown");
    expect(xero.invoices).toEqual([]);

    const checked = await retry(s.id);
    expect(checked).toMatchObject({ outcome: "sent", verified: true, invoiceNumber: "IV3345-1" });
    expect(xero.invoices).toHaveLength(1);
    const [first, second] = xero.puts();
    expect(second!.headers["Idempotency-Key"]).toBe(first!.headers["Idempotency-Key"]);
    expect(second!.body).toEqual(first!.body);
    // …and it looked the number up BEFORE sending again
    const order = xero.calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);
    expect(order[1]).toBe("GET /api.xro/2.0/Invoices?InvoiceNumbers=IV3345-1");
    expect(order[2]).toBe("PUT /api.xro/2.0/Invoices");
  });

  it("pressing Check again and again never creates a second invoice", async () => {
    const s = await addStage();
    xero.failNext("timeout_after");
    await send(s.id);
    await retry(s.id);
    // the row is now `sent`; further checks are refused outright
    for (let i = 0; i < 3; i++) {
      const again = await retry(s.id);
      expect(again).toMatchObject({ outcome: "blocked" });
      expect(again.blockers[0].code).toBe("not_awaiting_xero");
    }
    expect(xero.invoices).toHaveLength(1);
    expect(xero.puts()).toHaveLength(1);
  });

  it("a 200 with no invoice in it is treated as unknown, never as success", async () => {
    const s = await addStage();
    xero.failNext("no_id");
    const out = await send(s.id);
    expect(out).toMatchObject({ outcome: "unknown", category: "unexpected" });
    expect(row(s.id).state).toBe("sending");
    expect((await retry(s.id)).outcome).toBe("adopted");
    expect(xero.invoices).toHaveLength(1);
  });

  it("if the look-up itself fails, nothing changes and nothing is sent", async () => {
    const s = await addStage();
    xero.failNext("timeout_before");
    await send(s.id);
    const before = { ...row(s.id) };
    const down = { ...deps(), xeroFetch: async () => { throw new (requireFromHere("../../../api/_lib/xero/errors.js").XeroError)("server", { status: 503 }); } };
    await expect(S.retry({ tenant, invoice: row(s.id), job, actor, deps: down })).rejects.toMatchObject({ category: "server" });
    expect(row(s.id)).toEqual(before);
    expect(xero.puts()).toHaveLength(1);
  });
});

describe("read-back", () => {
  it("when Xero holds something different from what was sent, the invoice is recorded WITH the difference named", async () => {
    const s = await addStage();
    const real = xero.xeroFetch;
    const tampering = async (url: string, opts: { method?: string } = {}) => {
      const res = await real(url, opts);
      if (!opts.method && /\/Invoices\/[a-f0-9-]+$/.test(url)) res.data.Invoices[0]!.SubTotal = 49999;
      return res;
    };
    const out = await S.send({ tenant, invoice: row(s.id), job, options: { expectedVersion: 1, invoiceDate: "2026-11-22" }, actor, deps: { ...deps(), xeroFetch: tampering } });
    expect(out).toMatchObject({ outcome: "sent", verified: false, mismatches: ["subtotal"] });
    // Xero's figure is what is stored (ADR rule 6), and the drift is on the row
    expect(row(s.id)).toMatchObject({ state: "sent", xeroSubtotalCents: 49_999_00 });
    expect((row(s.id).drift as { mismatches: string[] }).mismatches).toEqual(["subtotal"]);
    expect(eventsOf(s.id)).toContain("drifted");
    expect(eventsOf(s.id)).not.toContain("verified_against_xero");
  });

  it("when the read-back fails, the invoice still counts as sent (it exists) and the gap is named", async () => {
    const s = await addStage();
    const real = xero.xeroFetch;
    const { XeroError } = requireFromHere("../../../api/_lib/xero/errors.js");
    const flaky = async (url: string, opts: { method?: string } = {}) => {
      if (!opts.method) throw new XeroError("timeout", { detail: "api_request" });
      return real(url, opts);
    };
    const out = await S.send({ tenant, invoice: row(s.id), job, options: { expectedVersion: 1, invoiceDate: "2026-11-22" }, actor, deps: { ...deps(), xeroFetch: flaky } });
    expect(out).toMatchObject({ outcome: "sent", verified: false, mismatches: ["readback_failed:timeout"] });
    expect(row(s.id)).toMatchObject({ state: "sent", xeroInvoiceId: xero.invoices[0]!.InvoiceID, xeroSubtotalCents: 50_000_00 });
  });
});

describe("retry — look the number up first", () => {
  it("after a refusal, sends again from the FROZEN snapshot — a changed contract doesn't change the invoice", async () => {
    const s = await addStage(); // 20% of 250,000
    xero.failNext("validation", "Account code '999' is not a valid code for this document.");
    await send(s.id);
    const changedJob = { ...job, contractValue: 999999 };
    const out = await S.retry({ tenant, invoice: row(s.id), job: changedJob, actor, deps: deps() });
    expect(out).toMatchObject({ outcome: "sent", verified: true });
    expect(xero.invoices[0]!.SubTotal).toBe(50000);
    expect(row(s.id).netCents).toBe(50_000_00);
  });

  it("…but picks up a CORRECTED account or tax default (that is usually what Xero refused)", async () => {
    const s = await addStage();
    xero.failNext("validation", "Account code '200' is not a valid code for this document.");
    await send(s.id);
    await mem.saveSettings({}, "t1", "org-1", { ...SETTINGS, salesAccountCode: "260", salesAccountName: "Other Revenue" }, { expectedVersion: 1 });
    await retry(s.id);
    expect(xero.invoices[0]!.LineItems[0]!.AccountCode).toBe("260");
    // a different body is a different request: a different idempotency key
    const [first, second] = xero.puts();
    expect(second!.headers["Idempotency-Key"]).not.toBe(first!.headers["Idempotency-Key"]);
  });

  it("finds someone else's invoice under the number: number_taken, and nothing is sent", async () => {
    const s = await addStage();
    xero.failNext("timeout_before");
    await send(s.id);
    xero.seed({ InvoiceNumber: "IV3345-1" }); // the office made one by hand meanwhile
    const out = await retry(s.id);
    expect(out).toMatchObject({ outcome: "failed", category: "number_taken", detail: "Xero already has a different invoice with this number" });
    expect(row(s.id)).toMatchObject({ state: "failed", failureCategory: "number_taken" });
    expect(xero.puts()).toHaveLength(1);
    expect(attemptsOf(s.id)).toEqual(["error", "blocked"]);
  });

  it("finds OUR invoice but deleted in Xero: the number is burned, not silently re-used", async () => {
    const s = await addStage();
    xero.failNext("timeout_after");
    await send(s.id);
    xero.invoices[0]!.Status = "DELETED";
    const out = await retry(s.id);
    expect(out).toMatchObject({ outcome: "failed", category: "number_taken", detail: "Xero has a deleted invoice with this number" });
    expect(xero.puts()).toHaveLength(1);
  });

  it("adopts an invoice the office has already APPROVED in Xero (not a mismatch)", async () => {
    const s = await addStage();
    xero.failNext("timeout_after");
    await send(s.id);
    xero.invoices[0]!.Status = "AUTHORISED";
    const out = await retry(s.id);
    expect(out).toMatchObject({ outcome: "adopted", verified: true });
    expect(row(s.id)).toMatchObject({ state: "sent", xeroStatus: "AUTHORISED" });
  });

  it("can't be resolved against a different Xero organisation, or while Xero isn't usable", async () => {
    const s = await addStage();
    xero.failNext("timeout_before");
    await send(s.id);
    ready = { state: "connected", organisationName: "Other Org", externalTenantId: "org-2" };
    await mem.saveSettings({}, "t1", "org-2", SETTINGS, { expectedVersion: null });
    expect((await retry(s.id)).blockers).toEqual([{ code: "other_organisation" }]);
    ready = { state: "reconnect_required", organisationName: null, externalTenantId: "org-1" };
    expect((await retry(s.id)).blockers[0].code).toBe("xero_not_ready");
    expect(xero.puts()).toHaveLength(1);
    expect(row(s.id).state).toBe("sending");
  });

  it("is refused for a planned stage (nothing to resolve)", async () => {
    const s = await addStage();
    expect((await retry(s.id)).blockers).toEqual([{ code: "not_awaiting_xero" }]);
    expect(xero.calls).toEqual([]);
  });
});

describe("reset — back to planned only when Xero confirms it holds nothing", () => {
  it("after a refusal: looks the number up, finds nothing, releases the number and unfreezes the stage", async () => {
    const s = await addStage();
    xero.failNext("validation");
    await send(s.id);
    const out = await reset(s.id);
    expect(out.outcome).toBe("reset");
    expect(row(s.id)).toMatchObject({ state: "planned", seq: null, invoiceNumber: null, grossCents: null, netCents: null, failureCategory: null });
    expect(xero.gets().map((c) => new URL(c.url).search)).toEqual(["?InvoiceNumbers=IV3345-1"]);
    // sent again later, it takes the same number — nothing was ever created under it
    const again = await send(s.id);
    expect(again).toMatchObject({ outcome: "sent", invoiceNumber: "IV3345-1" });
    expect(xero.invoices).toHaveLength(1);
  });

  it("if Xero has the invoice after all, it is adopted instead of reset", async () => {
    const s = await addStage();
    xero.failNext("timeout_after");
    await send(s.id);
    const out = await reset(s.id);
    expect(out.outcome).toBe("adopted");
    expect(row(s.id).state).toBe("sent");
  });

  it("won't release a number that is taken in Xero", async () => {
    const s = await addStage();
    xero.failNext("timeout_before");
    await send(s.id);
    xero.seed({ InvoiceNumber: "IV3345-1" });
    const out = await reset(s.id);
    expect(out).toMatchObject({ outcome: "failed", category: "number_taken" });
    expect(row(s.id)).toMatchObject({ state: "failed", invoiceNumber: "IV3345-1" });
  });
});

describe("the number is never reused once it is burned", () => {
  it("raise again cancels the stage KEEPING its number; the copy takes the next one", async () => {
    xero.seed({ InvoiceNumber: "IV3345-1" });
    const s = await addStage({ title: "Deposit" });
    await send(s.id);
    const fresh = await mem.raiseAgain({}, "t1", s.id);
    expect(row(s.id)).toMatchObject({ state: "cancelled", invoiceNumber: "IV3345-1", seq: 1 });
    expect(fresh).toMatchObject({ state: "planned", title: "Deposit", seq: null });
    const out = await send(fresh.id);
    expect(out).toMatchObject({ outcome: "sent", invoiceNumber: "IV3345-2", verified: true });
  });
});

// ── part 2: itemised invoices (#1161) and payment-claim wording (#1164) ─────

const ITEMS = [
  { id: "n1", type: "note", description: "Rewired the shop front." },
  { id: "a", type: "line", description: "Call-out fee", quantityMilli: 1000, unit: "ea", unitCents: 9500, source: "manual", costCents: null, refs: [] },
  { id: "b", type: "line", description: "Labour", quantityMilli: 14350, unit: "hr", unitCents: 9500, source: "labour", costCents: 68880, refs: [{ t: "h", u: "u_field", d: "2026-11-10", m: 14350 }] },
  { id: "c", type: "line", description: "Half-cent line", quantityMilli: 2500, unit: "ea", unitCents: 3333, source: "manual", costCents: null, refs: [] },
  { id: "d", type: "line", description: "Discount", quantityMilli: 1000, unit: null, unitCents: -5000, source: "manual", costCents: null, refs: [] },
];
const addItemised = (over: Record<string, unknown> = {}) =>
  mem.createStage({}, "t1", "tower", {
    kind: "itemised", title: "Shop front rewire", basis: "amount", amountCents: 149158, percentBp: null, extraLines: [], items: ITEMS, retentionBp: null, plannedDate: null, note: null, ...over,
  });
const putBodies = () => xero.calls.filter((c) => c.method === "PUT").map((c) => c.body as { Invoices: Array<{ LineItems: Array<Record<string, unknown>> }> });

describe("sending an itemised invoice", () => {
  it("creates ONE draft with each charge's quantity and unit price, and matches on the read-back", async () => {
    const s = await addItemised();
    const out = await send(s.id);
    expect(out).toMatchObject({ outcome: "sent", invoiceNumber: "IV3345-1", verified: true, mismatches: [] });
    expect(xero.invoices).toHaveLength(1);
    const lines = xero.invoices[0]!.LineItems;
    expect(lines.map((l) => [l.Quantity, l.UnitAmount, l.LineAmount])).toEqual([
      [undefined, undefined, undefined], // the heading: wording only
      [undefined, undefined, undefined], // the note
      [1, 95, 95],
      [14.35, 95, 1363.25],
      [2.5, 33.33, 83.33], // 83.325 → the half cent goes up, on both sides
      [1, -50, -50],
    ]);
    expect(lines[0]!.Description).toBe("Shop front rewire\nTower Fit-out, 12 Smith St");
    // Xero's own figures are what is stored
    expect(row(s.id)).toMatchObject({ state: "sent", xeroSubtotalCents: 149158, xeroTaxCents: 14916, xeroTotalCents: 164074, drift: null });
  });

  it("sends nothing that is the office's own: no cost, no source, no refs", async () => {
    const s = await addItemised();
    await send(s.id);
    const sent = JSON.stringify(putBodies()[0]);
    for (const secret of ["costCents", "68880", "u_field", "refs", "source"]) expect(sent).not.toContain(secret);
  });

  it("shows in the preview exactly what will be sent, with the GST Xero will work out", async () => {
    const s = await addItemised();
    const p = await S.preview({ tenant, invoice: row(s.id), job, options: { invoiceDate: "2026-11-22" }, deps: deps() });
    expect(p.blockers).toEqual([]);
    expect(p.invoice.lines.map((l: { note?: boolean; quantityMilli?: number; unitCents?: number; amountCents: number }) => [l.note ?? false, l.quantityMilli, l.unitCents, l.amountCents])).toEqual([
      [true, undefined, undefined, 0],
      [true, undefined, undefined, 0],
      [false, 1000, 9500, 9500],
      [false, 14350, 9500, 136325],
      [false, 2500, 3333, 8333],
      [false, 1000, -5000, -5000],
    ]);
    // 9.50 + 136.33 + 8.33 − 5.00 — per line, as Xero does it
    expect(p.invoice).toMatchObject({ netCents: 149158, estimatedTaxCents: 14916, estimatedTotalCents: 164074 });
    await send(s.id);
    expect(row(s.id).xeroTaxCents).toBe(p.invoice.estimatedTaxCents);
  });

  it("can't be sent with no charge on it", async () => {
    const s = await addItemised({ items: [ITEMS[0]] });
    const out = await send(s.id);
    expect(out.outcome).toBe("blocked");
    expect(out.blockers.map((b: { code: string }) => b.code)).toEqual(["no_lines"]);
    expect(xero.calls).toEqual([]);
  });

  it("after a lost answer, the look-up adopts it — never a second invoice", async () => {
    const s = await addItemised();
    xero.failNext("timeout_after");
    expect((await send(s.id)).outcome).toBe("unknown");
    const out = await retry(s.id);
    expect(out).toMatchObject({ outcome: "adopted", verified: true });
    expect(xero.invoices).toHaveLength(1);
  });

  it("a retry after a refusal sends the very same lines", async () => {
    const s = await addItemised();
    xero.failNext("validation", "Account code '200' is not a valid code");
    expect((await send(s.id)).outcome).toBe("failed");
    expect((await retry(s.id)).outcome).toBe("sent");
    const [first, second] = putBodies();
    expect(second).toEqual(first);
  });
});

describe("payment-claim wording on a sent invoice", () => {
  const claimOn = async () => {
    const p = await mem.getProfile({}, "t1", "tower");
    await mem.saveProfile({}, "t1", "tower", { paymentClaim: true }, { expectedVersion: p!.version as number });
  };
  const STATEMENT = "This is a payment claim made under the Building and Construction Industry Security of Payment Act 2009 (SA).";

  it("is not on an invoice unless the job has it switched on", async () => {
    const s = await addStage();
    await send(s.id);
    expect(JSON.stringify(putBodies()[0])).not.toContain("payment claim");
    expect(row(s.id).sentFooter).toBeNull();
  });

  it("goes last, as wording only, with where the claim stands — and is frozen on the row", async () => {
    await claimOn();
    const first = await addStage({ title: "Deposit", percentBp: 2000 });
    await send(first.id);
    const second = await addStage({ title: "Rough-in", percentBp: 3000 });
    await send(second.id);
    const [a, b] = xero.invoices;
    const lastA = a!.LineItems[a!.LineItems.length - 1]!;
    expect(lastA).toEqual({ Description: `${STATEMENT}\nContract sum: $250,000.00. Claimed to date including this claim: $50,000.00. Remaining: $200,000.00. All ex GST, before retention.` });
    // the second claim counts the first
    expect(b!.LineItems[b!.LineItems.length - 1]!.Description).toContain("Claimed to date including this claim: $125,000.00. Remaining: $125,000.00.");
    expect(row(first.id).sentFooter).toBe(lastA.Description);
    // wording adds nothing to the amount
    expect(a).toMatchObject({ SubTotal: 50000, TotalTax: 5000 });
    expect(row(first.id)).toMatchObject({ state: "sent", drift: null });
  });

  it("counts approved variations in the contract sum", async () => {
    await claimOn();
    const v = await mem.createVariation({}, "t1", "tower", { title: "Extra GPOs", quotedCents: 110000 });
    await mem.decideVariation({}, "t1", v.id, { status: "approved", approvedCents: 110000, approvalRef: null, decidedOn: "2026-11-20" }, { expectedVersion: 1 });
    const s = await addStage();
    await send(s.id);
    expect(String(row(s.id).sentFooter)).toContain("Contract sum including approved variations: $251,100.00.");
  });

  it("a retry sends the wording that was frozen, even if the job has moved on since", async () => {
    await claimOn();
    const s = await addStage();
    xero.failNext("validation", "nope");
    await send(s.id);
    const frozen = row(s.id).sentFooter;
    // meanwhile: the switch is turned off
    const p = await mem.getProfile({}, "t1", "tower");
    await mem.saveProfile({}, "t1", "tower", { paymentClaim: false }, { expectedVersion: p!.version as number });
    expect((await retry(s.id)).outcome).toBe("sent");
    const [first, second] = putBodies();
    expect(second).toEqual(first);
    expect(row(s.id).sentFooter).toBe(frozen);
  });

  it("goes on an itemised invoice too, and shows in the preview before anything is sent", async () => {
    await claimOn();
    const s = await addItemised();
    const p = await S.preview({ tenant, invoice: row(s.id), job, options: { invoiceDate: "2026-11-22" }, deps: deps() });
    const last = p.invoice.lines[p.invoice.lines.length - 1];
    expect(last).toMatchObject({ note: true, amountCents: 0 });
    expect(last.description).toContain(STATEMENT);
    expect(xero.calls).toEqual([]);
  });
});
