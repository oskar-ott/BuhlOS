import { describe, it, expect } from "vitest";
import {
  deriveAppAccess,
  appAccessFooter,
  displayRoleLabel,
  employeeStatusMarker,
  matchesFilter,
  matchesSearch,
  filterEmployees,
  filterCounts,
  isValidEmail,
  findDuplicateEmail,
  normaliseAuMobile,
  isValidAuMobile,
  isCommonPin,
  validatePin,
  pinsMatch,
  isUrlSafeToken,
  computeExpiresAt,
  isInviteExpired,
  displayNameFor,
  initialsFor,
  deriveEmployeeFields,
  ROLE_ORDER,
} from "./service";
import { CreateEmployeePayloadSchema } from "./schema";
import { inviteSummaryLine } from "./format";
import { SAMPLE_EMPLOYEE_ROWS } from "./fixtures";
import type { Employee, EmployeeRole, InvitePublic } from "./types";

/* ----------------------------------------------------------------------- */
/* Roles → app access (bible §09 matrix)                                   */
/* ----------------------------------------------------------------------- */

describe("deriveAppAccess", () => {
  const expected: Record<EmployeeRole, ReturnType<typeof deriveAppAccess>> = {
    admin: "both",
    pm: "buhlos",
    office: "buhlos",
    estimator: "buhlos",
    leadinghand: "phil",
    electrician: "phil",
    apprentice: "phil",
    labourer: "phil",
  };
  it("maps every role to the matrix surface", () => {
    for (const role of ROLE_ORDER) {
      expect(deriveAppAccess(role)).toBe(expected[role]);
    }
  });
  it("covers all eight roles", () => {
    expect(ROLE_ORDER).toHaveLength(8);
  });
  it("renders a plain-language footer per access bucket", () => {
    expect(appAccessFooter("apprentice")).toMatch(/Phil only/);
    expect(appAccessFooter("office")).toMatch(/BuhlOS only/);
    expect(appAccessFooter("admin")).toMatch(/both/i);
  });
});

describe("displayRoleLabel", () => {
  it("uses the bible title for the eight roles", () => {
    expect(displayRoleLabel("apprentice")).toBe("Apprentice");
    expect(displayRoleLabel("leadinghand")).toBe("Leading hand");
    expect(displayRoleLabel("admin")).toBe("Admin / Owner");
  });
  it("maps legacy users.json tiers to friendly labels", () => {
    expect(displayRoleLabel("owner")).toBe("Admin / Owner");
    expect(displayRoleLabel("boss")).toBe("Admin / Owner");
    expect(displayRoleLabel("leadingHand")).toBe("Leading hand");
    expect(displayRoleLabel("tradie")).toBe("Field worker");
    expect(displayRoleLabel("client")).toBe("Client");
  });
  it("handles empty / unknown gracefully", () => {
    expect(displayRoleLabel("")).toBe("—");
    expect(displayRoleLabel(null)).toBe("—");
    expect(displayRoleLabel("wizard")).toBe("Wizard");
  });
});

/* ----------------------------------------------------------------------- */
/* Status marker composition (bible §08)                                   */
/* ----------------------------------------------------------------------- */

describe("employeeStatusMarker", () => {
  const e = (status: Employee["status"]): Pick<Employee, "status"> => ({ status });
  const i = (status: InvitePublic["status"]): Pick<InvitePublic, "status"> => ({ status });

  it("disabled employee always reads Disabled, regardless of invite", () => {
    expect(employeeStatusMarker(e("disabled"), i("sent"))).toMatchObject({
      key: "disabled",
      label: "Disabled",
    });
  });
  it("active employee reads Active (setup complete = active)", () => {
    expect(employeeStatusMarker(e("active"), null)).toMatchObject({ key: "active", tone: "success" });
  });
  it("draft employee with no invite reads Draft", () => {
    expect(employeeStatusMarker(e("draft"), null)).toMatchObject({ key: "draft", tone: "neutral" });
  });
  it("maps each invite status to the fixed vocabulary", () => {
    expect(employeeStatusMarker(e("invited"), i("sent"))).toMatchObject({ key: "invited", tone: "warning" });
    expect(employeeStatusMarker(e("invited"), i("opened"))).toMatchObject({ key: "opened", tone: "info" });
    expect(employeeStatusMarker(e("invited"), i("accepted"))).toMatchObject({ key: "active", tone: "success" });
    expect(employeeStatusMarker(e("invited"), i("expired"))).toMatchObject({ key: "expired", tone: "danger" });
    expect(employeeStatusMarker(e("invited"), i("revoked"))).toMatchObject({ key: "revoked" });
    expect(employeeStatusMarker(e("invited"), i("failed"))).toMatchObject({ key: "failed", tone: "danger" });
  });
});

describe("inviteSummaryLine", () => {
  const sentInvite: InvitePublic = {
    id: "i1",
    employeeId: "e1",
    email: "liam@example.com",
    status: "sent",
    expiresAt: "2026-06-11T00:00:00.000Z",
    sentAt: "2026-05-29T00:00:00.000Z",
    createdBy: "u_admin",
    resentCount: 0,
  };

  it("does not describe copy-link invites as emailed", () => {
    expect(inviteSummaryLine({ ...sentInvite, delivery: "link" })).toContain("Link created");
    expect(inviteSummaryLine({ ...sentInvite, delivery: "link" })).toContain("worker setup lands in O3");
  });

  it("keeps sent wording for real email delivery", () => {
    expect(inviteSummaryLine({ ...sentInvite, delivery: "email" })).toContain("Sent");
    expect(inviteSummaryLine({ ...sentInvite, delivery: "email" })).toContain("liam@example.com");
  });
});

/* ----------------------------------------------------------------------- */
/* Register filtering + search (bible A1)                                  */
/* ----------------------------------------------------------------------- */

describe("register filters", () => {
  it("counts subsets correctly against the sample register", () => {
    const counts = filterCounts(SAMPLE_EMPLOYEE_ROWS);
    expect(counts.all).toBe(6);
    expect(counts.active).toBe(3); // Jared, Oskar, Kane
    expect(counts.invited).toBe(1); // Liam (sent)
    expect(counts.incomplete).toBe(1); // Sam (expired)
    expect(counts.disabled).toBe(0);
    expect(counts.field).toBe(4); // Jared, Liam, Sam, Kane (phil)
    expect(counts.admin).toBe(2); // Oskar (both), Rachel (office)
  });
  it("filterEmployees('active') returns only active rows", () => {
    const rows = filterEmployees(SAMPLE_EMPLOYEE_ROWS, "active", "");
    expect(rows.map((r) => r.employee.firstName).sort()).toEqual(["Jared", "Kane", "Oskar"]);
  });
  it("search finds by name", () => {
    const rows = filterEmployees(SAMPLE_EMPLOYEE_ROWS, "all", "marriott");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.employee.firstName).toBe("Liam");
  });
  it("search finds by email", () => {
    const rows = filterEmployees(SAMPLE_EMPLOYEE_ROWS, "all", "kane.p@gmail");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.employee.firstName).toBe("Kane");
  });
  it("matchesFilter/matchesSearch compose", () => {
    const liam = SAMPLE_EMPLOYEE_ROWS.find((r) => r.employee.id === "e_liam")!;
    expect(matchesFilter(liam, "invited")).toBe(true);
    expect(matchesFilter(liam, "active")).toBe(false);
    expect(matchesSearch(liam, "LIAM")).toBe(true);
    expect(matchesSearch(liam, "sparky")).toBe(false);
  });
});

/* ----------------------------------------------------------------------- */
/* Email + duplicate (bible A2 / §11)                                      */
/* ----------------------------------------------------------------------- */

describe("email validation + duplicate check", () => {
  it("validates email format", () => {
    expect(isValidEmail("liam.m@gmail.com")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
  });
  it("blocks duplicate email case-insensitively and returns the existing id", () => {
    const list = [
      { id: "e1", email: "Liam.M@gmail.com" },
      { id: "e2", email: "kane@buhl.com.au" },
    ];
    expect(findDuplicateEmail(list, "liam.m@GMAIL.com")).toBe("e1");
    expect(findDuplicateEmail(list, "new@x.com")).toBeNull();
  });
  it("ignores the row being edited via exceptId", () => {
    const list = [{ id: "e1", email: "liam.m@gmail.com" }];
    expect(findDuplicateEmail(list, "liam.m@gmail.com", "e1")).toBeNull();
  });
});

/* ----------------------------------------------------------------------- */
/* AU mobile (bible A2 — validated when present)                           */
/* ----------------------------------------------------------------------- */

describe("normaliseAuMobile", () => {
  it("normalises valid AU mobiles to E.164", () => {
    expect(normaliseAuMobile("0421558902")).toBe("+61421558902");
    expect(normaliseAuMobile("0421 558 902")).toBe("+61421558902");
    expect(normaliseAuMobile("+61 421 558 902")).toBe("+61421558902");
    expect(normaliseAuMobile("61421558902")).toBe("+61421558902");
  });
  it("rejects non-mobiles and malformed input", () => {
    expect(normaliseAuMobile("0812345678")).toBeNull(); // landline (08)
    expect(normaliseAuMobile("12345")).toBeNull();
    expect(normaliseAuMobile("+1 555 0100")).toBeNull();
    expect(isValidAuMobile("0421558902")).toBe(true);
    expect(isValidAuMobile("not a phone")).toBe(false);
  });
});

/* ----------------------------------------------------------------------- */
/* PIN rules (bible §06 P5 + §10 S09 — O3-ready)                           */
/* ----------------------------------------------------------------------- */

describe("PIN rules", () => {
  it("rejects common / sequential / repeated PINs", () => {
    for (const bad of ["0000", "1234", "1111", "2345", "9876", "4321", "7777"]) {
      expect(isCommonPin(bad)).toBe(true);
      expect(validatePin(bad).ok).toBe(false);
    }
  });
  it("accepts a non-trivial 4-digit PIN", () => {
    expect(isCommonPin("8053")).toBe(false);
    expect(validatePin("8053")).toEqual({ ok: true });
  });
  it("rejects non-4-digit input", () => {
    expect(validatePin("123").ok).toBe(false);
    expect(validatePin("12a4").ok).toBe(false);
    expect(validatePin("123456").ok).toBe(false);
  });
  it("confirms matching PINs", () => {
    expect(pinsMatch("8053", "8053")).toBe(true);
    expect(pinsMatch("8053", "8054")).toBe(false);
  });
});

/* ----------------------------------------------------------------------- */
/* Token format (bible §10 S01)                                            */
/* ----------------------------------------------------------------------- */

describe("isUrlSafeToken", () => {
  it("accepts a 32-byte url-safe token (43+ chars)", () => {
    const tok = "aZ0_-bcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM"; // 43 chars, url-safe
    expect(tok.length).toBeGreaterThanOrEqual(43);
    expect(isUrlSafeToken(tok)).toBe(true);
  });
  it("rejects short tokens", () => {
    expect(isUrlSafeToken("tooShort")).toBe(false);
  });
  it("rejects non-url-safe characters", () => {
    expect(isUrlSafeToken("a/b+c=" + "x".repeat(40))).toBe(false);
  });
});

/* ----------------------------------------------------------------------- */
/* Expiry (bible §10 S04)                                                   */
/* ----------------------------------------------------------------------- */

describe("invite expiry", () => {
  it("computes +14 days", () => {
    const from = "2026-05-28T00:00:00.000Z";
    const exp = computeExpiresAt(from, 14);
    expect(exp.slice(0, 10)).toBe("2026-06-11");
  });
  it("flags expired invites server-side", () => {
    const past = { expiresAt: "2026-05-01T00:00:00.000Z", status: "sent" as const };
    const future = { expiresAt: "2099-01-01T00:00:00.000Z", status: "sent" as const };
    const now = Date.parse("2026-05-28T00:00:00.000Z");
    expect(isInviteExpired(past, now)).toBe(true);
    expect(isInviteExpired(future, now)).toBe(false);
  });
  it("never marks accepted or revoked invites as expired", () => {
    const now = Date.parse("2026-05-28T00:00:00.000Z");
    expect(isInviteExpired({ expiresAt: "2026-05-01T00:00:00.000Z", status: "accepted" }, now)).toBe(false);
    expect(isInviteExpired({ expiresAt: "2026-05-01T00:00:00.000Z", status: "revoked" }, now)).toBe(false);
  });
});

/* ----------------------------------------------------------------------- */
/* Display helpers                                                          */
/* ----------------------------------------------------------------------- */

describe("name helpers", () => {
  it("computes display name with nickname override", () => {
    expect(displayNameFor({ firstName: "Liam", lastName: "Marriott", displayName: null })).toBe("Liam Marriott");
    expect(displayNameFor({ firstName: "Liam", lastName: "Marriott", displayName: "Lemo" })).toBe("Lemo");
  });
  it("computes initials", () => {
    expect(initialsFor({ firstName: "Liam", lastName: "Marriott", displayName: null })).toBe("LM");
    expect(initialsFor({ firstName: "Cher", lastName: "", displayName: null })).toBe("CH");
  });
  it("deriveEmployeeFields wires appAccess + displayName", () => {
    expect(
      deriveEmployeeFields({ role: "apprentice", firstName: "Liam", lastName: "Marriott" })
    ).toEqual({ appAccess: "phil", displayName: "Liam Marriott" });
  });
});

/* ----------------------------------------------------------------------- */
/* Create payload schema (bible A2 — apprentice year required)             */
/* ----------------------------------------------------------------------- */

describe("CreateEmployeePayloadSchema", () => {
  const base = {
    firstName: "Liam",
    lastName: "Marriott",
    email: "liam.m@gmail.com",
    role: "electrician" as const,
  };
  it("accepts a valid minimal payload", () => {
    expect(CreateEmployeePayloadSchema.safeParse(base).success).toBe(true);
  });
  it("requires apprenticeYear when role = apprentice", () => {
    const noYear = CreateEmployeePayloadSchema.safeParse({ ...base, role: "apprentice" });
    expect(noYear.success).toBe(false);
    const withYear = CreateEmployeePayloadSchema.safeParse({
      ...base,
      role: "apprentice",
      apprenticeYear: 2,
    });
    expect(withYear.success).toBe(true);
  });
  it("rejects an invalid email", () => {
    expect(CreateEmployeePayloadSchema.safeParse({ ...base, email: "nope" }).success).toBe(false);
  });
  it("requires first + last name", () => {
    expect(CreateEmployeePayloadSchema.safeParse({ ...base, firstName: "" }).success).toBe(false);
  });
});
