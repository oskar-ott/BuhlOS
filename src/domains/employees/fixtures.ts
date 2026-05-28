import type { Employee, EmployeeRow, InvitePublic } from "./types";

/**
 * Sample employee rows mirroring the bible's A1 register mock (Jared, Liam,
 * Sam, Oskar, Rachel, Kane). FOR TESTS AND PREVIEW ONLY — the live register
 * always renders real data from /api/employees or an honest empty state; it
 * must never silently show fixtures (bible §03 principle 5, "if it isn't
 * built, it says so").
 */

function emp(over: Partial<Employee> & Pick<Employee, "id" | "firstName" | "lastName" | "email" | "role" | "appAccess" | "status">): Employee {
  return {
    displayName: null,
    phone: null,
    apprenticeYear: null,
    assignedJobIds: [],
    assignedGearIds: [],
    notes: null,
    createdAt: "2026-05-26T14:02:00.000Z",
    createdBy: "u_oskar",
    lastActiveAt: null,
    disabledAt: null,
    userId: null,
    source: "onboarding",
    ...over,
  };
}

function invite(over: Partial<InvitePublic> & Pick<InvitePublic, "id" | "employeeId" | "email" | "status" | "expiresAt">): InvitePublic {
  return {
    sentAt: null,
    openedAt: null,
    acceptedAt: null,
    revokedAt: null,
    createdBy: "u_oskar",
    resentCount: 0,
    ...over,
  };
}

export const SAMPLE_EMPLOYEE_ROWS: EmployeeRow[] = [
  {
    employee: emp({
      id: "e_jared",
      firstName: "Jared",
      lastName: "Doust",
      email: "jared@buhl.com.au",
      role: "electrician",
      appAccess: "phil",
      status: "active",
      assignedJobIds: ["j1", "j2", "j3"],
      lastActiveAt: "2026-05-28T07:14:00.000Z",
      source: "user",
      userId: "u_jared",
    }),
    invite: null,
    jobsCount: 3,
    gearCount: 7,
  },
  {
    employee: emp({
      id: "e_liam",
      firstName: "Liam",
      lastName: "Marriott",
      email: "liam.m@gmail.com",
      role: "apprentice",
      apprenticeYear: 1,
      appAccess: "phil",
      status: "invited",
      assignedJobIds: ["j1"],
    }),
    invite: invite({
      id: "i_liam",
      employeeId: "e_liam",
      email: "liam.m@gmail.com",
      status: "sent",
      sentAt: "2026-05-26T14:03:00.000Z",
      expiresAt: "2026-06-11T14:03:00.000Z",
    }),
    jobsCount: 1,
    gearCount: 0,
  },
  {
    employee: emp({
      id: "e_sam",
      firstName: "Sam",
      lastName: "Renton",
      email: "sam.r@gmail.com",
      role: "apprentice",
      apprenticeYear: 2,
      appAccess: "phil",
      status: "invited",
    }),
    invite: invite({
      id: "i_sam",
      employeeId: "e_sam",
      email: "sam.r@gmail.com",
      status: "expired",
      sentAt: "2026-05-10T09:00:00.000Z",
      expiresAt: "2026-05-24T09:00:00.000Z",
      resentCount: 1,
    }),
    jobsCount: 0,
    gearCount: 0,
  },
  {
    employee: emp({
      id: "e_oskar",
      firstName: "Oskar",
      lastName: "Bühl",
      email: "oskar@buhl.com.au",
      role: "admin",
      appAccess: "both",
      status: "active",
      assignedJobIds: Array.from({ length: 12 }, (_, i) => `j${i}`),
      lastActiveAt: "2026-05-28T09:00:00.000Z",
      source: "user",
      userId: "u_oskar",
    }),
    invite: null,
    jobsCount: 12,
    gearCount: 3,
  },
  {
    employee: emp({
      id: "e_rachel",
      firstName: "Rachel",
      lastName: "Tan",
      email: "rachel@buhl.com.au",
      role: "office",
      appAccess: "buhlos",
      status: "draft",
    }),
    invite: null,
    jobsCount: 0,
    gearCount: 0,
  },
  {
    employee: emp({
      id: "e_kane",
      firstName: "Kane",
      lastName: "Pearce",
      email: "kane.p@gmail.com",
      role: "leadinghand",
      appAccess: "phil",
      status: "active",
      assignedJobIds: ["j1", "j2"],
      lastActiveAt: "2026-05-27T16:00:00.000Z",
      source: "user",
      userId: "u_kane",
    }),
    invite: null,
    jobsCount: 2,
    gearCount: 5,
  },
];
