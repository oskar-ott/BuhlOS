import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { taxonomyFor } from "@/domains/xero/sync-log";

/**
 * api/_lib/customer-invoices/xero-lookups.js (#1149) — the READS from Xero
 * that set an invoice up. Pins: readiness is decided from the stored
 * connection alone; every mapper is an allow-list (data minimisation, ADR
 * rule 9); the account and tax lists only ever offer what an invoice line can
 * actually use.
 */
const requireFromHere = createRequire(import.meta.url);
const L = requireFromHere("../../../api/_lib/customer-invoices/xero-lookups.js");
const { XeroError } = requireFromHere("../../../api/_lib/xero/errors.js");

const ENV = {
  XERO_CLIENT_ID: "client-id-1",
  XERO_CLIENT_SECRET: "client-secret-1",
  XERO_TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_BASE_URL: "https://buhlos.com",
  SUPABASE_DB_URL: "postgres://user:pass@host:6543/db",
};
const BASE_SCOPES = "openid profile email offline_access payroll.employees.read payroll.settings.read accounting.settings.read";
const INVOICE_SCOPES = `${BASE_SCOPES} accounting.invoices accounting.contacts.read`;

const row = (over: Record<string, unknown> = {}) => ({
  status: "connected", external_tenant_id: "org-1", external_tenant_name: "Buhl Electrical", granted_scopes: INVOICE_SCOPES, ...over,
});
const storeOf = (r: unknown) => ({ getConnection: vi.fn(async () => r) });
const ready = (r: unknown, env: Record<string, string> = ENV) => L.readiness({ env, store: storeOf(r) });

/** A fake xeroFetch that answers by URL and records what was asked. */
function fetcher(answers: Record<string, unknown>) {
  const fn = vi.fn(async (url: string) => {
    for (const [needle, data] of Object.entries(answers)) {
      if (url.includes(needle)) {
        if (data instanceof Error) throw data;
        return { data, correlationId: null };
      }
    }
    throw new Error(`unexpected Xero URL ${url}`);
  });
  return fn;
}

describe("readiness — decided from the stored connection, never by calling Xero", () => {
  it("names each state a person can act on", async () => {
    expect(await ready(row())).toEqual({ state: "connected", organisationName: "Buhl Electrical", externalTenantId: "org-1" });
    expect((await ready(null)).state).toBe("disconnected");
    expect((await ready(row({ status: "pending_selection", external_tenant_id: null }))).state).toBe("connecting");
    expect((await ready(row({ status: "reconnect_required" }))).state).toBe("reconnect_required");
    expect((await ready(row({ granted_scopes: BASE_SCOPES }))).state).toBe("missing_permission");
  });

  it("needs BOTH invoice scopes — a payroll-only or half-granted connection is missing_permission", async () => {
    expect((await ready(row({ granted_scopes: `${BASE_SCOPES} payroll.timesheets` }))).state).toBe("missing_permission");
    expect((await ready(row({ granted_scopes: `${BASE_SCOPES} accounting.invoices` }))).state).toBe("missing_permission");
    expect((await ready(row({ granted_scopes: `${BASE_SCOPES} accounting.contacts.read` }))).state).toBe("missing_permission");
    // the deprecated umbrella scope is NOT accepted as a stand-in
    expect((await ready(row({ granted_scopes: `${BASE_SCOPES} accounting.transactions accounting.contacts` }))).state).toBe("missing_permission");
  });

  it("a degraded connection still counts as connected (the next call refreshes it)", async () => {
    expect((await ready(row({ status: "degraded" }))).state).toBe("connected");
    expect((await ready(row({ status: "refresh_failed" }))).state).toBe("connected");
  });

  it("says not_configured without touching the store when Xero isn't set up here", async () => {
    const store = storeOf(row());
    const { XERO_CLIENT_SECRET: _omit, ...partial } = ENV;
    void _omit;
    expect((await L.readiness({ env: partial, store })).state).toBe("not_configured");
    expect(store.getConnection).not.toHaveBeenCalled();
  });

  it("assertReady passes only when connected and throws the typed reason otherwise", () => {
    expect(() => L.assertReady({ state: "connected" })).not.toThrow();
    const cat = (state: string) => {
      try { L.assertReady({ state }); return null; } catch (e) { return e as { category: string; reason?: string }; }
    };
    expect(cat("missing_permission")).toMatchObject({ category: "reconnect_required", reason: "missing_invoice_scope" });
    expect(cat("reconnect_required")).toMatchObject({ category: "reconnect_required" });
    expect(cat("reconnect_required")!.reason).toBeUndefined();
    expect(cat("connecting")).toMatchObject({ category: "pending_selection" });
    expect(cat("disconnected")).toMatchObject({ category: "not_connected" });
    expect(cat("not_configured")).toMatchObject({ category: "not_configured" });
    expect(cat("unavailable")).toMatchObject({ category: "not_connected" });
  });
});

describe("searchContacts", () => {
  const xeroContact = (over: Record<string, unknown> = {}) => ({
    ContactID: "11111111-1111-4111-8111-111111111111", Name: "Built Pty Ltd", ContactStatus: "ACTIVE",
    // everything below must never leave the module
    EmailAddress: "accounts@built.example", TaxNumber: "12 345 678 901", BankAccountDetails: "062-000 12345678",
    Addresses: [{ AddressType: "POBOX", AddressLine1: "1 Example St" }], Phones: [{ PhoneNumber: "5550100" }],
    ContactPersons: [{ FirstName: "Pat", EmailAddress: "pat@built.example" }], Balances: { AccountsReceivable: { Outstanding: 1000 } },
    ...over,
  });

  it("returns only id and name — nothing else Xero sent is kept", async () => {
    const xeroFetch = fetcher({ "/Contacts?": { Contacts: [xeroContact()] } });
    const out = await L.searchContacts("built", { xeroFetch });
    expect(out).toEqual([{ id: "11111111-1111-4111-8111-111111111111", name: "Built Pty Ltd" }]);
    const text = JSON.stringify(out);
    for (const secret of ["accounts@", "12 345", "062-000", "Example St", "5550100", "Pat", "1000"]) expect(text).not.toContain(secret);
  });

  it("asks Xero for a small, URL-encoded search and nothing wider", async () => {
    const xeroFetch = fetcher({ "/Contacts?": { Contacts: [] } });
    await L.searchContacts("  Smith & Sons  ", { xeroFetch });
    const url = String(xeroFetch.mock.calls[0]![0]);
    expect(url).toBe("https://api.xero.com/api.xro/2.0/Contacts?searchTerm=Smith%20%26%20Sons&page=1&pageSize=20");
  });

  it("drops archived contacts and anything without an id or a name", async () => {
    const xeroFetch = fetcher({ "/Contacts?": { Contacts: [
      xeroContact(),
      xeroContact({ ContactID: "22222222-2222-4222-8222-222222222222", Name: "Old Client", ContactStatus: "ARCHIVED" }),
      xeroContact({ ContactID: "", Name: "No id" }),
      xeroContact({ ContactID: "33333333-3333-4333-8333-333333333333", Name: "   " }),
      null,
    ] } });
    expect(await L.searchContacts("cl", { xeroFetch })).toEqual([{ id: "11111111-1111-4111-8111-111111111111", name: "Built Pty Ltd" }]);
  });

  it("doesn't call Xero for an empty or one-letter search, and survives an odd response", async () => {
    const xeroFetch = fetcher({ "/Contacts?": {} });
    expect(await L.searchContacts("", { xeroFetch })).toEqual([]);
    expect(await L.searchContacts(" b ", { xeroFetch })).toEqual([]);
    expect(xeroFetch).not.toHaveBeenCalled();
    expect(await L.searchContacts("built", { xeroFetch })).toEqual([]);
  });

  it("lets a Xero failure through as the typed error (the handler words it)", async () => {
    const xeroFetch = fetcher({ "/Contacts?": new XeroError("rate_limit", { status: 429, retryAfterSeconds: 60 }) });
    await expect(L.searchContacts("built", { xeroFetch })).rejects.toMatchObject({ category: "rate_limit" });
  });
});

describe("getContact", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  it("reads one contact by id, minimised", async () => {
    const xeroFetch = fetcher({ [`/Contacts/${id}`]: { Contacts: [{ ContactID: id, Name: "Built Pty Ltd", ContactStatus: "ACTIVE", EmailAddress: "x@y.example" }] } });
    expect(await L.getContact(id, { xeroFetch })).toEqual({ id, name: "Built Pty Ltd", status: "ACTIVE" });
  });

  it("is null when Xero has no such contact, and never asks Xero about a non-id", async () => {
    const xeroFetch = fetcher({ "/Contacts/": new XeroError("not_found", { status: 404 }) });
    expect(await L.getContact(id, { xeroFetch })).toBeNull();
    xeroFetch.mockClear();
    expect(await L.getContact("../Invoices", { xeroFetch })).toBeNull();
    expect(await L.getContact("", { xeroFetch })).toBeNull();
    expect(xeroFetch).not.toHaveBeenCalled();
  });

  it("does not swallow other failures", async () => {
    const xeroFetch = fetcher({ "/Contacts/": new XeroError("server", { status: 503 }) });
    await expect(L.getContact(id, { xeroFetch })).rejects.toMatchObject({ category: "server" });
  });
});

describe("salesAccounts", () => {
  it("offers only active revenue accounts that have a code, sorted by code", async () => {
    const xeroFetch = fetcher({ "/Accounts": { Accounts: [
      { Code: "260", Name: "Other Revenue", Class: "REVENUE", Status: "ACTIVE", TaxType: "OUTPUT" },
      { Code: "200", Name: "Sales", Class: "REVENUE", Status: "ACTIVE", TaxType: "OUTPUT", BankAccountNumber: "should-not-leak" },
      { Code: "400", Name: "Advertising", Class: "EXPENSE", Status: "ACTIVE" },
      { Code: "210", Name: "Old Sales", Class: "REVENUE", Status: "ARCHIVED" },
      { Code: "", Name: "No code", Class: "REVENUE", Status: "ACTIVE" },
      { Name: "Also no code", Class: "REVENUE", Status: "ACTIVE" },
      { Code: "90", Name: "Short code", Class: "REVENUE", Status: "ACTIVE" },
    ] } });
    const out = await L.salesAccounts({ xeroFetch });
    expect(out).toEqual([
      { code: "90", name: "Short code", taxType: null },
      { code: "200", name: "Sales", taxType: "OUTPUT" },
      { code: "260", name: "Other Revenue", taxType: "OUTPUT" },
    ]);
    expect(JSON.stringify(out)).not.toContain("should-not-leak");
  });

  it("is an empty list, not a crash, when Xero answers oddly", async () => {
    expect(await L.salesAccounts({ xeroFetch: fetcher({ "/Accounts": {} }) })).toEqual([]);
    expect(await L.salesAccounts({ xeroFetch: fetcher({ "/Accounts": { Accounts: "nope" } }) })).toEqual([]);
  });
});

describe("taxRates", () => {
  it("offers active rates usable on sales, with Xero's rate as basis points", async () => {
    const xeroFetch = fetcher({ "/TaxRates": { TaxRates: [
      { Name: "GST on Income", TaxType: "OUTPUT", Status: "ACTIVE", CanApplyToRevenue: true, EffectiveRate: "10.0000" },
      { Name: "GST Free Income", TaxType: "EXEMPTOUTPUT", Status: "ACTIVE", CanApplyToRevenue: true, EffectiveRate: "0.0000" },
      { Name: "GST on Expenses", TaxType: "INPUT", Status: "ACTIVE", CanApplyToRevenue: false, EffectiveRate: "10.0000" },
      { Name: "Old rate", TaxType: "OLD", Status: "DELETED", CanApplyToRevenue: true, EffectiveRate: "12.5000" },
      { Name: "Broken rate", TaxType: "BROKEN", Status: "ACTIVE", CanApplyToRevenue: true, EffectiveRate: "abc" },
      { Name: "No type", Status: "ACTIVE", CanApplyToRevenue: true, EffectiveRate: "10" },
    ] } });
    expect(await L.taxRates({ xeroFetch })).toEqual([
      { taxType: "EXEMPTOUTPUT", name: "GST Free Income", rateBp: 0 },
      { taxType: "OUTPUT", name: "GST on Income", rateBp: 1000 },
    ]);
  });

  it("converts a percentage to basis points and refuses nonsense", () => {
    expect(L.rateToBp("10.0000")).toBe(1000);
    expect(L.rateToBp(12.5)).toBe(1250);
    expect(L.rateToBp("0")).toBe(0);
    expect(L.rateToBp("abc")).toBeNull();
    expect(L.rateToBp(-1)).toBeNull();
    expect(L.rateToBp(101)).toBeNull();
    expect(L.rateToBp(undefined)).toBeNull();
  });
});

describe("sync-log operator text finds the categories the client actually throws (#1149)", () => {
  it("maps each raw client category to its explanation and next step", () => {
    const expected: Record<string, string> = {
      auth: "Xero connection has expired",
      reconnect_required: "Xero connection has expired",
      forbidden: "Xero refused this action",
      timeout: "Couldn't reach Xero",
      network: "Couldn't reach Xero",
      server: "Couldn't reach Xero",
      validation: "Xero rejected the record",
      persistence: "saving the result here failed",
      unexpected: "unexpected answer",
      rate_limit: "rate-limiting",
    };
    for (const [category, phrase] of Object.entries(expected)) {
      const meta = taxonomyFor(category);
      expect(meta, category).not.toBeNull();
      expect(meta!.operatorMessage).toContain(phrase);
      expect(meta!.requiredAction.length).toBeGreaterThan(5);
    }
  });

  it("still answers its own keys, and stays silent where there is no honest match", () => {
    expect(taxonomyFor("xero_validation")!.operatorMessage).toContain("Xero rejected the record");
    expect(taxonomyFor("reconciliation_drift")).not.toBeNull();
    for (const c of ["not_found", "conflict", "not_connected", "pending_selection", "not_configured", "nonsense", "constructor", "toString"]) {
      expect(taxonomyFor(c), c).toBeNull();
    }
  });
});
