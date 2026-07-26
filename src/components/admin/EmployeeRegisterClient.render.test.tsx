import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { EmployeeRegisterClient } from "./EmployeeRegisterClient";
import type { EmployeeRow } from "@/domains/employees/types";

/**
 * Lean-reset register re-skin (replica lines 429-442) — SSR snapshot of the
 * initial markup (node env; drawers render closed unless deep-linked):
 *  - one card headed "Employee register" with the navy "Add worker" button;
 *  - a row per worker: initials avatar · name · "role · mobile" · status
 *    pills · chevron (email stands in when no mobile is on file — honest,
 *    never a fake number);
 *  - licence pills read "Licence expired" / "Licence due soon" and the
 *    existing licence-attention toggle keeps its testid;
 *  - deep-linked drawer (initialSelectedId) shows the re-skinned head + the
 *    assigned-jobs list resolved from the active-jobs summary.
 */

function row(over: {
  id: string;
  first: string;
  last: string;
  role?: EmployeeRow["employee"]["role"];
  phone?: string | null;
  status?: EmployeeRow["employee"]["status"];
  userId?: string | null;
  assignedJobIds?: string[];
}): EmployeeRow {
  return {
    employee: {
      id: over.id,
      firstName: over.first,
      lastName: over.last,
      email: `${over.first.toLowerCase()}@example.com`,
      phone: over.phone ?? null,
      role: over.role ?? "electrician",
      appAccess: "phil",
      status: over.status ?? "active",
      assignedJobIds: over.assignedJobIds ?? [],
      assignedGearIds: [],
      createdAt: "2026-05-01T00:00:00Z",
      createdBy: "u_admin",
      source: "user",
      userId: over.userId ?? null,
    },
    invite: null,
    jobsCount: (over.assignedJobIds ?? []).length,
    gearCount: 0,
  };
}

const ROWS: EmployeeRow[] = [
  row({ id: "e_sam", first: "Sam", last: "Petrou", phone: "+61 400 111 222", userId: "u_sam" }),
  row({ id: "e_mia", first: "Mia", last: "Nguyen", userId: "u_mia" }),
];

const LICENCES = { u_sam: "expired", u_mia: "expiring" } as const;

function render(props?: Partial<Parameters<typeof EmployeeRegisterClient>[0]>) {
  return renderToString(
    createElement(EmployeeRegisterClient, {
      initialRows: ROWS,
      emailConfigured: true,
      activeJobs: [{ id: "j_1", name: "42 Sample St", ref: "IV3218" }],
      licenceStatusByUserId: LICENCES,
      ...props,
    })
  );
}

describe("EmployeeRegisterClient — lean-reset register card", () => {
  it("renders the card head, Add worker button and design-shaped rows", () => {
    const html = render();
    expect(html).toContain("Employee register");
    expect(html).toContain("Add worker");
    // Avatar initials + name + role·mobile sub-line.
    expect(html).toContain("SP");
    expect(html).toContain("Sam Petrou");
    expect(html).toContain("Electrician");
    expect(html).toContain("+61 400 111 222");
    // No mobile on file → the row falls back to the real email, never a fake.
    expect(html).toContain("mia@example.com");
  });

  it("renders the licence pills with the register copy and keeps the toggle testid", () => {
    const html = render();
    expect(html).toContain("Licence expired");
    expect(html).toContain("Licence due soon");
    expect(html).toContain("licence-attention-toggle");
    expect(html).toContain("Licences to watch");
  });

  it("keeps search + filter behaviour inside the card", () => {
    const html = render();
    expect(html).toContain("Search employees");
    expect(html).toContain("Incomplete");
    expect(html).toContain("Disabled");
  });

  it("deep-link opens the drawer with the re-skinned head and the assigned-jobs list", () => {
    const html = render({
      initialRows: [
        row({
          id: "e_sam",
          first: "Sam",
          last: "Petrou",
          phone: "+61 400 111 222",
          assignedJobIds: ["j_1", "j_gone"],
        }),
      ],
      initialSelectedId: "e_sam",
    });
    expect(html).toContain("Assigned jobs");
    // Known active job → ref · name; unknown id → the honest raw id.
    expect(html).toContain("IV3218");
    expect(html).toContain("42 Sample St");
    expect(html).toContain("j_gone");
  });

  it("empty register renders the add-first-worker empty state", () => {
    const html = render({ initialRows: [] });
    expect(html).toContain("No workers yet");
    expect(html).toContain("Add worker");
  });
});
