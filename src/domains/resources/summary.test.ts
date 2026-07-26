import { describe, expect, it } from "vitest";
import type { EmployeeRow, EmployeeStatus, AppAccess } from "@/domains/employees/types";
import type { GearAsset } from "@/domains/gear/types";
import {
  buildPeopleSummary,
  buildGearSummary,
  type LicenceWorst,
} from "./summary";

/* ---------------------------------------------------------------------------
 * Factories — minimal valid rows; only the fields the VM reads are varied.
 * ------------------------------------------------------------------------- */

function row(over: {
  id: string;
  appAccess: AppAccess;
  status: EmployeeStatus;
  userId?: string | null;
  role?: EmployeeRow["employee"]["role"];
}): EmployeeRow {
  return {
    employee: {
      id: over.id,
      firstName: "Test",
      lastName: over.id,
      email: `${over.id}@example.com`,
      role: over.role ?? (over.appAccess === "phil" ? "electrician" : "office"),
      appAccess: over.appAccess,
      status: over.status,
      assignedJobIds: [],
      assignedGearIds: [],
      createdAt: "2026-05-01T00:00:00Z",
      createdBy: "u_admin",
      source: "user",
      userId: over.userId ?? null,
    },
    jobsCount: 0,
    gearCount: 0,
  };
}

const baseAsset: GearAsset = {
  id: "a_1",
  name: "Makita drill",
  type: "tool",
  identifier: "MK-001",
  notes: null,
  currentHolderId: null,
  currentHolderName: null,
  assignedAt: null,
  expectedReturn: null,
  archived: false,
  createdAt: "2026-05-01T08:00:00Z",
  updatedAt: "2026-05-01T08:00:00Z",
  createdBy: "u_admin",
};

function asset(over: Partial<GearAsset> & { id: string }): GearAsset {
  return { ...baseAsset, ...over };
}

const TODAY = "2026-06-15";

/* ---------------------------------------------------------------------------
 * People
 * ------------------------------------------------------------------------- */

describe("buildPeopleSummary", () => {
  it("counts on-the-books (non-disabled), set-up (active) and pending invites", () => {
    const rows: EmployeeRow[] = [
      row({ id: "a", appAccess: "buhlos", status: "active" }),
      row({ id: "b", appAccess: "both", status: "active" }),
      row({ id: "c", appAccess: "phil", status: "active" }),
      row({ id: "d", appAccess: "phil", status: "invited" }), // pending
      row({ id: "e", appAccess: "phil", status: "draft" }), // pending
      row({ id: "f", appAccess: "phil", status: "disabled" }), // off the books
    ];
    const vm = buildPeopleSummary({ rows, licenceStatusByUserId: {} });

    const byKey = Object.fromEntries(vm.tiles.map((t) => [t.key, t]));
    expect(byKey.books!.value).toBe("5"); // disabled excluded
    expect(byKey.books!.hint).toBe("active accounts");
    expect(byKey.setup!.value).toBe("3"); // status "active"
    expect(byKey.setup!.hint).toBe("+2 invites pending");
  });

  it("counts leading hands via the shared role predicates, with admins as the hint", () => {
    const rows: EmployeeRow[] = [
      row({ id: "lh", appAccess: "phil", status: "active", role: "leadinghand" }),
      row({ id: "boss", appAccess: "both", status: "active", role: "admin" }),
      row({ id: "sparky", appAccess: "phil", status: "active", role: "electrician" }),
      // disabled leading hand is off the books → not counted
      row({ id: "gone", appAccess: "phil", status: "disabled", role: "leadinghand" }),
    ];
    const vm = buildPeopleSummary({ rows, licenceStatusByUserId: {} });
    const leads = vm.tiles.find((t) => t.key === "leads")!;
    expect(leads.value).toBe("1");
    expect(leads.hint).toBe("+1 admin");
  });

  it("'everyone set up' hint when nothing is pending; licences calm when clear", () => {
    const rows: EmployeeRow[] = [row({ id: "a", appAccess: "buhlos", status: "active" })];
    const vm = buildPeopleSummary({ rows, licenceStatusByUserId: {} });
    const byKey = Object.fromEntries(vm.tiles.map((t) => [t.key, t]));
    expect(byKey.setup!.hint).toBe("everyone set up");
    expect(byKey.licences!.value).toBe("0");
    expect(byKey.licences!.tone).toBe("neutral");
    expect(byKey.licences!.hint).toBe("all current");
  });

  it("licences-to-watch counts only workers with an account + on-file status", () => {
    const worst: LicenceWorst = {
      u_sam: "expired",
      u_jess: "expiring",
      u_kim: "ok",
    };
    const rows: EmployeeRow[] = [
      row({ id: "sam", appAccess: "phil", status: "active", userId: "u_sam" }),
      row({ id: "jess", appAccess: "phil", status: "active", userId: "u_jess" }),
      row({ id: "kim", appAccess: "phil", status: "active", userId: "u_kim" }), // ok → not counted
      // no userId → can't have a status, never counted (no fabricated flag)
      row({ id: "new", appAccess: "phil", status: "invited", userId: null }),
    ];
    const vm = buildPeopleSummary({ rows, licenceStatusByUserId: worst });
    const lic = vm.tiles.find((t) => t.key === "licences")!;
    expect(lic.value).toBe("2"); // expired + due
    expect(lic.tone).toBe("warning"); // the replica's amber attention tile
    expect(lic.hint).toBe("1 expired · 1 due");
  });

  it("singular grammar for one account / one pending invite", () => {
    const vm = buildPeopleSummary({
      rows: [row({ id: "a", appAccess: "phil", status: "invited" })],
      licenceStatusByUserId: {},
    });
    const byKey = Object.fromEntries(vm.tiles.map((t) => [t.key, t]));
    expect(byKey.books!.hint).toBe("active account");
    expect(byKey.setup!.hint).toBe("+1 invite pending");
  });
});

/* ---------------------------------------------------------------------------
 * Gear
 * ------------------------------------------------------------------------- */

describe("buildGearSummary", () => {
  it("counts in-use / available / damaged+missing over live assets, excluding retired", () => {
    const assets: GearAsset[] = [
      asset({ id: "a1" }), // available
      asset({ id: "a2", currentHolderId: "u_sam" }), // assigned (in use)
      asset({ id: "a3", condition: "damaged" }), // damaged
      asset({ id: "a4", condition: "missing", currentHolderId: "u_jo" }), // missing
      asset({ id: "a5", archived: true }), // retired → excluded everywhere
    ];
    const vm = buildGearSummary({ assets, today: TODAY });
    const byKey = Object.fromEntries(vm.tiles.map((t) => [t.key, t]));
    expect(byKey.inuse!.value).toBe("1");
    expect(byKey.available!.value).toBe("1");
    expect(byKey.damaged!.value).toBe("2"); // damaged + missing
    expect(byKey.damaged!.tone).toBe("danger");
    expect(byKey.available!.tone).toBe("success");
  });

  it("calibration-due-soon reuses calibrationFlag (expired or within window)", () => {
    const assets: GearAsset[] = [
      asset({ id: "cal_overdue", calibrationDue: "2026-06-01" }), // expired (< today)
      asset({ id: "cal_soon", calibrationDue: "2026-06-20" }), // within 14d
      asset({ id: "cal_far", calibrationDue: "2026-12-01" }), // outside window → not flagged
      asset({ id: "cal_none" }), // no calibrationDue → not flagged
    ];
    const vm = buildGearSummary({ assets, today: TODAY });
    const cal = vm.tiles.find((t) => t.key === "cal")!;
    expect(cal.value).toBe("2"); // overdue + soon
    expect(cal.tone).toBe("warning");
    expect(cal.hint).toBe("within 14 days");
  });

  it("does not double-count an asset that is both damaged and calibration-flagged in 'need attention'", () => {
    const assets: GearAsset[] = [
      asset({ id: "both", condition: "damaged", calibrationDue: "2026-06-01" }),
      asset({ id: "clean" }),
    ];
    const vm = buildGearSummary({ assets, today: TODAY });
    // 2 tracked, 1 distinct needs-attention
    expect(vm.subline).toBe("2 tracked · 1 need attention");
  });

  it("retired assets are excluded from the tracked tally", () => {
    const assets: GearAsset[] = [
      asset({ id: "a1" }),
      asset({ id: "a2", archived: true }),
    ];
    const vm = buildGearSummary({ assets, today: TODAY });
    expect(vm.subline).toBe("1 tracked · 0 need attention");
  });

  it("respects a custom calibration window", () => {
    const assets: GearAsset[] = [asset({ id: "cal", calibrationDue: "2026-06-25" })];
    expect(
      buildGearSummary({ assets, today: TODAY, calibrationWithinDays: 7 }).tiles.find(
        (t) => t.key === "cal",
      )!.value,
    ).toBe("0"); // 10 days out, outside a 7-day window
    expect(
      buildGearSummary({ assets, today: TODAY, calibrationWithinDays: 14 }).tiles.find(
        (t) => t.key === "cal",
      )!.value,
    ).toBe("1"); // inside 14
  });

  it("calm tones and 'all sound' / 'test gear current' hints when nothing needs attention", () => {
    const assets: GearAsset[] = [asset({ id: "a1" }), asset({ id: "a2", currentHolderId: "u_sam" })];
    const vm = buildGearSummary({ assets, today: TODAY });
    const byKey = Object.fromEntries(vm.tiles.map((t) => [t.key, t]));
    expect(byKey.damaged!.value).toBe("0");
    expect(byKey.damaged!.tone).toBe("neutral");
    expect(byKey.damaged!.hint).toBe("all sound");
    expect(byKey.cal!.hint).toBe("test gear current");
  });
});
