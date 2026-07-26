import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { EmployeeRow } from "@/domains/employees/types";

/**
 * Lean-reset /employees re-skin (replica lines 421-455) — page-level SSR
 * smoke. Async server component: await for JSX, renderToString (node env),
 * next/headers + next/navigation + feature-flags mocked, global fetch stubbed
 * per-URL. Pins:
 *  - the fixed sub-line says BuhlOS (never the internal field-app name);
 *  - the four KPI tiles are the replica's row (on the books / set up on phone
 *    / leading hands / licences to watch) fed by real register + licence data;
 *  - a failed employees load renders the error card and NO tiles (no
 *    fabricated zeros).
 */

const COOKIE_VALUE =
  Buffer.from(
    // Admin-tier role that is not the literal "admin" string on purpose.
    JSON.stringify({ userId: "u-boss", role: "boss" })
  ).toString("base64url") + ".test-signature";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "buhl_session" ? { name, value: COOKIE_VALUE } : undefined,
  }),
  headers: async () => ({ get: () => null }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`unexpected redirect to ${url}`);
  },
  usePathname: () => "/employees",
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("@/components/admin/AdminShell", () => ({
  AdminShell: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "buhlos-admin-shell" }, children as never),
}));

vi.mock("../../../../api/_lib/feature-flags.js", () => ({
  isFlagEnabled: async () => false, // signup_link dark in this smoke
}));

import { EmployeesScreen } from "./EmployeesScreen";

function row(over: {
  id: string;
  role: EmployeeRow["employee"]["role"];
  status: EmployeeRow["employee"]["status"];
  userId?: string | null;
}): EmployeeRow {
  return {
    employee: {
      id: over.id,
      firstName: "Test",
      lastName: over.id,
      email: `${over.id}@example.com`,
      role: over.role,
      appAccess: "phil",
      status: over.status,
      assignedJobIds: [],
      assignedGearIds: [],
      createdAt: "2026-05-01T00:00:00Z",
      createdBy: "u_admin",
      source: "user",
      userId: over.userId ?? null,
    },
    invite: null,
    jobsCount: 0,
    gearCount: 0,
  };
}

function stubFetch(overrides?: { employeesFail?: boolean }) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/employees")) {
      if (overrides?.employeesFail) {
        return new Response("nope", { status: 500 });
      }
      return Response.json({
        employees: [
          row({ id: "lh", role: "leadinghand", status: "active", userId: "u_lh" }),
          row({ id: "sparky", role: "electrician", status: "active", userId: "u_sparky" }),
          row({ id: "newbie", role: "apprentice", status: "invited" }),
        ],
        emailConfigured: true,
      });
    }
    if (url.includes("/api/jobs")) {
      return Response.json({ jobs: [] });
    }
    if (url.includes("/api/licences")) {
      return Response.json({
        credentials: [],
        types: [],
        withinDays: 30,
        worstByUser: { u_sparky: "expiring" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/employees — lean-reset screen", () => {
  it("renders the BuhlOS sub-line and the four replica KPI tiles from real data", async () => {
    stubFetch();
    const html = renderToString(await EmployeesScreen({}));
    expect(html).toContain(
      "Add a worker, send an invite, and they set up BuhlOS on their own phone."
    );
    expect(html).toContain("On the books");
    expect(html).toContain("Set up on phone");
    expect(html).toContain("+1 invite pending");
    expect(html).toContain("Leading hands");
    expect(html).toContain("Licences to watch");
    expect(html).toContain("0 expired · 1 due");
    // Register card mounted with the loaded rows.
    expect(html).toContain("Employee register");
  });

  it("a failed employees load renders the error card and suppresses the tiles", async () => {
    stubFetch({ employeesFail: true });
    const html = renderToString(await EmployeesScreen({}));
    expect(html).toContain("load employees");
    expect(html).not.toContain("On the books");
  });
});
