import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * api/_lib/xero/employee-matching.js (#248) — pure suggestion ranking:
 * email-exact beats legacy-id beats name; duplicate legacy ids are NAMED
 * conflicts; invalid legacy ids stay visible; ambiguous names suggest
 * nothing; suggestions are never links.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { suggestEmployeeMatches } = requireFromHere("../../../api/_lib/xero/employee-matching.js");

const EMPLOYEES = [
  { xeroId: "emp-karen", name: "Karen Buhl", active: true, payload: { email: "karen@buhl.com", status: "ACTIVE" } },
  { xeroId: "emp-daniel", name: "Daniel Buhl", active: true, payload: { email: "daniel@buhl.com", status: "ACTIVE" } },
  { xeroId: "emp-alex", name: "Alex Buhltest", active: true, payload: { email: null, status: "ACTIVE" } },
];

describe("suggestEmployeeMatches", () => {
  it("email-exact beats legacy id beats name", () => {
    const out = suggestEmployeeMatches(
      [
        {
          id: "w1",
          name: "Alex Buhltest", // name-matches emp-alex
          email: "KAREN@buhl.com", // email-matches emp-karen (case-insensitive)
          xeroEmployeeId: "emp-daniel", // legacy-matches emp-daniel
        },
      ],
      EMPLOYEES
    );
    expect(out.get("w1").suggestion).toEqual({ employeeId: "emp-karen", employeeName: "Karen Buhl", reason: "email" });

    const noEmail = suggestEmployeeMatches(
      [{ id: "w1", name: "Alex Buhltest", email: null, xeroEmployeeId: "emp-daniel" }],
      EMPLOYEES
    );
    expect(noEmail.get("w1").suggestion).toEqual({
      employeeId: "emp-daniel",
      employeeName: "Daniel Buhl",
      reason: "legacy_id",
    });

    const nameOnly = suggestEmployeeMatches([{ id: "w1", name: "alex buhltest ", email: null }], EMPLOYEES);
    expect(nameOnly.get("w1").suggestion).toEqual({
      employeeId: "emp-alex",
      employeeName: "Alex Buhltest",
      reason: "name",
    });
  });

  it("no email and no matches degrades to no suggestion — never a guess", () => {
    const out = suggestEmployeeMatches([{ id: "w1", name: "Somebody Else", email: null }], EMPLOYEES);
    expect(out.get("w1")).toEqual({ suggestion: null, invalidLegacyId: null, legacyConflictWith: [] });
  });

  it("an invalid legacy id is returned visibly, never dropped", () => {
    const out = suggestEmployeeMatches(
      [{ id: "w1", name: "Nobody", email: null, xeroEmployeeId: "old-freetext-id" }],
      EMPLOYEES
    );
    expect(out.get("w1").invalidLegacyId).toBe("old-freetext-id");
    expect(out.get("w1").suggestion).toBeNull();
  });

  it("duplicate legacy ids on two workers are a NAMED conflict, never two suggestions", () => {
    const out = suggestEmployeeMatches(
      [
        { id: "w1", name: "A", email: null, xeroEmployeeId: "emp-karen" },
        { id: "w2", name: "B", email: null, xeroEmployeeId: "emp-karen" },
      ],
      EMPLOYEES
    );
    expect(out.get("w1").legacyConflictWith).toEqual(["w2"]);
    expect(out.get("w2").legacyConflictWith).toEqual(["w1"]);
    expect(out.get("w1").suggestion).toBeNull();
    expect(out.get("w2").suggestion).toBeNull();
  });

  it("two identically-named employees make the name signal ambiguous — no suggestion", () => {
    const twins = [
      ...EMPLOYEES,
      { xeroId: "emp-karen-2", name: "Karen Buhl", active: true, payload: { email: "karen2@buhl.com" } },
    ];
    const out = suggestEmployeeMatches([{ id: "w1", name: "Karen Buhl", email: null }], twins);
    expect(out.get("w1").suggestion).toBeNull();
  });
});
