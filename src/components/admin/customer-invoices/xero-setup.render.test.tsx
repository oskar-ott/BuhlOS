import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { JobGettingPaidBody } from "./JobGettingPaidCard";
import { ContactResults, XeroContactPicker } from "./XeroClientLine";
import {
  InvoiceSettingsView,
  XeroInvoiceSettingsPanel,
} from "@/components/admin/XeroInvoiceSettingsPanel";
import type {
  InvoiceSettingsOptions,
  InvoiceSettingsResponse,
  JobInvoicingResponse,
  JobXeroStanding,
  XeroReadinessState,
} from "@/domains/customer-invoices/schema";
import { XERO_READINESS_STATES } from "@/domains/customer-invoices/schema";

/**
 * The Xero set-up screens for customer stage invoices (#1149): the "Client in
 * Xero" line on the job's Getting paid card, the contact picker, and the
 * Invoices panel on the Xero settings page. Every state a person can land in
 * is pinned — above all that a Xero that can't be used says WHICH reason and
 * what fixes it, and that the schedule is never hidden behind it.
 */
const noop = () => {};
const render = (el: ReactElement) => renderToString(el).replace(/<!-- -->/g, "");

function standing(over: Partial<JobXeroStanding> = {}): JobXeroStanding {
  return {
    state: "connected",
    organisationName: "Buhl Electrical",
    settingsComplete: true,
    client: { linked: false, name: null, otherOrganisation: false, suggestion: null },
    ...over,
  };
}

function data(xero: JobXeroStanding): JobInvoicingResponse {
  return {
    jobId: "tower",
    job: { name: "Tower Fit-out", code: "IV3345", clientName: "Built Pty Ltd", contractCents: 250_000_00 },
    profile: { jobId: "tower", retentionBp: 0, xeroContactId: null, xeroContactName: null, externalTenantId: null, version: null },
    stages: [],
    totals: {
      contractCents: 250_000_00, plannedCount: 0, plannedGrossCents: 0, plannedNetCents: 0, unresolvedCount: 0,
      sentCount: 0, claimedCents: 0, stillToInvoiceCents: 250_000_00, overContract: false, retentionHeldCents: 0,
    },
    xero,
    asOf: "2026-11-22T00:00:00.000Z",
  };
}

const card = (xero: JobXeroStanding) =>
  render(createElement(JobGettingPaidBody, { data: data(xero), onData: noop, onStale: noop }));

describe("Getting paid — the Client in Xero line", () => {
  it("not linked: says so, names the job's client, and offers Link client", () => {
    const html = card(standing());
    expect(html).toContain("Client in Xero: not linked (this job&#x27;s client is Built Pty Ltd).");
    expect(html).toContain("Link client");
    expect(html).not.toContain("gp-xero-blocked");
    expect(html).not.toContain("gp-settings-incomplete");
  });

  it("linked: shows Xero's name for the contact and the organisation, with Change and Remove link", () => {
    const html = card(standing({ client: { linked: true, name: "Built Pty Ltd", otherOrganisation: false, suggestion: null } }));
    expect(html).toContain("Client in Xero: <span class=\"font-medium text-text\">Built Pty Ltd</span> (Buhl Electrical).");
    expect(html).toContain("Change");
    expect(html).toContain("Remove link");
    expect(html).not.toContain("Link client");
  });

  it("offers the contact another job for the same client uses — as a choice, not a done deal", () => {
    const html = card(standing({
      client: { linked: false, name: null, otherOrganisation: false, suggestion: { id: "c1", name: "Built Pty Ltd" } },
    }));
    expect(html).toContain("gp-client-suggestion");
    expect(html).toContain("Another job for this client uses");
    expect(html).toContain("Use this contact");
    expect(html).toContain("Client in Xero: not linked");
  });

  it("warns when the link was made in a different Xero organisation", () => {
    const html = card(standing({ client: { linked: true, name: "Built Pty Ltd", otherOrganisation: true, suggestion: null } }));
    expect(html).toContain("gp-client-other-org");
    expect(html).toContain("a different Xero organisation was connected");
    expect(html).toContain("in Buhl Electrical");
  });

  it("says when the invoice defaults aren't chosen, with the way to choose them", () => {
    const html = card(standing({ settingsComplete: false }));
    expect(html).toContain("gp-settings-incomplete");
    expect(html).toContain("aren’t chosen yet");
    expect(html).toContain('href="/settings/integrations/xero"');
  });

  const blocked: Array<[XeroReadinessState, string, string]> = [
    ["missing_permission", "Xero is connected, but without permission for invoices.", "Reconnect Xero to allow invoices"],
    ["reconnect_required", "The Xero connection has expired.", "Reconnect Xero"],
    ["connecting", "no organisation has been chosen yet", "Finish connecting Xero"],
    ["disconnected", "Xero isn’t connected.", "Connect Xero"],
    ["not_configured", "Xero isn’t set up for this site yet.", "Open Xero settings"],
    ["unavailable", "Couldn’t check the Xero connection just now.", "Open Xero settings"],
  ];
  for (const [state, message, action] of blocked) {
    it(`${state}: names the reason and the fix, offers no picker, and leaves the schedule usable`, () => {
      const html = card(standing({ state, settingsComplete: false })).replace(/&#x27;/g, "’");
      expect(html).toContain("gp-xero-blocked");
      expect(html).toContain(message);
      expect(html).toContain(action);
      expect(html).toContain('href="/settings/integrations/xero"');
      expect(html).not.toContain("Link client");
      expect(html).not.toContain("gp-settings-incomplete");
      // the schedule is never hidden behind Xero
      expect(html).toContain("Add stage");
      expect(html).toContain("$250,000.00");
    });
  }

  it("covers every readiness state the server can send", () => {
    expect([...blocked.map((b) => b[0]), "connected"].sort()).toEqual([...XERO_READINESS_STATES].sort());
  });

  it("a blocked job that is already linked still shows who it is linked to", () => {
    const html = card(standing({ state: "reconnect_required", client: { linked: true, name: "Built Pty Ltd", otherOrganisation: false, suggestion: null } }));
    expect(html).toContain("Client in Xero: Built Pty Ltd.");
  });

  it("still says nothing is sent to Xero, and offers no Send", () => {
    const html = card(standing({ client: { linked: true, name: "Built Pty Ltd", otherOrganisation: false, suggestion: null } }));
    expect(html).toContain("Nothing is sent to Xero from here yet.");
    expect(html).not.toMatch(/Send to Xero/i);
  });
});

describe("XeroContactPicker", () => {
  it("opens on the job's client name and asks for at least two letters before searching", () => {
    const html = render(createElement(XeroContactPicker, {
      initialQuery: "Built Pty Ltd", organisationName: "Buhl Electrical", busy: false, onClose: noop, onPick: async () => true,
    }));
    expect(html).toContain("Link this job&#x27;s client in Xero");
    expect(html).toContain("Search Buhl Electrical&#x27;s Xero contacts");
    expect(html).toContain('value="Built Pty Ltd"');
    expect(html).toContain("Add the client as a contact in Xero first");
  });

  it("results: one button per contact; none: says so with the query; error: the plain words", () => {
    const results = render(createElement(ContactResults, {
      state: { kind: "results", query: "built", contacts: [{ id: "c1", name: "Built Pty Ltd" }, { id: "c2", name: "Built Homes" }] }, busy: false, onPick: noop,
    }));
    expect(results).toContain("Built Pty Ltd");
    expect(results).toContain("Built Homes");
    expect(results).not.toContain("first 20");

    const none = render(createElement(ContactResults, { state: { kind: "results", query: "zzz", contacts: [] }, busy: false, onPick: noop }));
    expect(none).toContain("xero-contact-none");
    expect(none).toContain("zzz");

    const err = render(createElement(ContactResults, { state: { kind: "error", message: "Xero is busy right now. Wait a minute and try again." }, busy: false, onPick: noop }));
    expect(err).toContain('role="alert"');
    expect(err).toContain("Xero is busy right now");

    expect(render(createElement(ContactResults, { state: { kind: "searching" }, busy: false, onPick: noop }))).toContain("Searching Xero…");
    expect(render(createElement(ContactResults, { state: { kind: "idle" }, busy: false, onPick: noop }))).toContain("at least two letters");
  });

  it("says when the list was cut at 20", () => {
    const contacts = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, name: `Client ${i}` }));
    const html = render(createElement(ContactResults, { state: { kind: "results", query: "client", contacts }, busy: false, onPick: noop }));
    expect(html).toContain("Showing the first 20");
  });
});

const OPTIONS: InvoiceSettingsOptions = {
  accounts: [
    { code: "200", name: "Sales", taxType: "OUTPUT" },
    { code: "260", name: "Other Revenue", taxType: "OUTPUT" },
  ],
  taxRates: [
    { taxType: "EXEMPTOUTPUT", name: "GST Free Income", rateBp: 0 },
    { taxType: "OUTPUT", name: "GST on Income", rateBp: 1000 },
  ],
};

function settings(over: Partial<InvoiceSettingsResponse> = {}): InvoiceSettingsResponse {
  return { xero: { state: "connected", organisationName: "Buhl Electrical" }, settings: null, complete: false, ...over };
}
const SAVED = {
  salesAccountCode: "200", salesAccountName: "Sales", taxType: "OUTPUT", taxName: "GST on Income",
  taxRateBp: 1000, paymentTermsDays: 30, version: 1,
};

const view = (d: InvoiceSettingsResponse, options: InvoiceSettingsOptions | null = OPTIONS, optionsError: string | null = null) =>
  render(createElement(InvoiceSettingsView, { data: d, options, optionsError, onRetryOptions: noop, onSaved: noop }));

describe("XeroInvoiceSettingsPanel", () => {
  it("shell: titled Invoices, says nothing is sent from here, and shows no choices before the data", () => {
    const html = render(createElement(XeroInvoiceSettingsPanel));
    expect(html).toContain("Invoices");
    expect(html).toContain("Nothing is sent to Xero from");
    expect(html).toContain("Loading…");
    expect(html).not.toContain("<select");
  });

  it("nothing saved yet: the three choices, Xero's lists, and 'Not chosen yet.'", () => {
    const html = view(settings());
    expect(html).toContain("Lists read live from");
    expect(html).toContain("Buhl Electrical");
    expect(html).toContain("200 — Sales");
    expect(html).toContain("260 — Other Revenue");
    expect(html).toContain("GST on Income (10%)");
    expect(html).toContain("GST Free Income (0%)");
    expect(html).toContain("Payment terms (days)");
    expect(html).toContain("Not chosen yet.");
    expect(html).toContain("Save invoice defaults");
  });

  it("saved: the saved choices are selected and the 'not chosen' note is gone", () => {
    const html = view(settings({ settings: SAVED, complete: true }));
    expect(html).toMatch(/<option value="200" selected="">200 — Sales<\/option>/);
    expect(html).toMatch(/<option value="OUTPUT" selected="">GST on Income \(10%\)<\/option>/);
    expect(html).toContain('value="30"');
    expect(html).not.toContain("Not chosen yet.");
  });

  it("a saved choice Xero no longer offers stays visible and is named as gone — never silently swapped", () => {
    const html = view(settings({ settings: { ...SAVED, salesAccountCode: "210", salesAccountName: "Old Sales", taxType: "OLDTAX", taxName: "Old GST" }, complete: true }));
    expect(html).toContain("210 — Old Sales (no longer active in Xero)");
    expect(html).toContain("Old GST (no longer active in Xero)");
  });

  it("options still loading, unreadable, or empty each say so", () => {
    expect(view(settings(), null)).toContain("Reading your accounts and tax rates from Xero…");
    const err = view(settings(), null, "Xero is busy right now. Wait a minute and try again.");
    expect(err).toContain("xero-invoice-options-error");
    expect(err).toContain("Xero is busy right now");
    expect(err).toContain("Try again");
    expect(view(settings(), { accounts: [], taxRates: OPTIONS.taxRates })).toContain("no active revenue account with a code");
    expect(view(settings(), { accounts: OPTIONS.accounts, taxRates: [] })).toContain("no active tax rate that can be used on sales");
  });

  it("missing invoice permission: a Reconnect button that restarts the Xero connect, and no form", () => {
    const html = view(settings({ xero: { state: "missing_permission", organisationName: "Buhl Electrical" } }));
    expect(html).toContain("xero-invoice-settings-blocked");
    expect(html).toContain("without permission for invoices");
    expect(html).toContain('href="/api/xero/connect"');
    expect(html).toContain("Reconnect Xero to allow invoices");
    expect(html).not.toContain("<select");
  });

  it("an expired connection also offers Reconnect; not connected points at the panel above", () => {
    const expired = view(settings({ xero: { state: "reconnect_required", organisationName: null } }));
    expect(expired).toContain('href="/api/xero/connect"');
    const off = view(settings({ xero: { state: "disconnected", organisationName: null } }));
    expect(off).toContain("Connect Xero in the panel above first.");
    expect(off).not.toContain('href="/api/xero/connect"');
    expect(off).not.toContain("<select");
  });

  it("blocked but previously saved: still shows what was saved", () => {
    const html = view(settings({ xero: { state: "reconnect_required", organisationName: null }, settings: SAVED, complete: true }));
    expect(html).toContain("Saved: 200 — Sales · GST on Income (10%) · 30 days.");
  });
});
