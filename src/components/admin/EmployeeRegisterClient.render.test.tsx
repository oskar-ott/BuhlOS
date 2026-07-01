import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { EmployeeRegisterClient } from "./EmployeeRegisterClient";
import type { EmployeeRow } from "@/domains/employees/types";

/**
 * SSR render smoke for the People register (§7A). Node env, no browser — the
 * drawers render closed (null) and the recents tracker only mounts when a row
 * is selected, so renderToString never touches a router. This pins the desktop
 * column contract, in particular the Mobile column the redesign added (the
 * number was already on row.employee.phone, shown only in the drawer before).
 */

function row(over: Partial<EmployeeRow["employee"]> & { id: string }): EmployeeRow {
  return {
    employee: {
      firstName: "Sam",
      lastName: "Sparks",
      email: "sam@example.com",
      role: "electrician",
      appAccess: "phil",
      status: "active",
      assignedJobIds: [],
      assignedGearIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "admin",
      source: "user",
      ...over,
    },
    invite: null,
    jobsCount: 0,
    gearCount: 0,
  } as EmployeeRow;
}

function render(rows: EmployeeRow[]): string {
  return renderToString(
    createElement(EmployeeRegisterClient, {
      initialRows: rows,
      emailConfigured: true,
      activeJobs: [],
    }),
  );
}

describe("EmployeeRegisterClient (§7A)", () => {
  it("renders a Mobile column header on the desktop grid", () => {
    const html = render([row({ id: "e1" })]);
    expect(html).toContain("Mobile");
  });

  it("shows the worker's phone number in the row when on file", () => {
    const html = render([row({ id: "e1", firstName: "Jo", phone: "0412 345 678" })]);
    expect(html).toContain("0412 345 678");
  });

  it("shows an honest dash (—) when no phone is on file, never a fake number", () => {
    const html = render([row({ id: "e1", firstName: "Pat", phone: null })]);
    // The row renders and carries the dash placeholder for the missing mobile.
    expect(html).toContain("Pat");
    expect(html).toContain("—");
  });
});
