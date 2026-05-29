import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { EmployeeRegisterClient } from "./EmployeeRegisterClient";
import { AddEmployeeDrawer } from "./AddEmployeeDrawer";
import { EmployeeDetailDrawer } from "./EmployeeDetailDrawer";
import { EmployeeStatusChip } from "./EmployeeStatusChip";
import { SAMPLE_EMPLOYEE_ROWS } from "@/domains/employees/fixtures";

/**
 * Server-render smoke for the O1 admin onboarding UI. Mirrors the project's
 * existing renderToString approach (see StatusChip.test.tsx) — node env, no
 * JSX runtime swap, no browser. These catch SSR crashes, broken composition,
 * and missing/incorrect copy without needing auth or the Blob store (which
 * `next dev` can't provide locally anyway).
 */

const noop = () => {};

describe("EmployeeRegisterClient", () => {
  it("renders a populated register with names, roles and status markers", () => {
    const html = renderToString(
      createElement(EmployeeRegisterClient, {
        initialRows: SAMPLE_EMPLOYEE_ROWS,
        emailConfigured: false,
        activeJobs: [],
      })
    );
    expect(html).toContain("Add employee");
    expect(html).toContain("Liam Marriott");
    expect(html).toContain("Jared Doust");
    // Fixed status vocabulary (bible §08).
    expect(html).toContain("Active");
    expect(html).toContain("Invited");
    expect(html).toContain("Expired");
    // Filter bar + search.
    expect(html).toContain("Search name or email");
    expect(html).toContain("Incomplete");
  });

  it("renders the empty-state copy when there are no employees", () => {
    const html = renderToString(
      createElement(EmployeeRegisterClient, {
        initialRows: [],
        emailConfigured: false,
        activeJobs: [],
      })
    );
    expect(html).toContain("Add your first employee to start using Phil");
  });
});

describe("AddEmployeeDrawer", () => {
  it("renders the 4-step drawer starting on Details", () => {
    const html = renderToString(
      createElement(AddEmployeeDrawer, {
        open: true,
        onClose: noop,
        activeJobs: [],
        emailConfigured: false,
        onCreated: noop,
      })
    );
    // Step indicator labels (all four steps).
    expect(html).toContain("Details");
    expect(html).toContain("Access");
    expect(html).toContain("Jobs / gear");
    expect(html).toContain("Invite");
    // Step 1 fields.
    expect(html).toContain("First name");
    expect(html).toContain("Email");
  });

  it("renders nothing when closed", () => {
    const html = renderToString(
      createElement(AddEmployeeDrawer, {
        open: false,
        onClose: noop,
        activeJobs: [],
        emailConfigured: false,
        onCreated: noop,
      })
    );
    expect(html).toBe("");
  });
});

describe("EmployeeDetailDrawer", () => {
  it("renders the timeline, profile and danger zone for an invited employee", () => {
    const liam = SAMPLE_EMPLOYEE_ROWS.find((r) => r.employee.id === "e_liam")!;
    const html = renderToString(
      createElement(EmployeeDetailDrawer, {
        row: liam,
        emailConfigured: false,
        onClose: noop,
        onUpdated: noop,
      })
    );
    expect(html).toContain("Liam Marriott");
    expect(html).toContain("Invite timeline");
    expect(html).toContain("Danger zone");
    expect(html).toContain("Disable");
    // Copy-link affordance (email not configured).
    expect(html).toContain("Resend / copy link");
  });

  it("does not describe copy-link invites as emailed", () => {
    const liam = SAMPLE_EMPLOYEE_ROWS.find((r) => r.employee.id === "e_liam")!;
    const html = renderToString(
      createElement(EmployeeDetailDrawer, {
        row: {
          ...liam,
          invite: liam.invite ? { ...liam.invite, delivery: "link" } : null,
        },
        emailConfigured: false,
        onClose: noop,
        onUpdated: noop,
      })
    );
    expect(html).toContain("Link created");
    expect(html).toContain("set up Phil");
    expect(html).not.toContain("Sent");
  });

  it("renders nothing when no row is selected", () => {
    const html = renderToString(
      createElement(EmployeeDetailDrawer, {
        row: null,
        emailConfigured: false,
        onClose: noop,
        onUpdated: noop,
      })
    );
    expect(html).toBe("");
  });
});

describe("EmployeeStatusChip", () => {
  it("maps composed state to the fixed vocabulary", () => {
    const active = renderToString(
      createElement(EmployeeStatusChip, { employee: { status: "active" }, invite: null })
    );
    expect(active).toContain("Active");
    const expired = renderToString(
      createElement(EmployeeStatusChip, {
        employee: { status: "invited" },
        invite: { status: "expired" },
      })
    );
    expect(expired).toContain("Expired");
  });
});
