import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { EmployeeRegisterClient } from "./EmployeeRegisterClient";
import { EmployeeDetailDrawer } from "./EmployeeDetailDrawer";
import { LicencesSection } from "./LicencesSection";
import { PhilMyLicencesCard } from "@/components/phil/PhilMyLicencesCard";
import { SAMPLE_EMPLOYEE_ROWS } from "@/domains/employees/fixtures";
import type { Credential } from "@/domains/workforce/types";

/**
 * Server-render guards for the licence register surfaces (#331). Write paths
 * + scoping are pinned by the API/cron harnesses; these pin what the office
 * and the worker actually SEE: the register's needs-attention layer, the
 * drawer section's honest states, and Phil's read-only self-view.
 */

const noop = () => {};

const cred = (extra: Partial<Credential>): Credential =>
  ({
    id: "c1",
    kind: "licence",
    userId: "u_jared",
    typeId: "electrical",
    label: "Electrical licence",
    number: null,
    licenceClass: null,
    notes: null,
    issueDate: null,
    expiryDate: "2026-07-01",
    status: "expiring",
    daysToExpiry: 18,
    ...extra,
  }) as Credential;

describe("EmployeeRegisterClient — licence attention layer", () => {
  it("flags workers whose tickets need attention + offers the filter toggle", () => {
    const html = renderToString(
      createElement(EmployeeRegisterClient, {
        initialRows: SAMPLE_EMPLOYEE_ROWS,
        emailConfigured: false,
        activeJobs: [],
        licenceStatusByUserId: { u_jared: "expired", u_oskar: "expiring" },
      })
    );
    expect(html).toContain("Licences need attention");
    expect(html).toContain("licence-attention-toggle");
    expect(html).toContain("Ticket expired");
    expect(html).toContain("Ticket expiring");
  });

  it("renders no licence layer at all when the map is empty (fail-soft)", () => {
    const html = renderToString(
      createElement(EmployeeRegisterClient, {
        initialRows: SAMPLE_EMPLOYEE_ROWS,
        emailConfigured: false,
        activeJobs: [],
        licenceStatusByUserId: {},
      })
    );
    expect(html).not.toContain("Licences need attention");
    expect(html).not.toContain("Ticket expired");
  });

  it("an all-ok register shows no warning chips", () => {
    const html = renderToString(
      createElement(EmployeeRegisterClient, {
        initialRows: SAMPLE_EMPLOYEE_ROWS,
        emailConfigured: false,
        activeJobs: [],
        licenceStatusByUserId: { u_jared: "ok" },
      })
    );
    expect(html).not.toContain("Ticket expired");
    expect(html).not.toContain("Licences need attention");
  });
});

describe("LicencesSection (drawer)", () => {
  it("activated worker: heading + Add affordance render (records load client-side)", () => {
    const html = renderToString(
      createElement(LicencesSection, { userId: "u_jared", workerName: "Jared" })
    );
    expect(html).toContain("Licences &amp; tickets");
    expect(html).toContain("licence-add-open");
  });

  it("pre-activation worker: honest note instead of a dead form", () => {
    const html = renderToString(
      createElement(LicencesSection, { userId: null, workerName: "Rachel" })
    );
    expect(html).toContain("finishes BuhlOS setup");
    expect(html).not.toContain("licence-add-open");
  });

  it("is composed into the employee detail drawer", () => {
    const jared = SAMPLE_EMPLOYEE_ROWS.find((r) => r.employee.id === "e_jared")!;
    const html = renderToString(
      createElement(EmployeeDetailDrawer, {
        row: jared,
        emailConfigured: false,
        onClose: noop,
        onUpdated: noop,
      })
    );
    expect(html).toContain("Licences &amp; tickets");
  });
});

describe("PhilMyLicencesCard", () => {
  it("lists the worker's tickets with status pills and expiry sentences", () => {
    const html = renderToString(
      createElement(PhilMyLicencesCard, {
        credentials: [
          cred({ id: "c1", status: "expired", daysToExpiry: -3, expiryDate: "2026-06-09" }),
          cred({
            id: "c2",
            label: "White card",
            status: "no-expiry",
            daysToExpiry: null,
            expiryDate: null,
          }),
        ],
        fetchError: null,
      })
    );
    expect(html).toContain("My licences");
    expect(html).toContain("Electrical licence");
    expect(html).toContain("Expired");
    expect(html).toContain("expired 3 days ago");
    expect(html).toContain("White card");
    expect(html).toContain("no expiry date");
  });

  it("honest empty state — never claims 'all current' with nothing on file", () => {
    const html = renderToString(
      createElement(PhilMyLicencesCard, { credentials: [], fetchError: null })
    );
    expect(html).toContain("None on file yet");
    expect(html).not.toContain("all current");
  });

  it("surfaces the load error", () => {
    const html = renderToString(
      createElement(PhilMyLicencesCard, { credentials: [], fetchError: "API 500" })
    );
    expect(html).toContain("API 500");
  });
});
