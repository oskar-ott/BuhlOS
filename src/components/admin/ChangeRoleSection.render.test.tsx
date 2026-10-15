import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ChangeRoleSection } from "./ChangeRoleSection";
import type { EmployeeRow } from "@/domains/employees/types";

/**
 * Server-render guards for the employee drawer's "Role" section. The write
 * itself (login + HR row together) is pinned by
 * employees-role-change-api.test.ts; these pin what the office SEES: the
 * current role with a real Change role action, every role on offer once
 * opened, and a Save that stays disabled until a different role is picked.
 * (renderToString skips effects and interaction — initial states only.)
 */

const SIMON = {
  id: "u_simon",
  firstName: "Simon",
  lastName: "Sparky",
  displayName: null,
  email: "",
  phone: null,
  role: "electrician",
  apprenticeYear: null,
  appAccess: "phil",
  status: "active",
  assignedJobIds: [],
  assignedGearIds: [],
  notes: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  createdBy: "u_simon",
  lastActiveAt: null,
  disabledAt: null,
  userId: "u_simon",
  source: "user",
} as unknown as EmployeeRow["employee"];

function render(defaultOpen = false): string {
  return renderToString(
    createElement(ChangeRoleSection, { employee: SIMON, onUpdated: () => {}, defaultOpen }),
  ).replace(/<!-- -->/g, "");
}

describe("ChangeRoleSection — honest initial states", () => {
  it("closed: shows the current role and a real Change role action, no picker", () => {
    const html = render();
    expect(html).toContain("Electrician · Field only");
    expect(html).toContain('data-testid="change-role-open"');
    expect(html).not.toContain('data-testid="change-role-form"');
  });

  it("open: every role is on offer, the current one is marked, and Save is disabled at rest", () => {
    const html = render(true);
    expect(html).toContain('data-testid="change-role-form"');
    for (const title of ["Admin / Owner", "Project manager", "Office", "Leading hand", "Electrician", "Apprentice", "Labourer", "Subcontractor"]) {
      expect(html).toContain(title);
    }
    expect(html).toMatch(/Electrician<span[^>]*> · current<\/span>/);
    expect(html).toContain("signing out and back in");
    const idx = html.indexOf('data-testid="change-role-save"');
    expect(idx).toBeGreaterThan(-1);
    const btn = html.slice(Math.max(0, idx - 400), idx + 200);
    expect(btn).toContain("disabled");
  });
});
