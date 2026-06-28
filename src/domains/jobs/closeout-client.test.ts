import { describe, expect, it } from "vitest";
import { preFreezeCloseoutWarning } from "./closeout-client";

/**
 * #374 (AC3) — the NON-GATING pre-freeze advisory. It READS closeout readiness
 * so the #349 close-out can warn, but never blocks the freeze (reads, doesn't
 * enforce). Pure: derives a message from the matrix counts.
 */
describe("preFreezeCloseoutWarning", () => {
  it("returns null when there is nothing to close out", () => {
    expect(preFreezeCloseoutWarning(null)).toBeNull();
    expect(preFreezeCloseoutWarning({ total: 0, discharged: 0 })).toBeNull();
  });

  it("returns null when every obligation is discharged (no fake all-clear banner)", () => {
    expect(preFreezeCloseoutWarning({ total: 3, discharged: 3 })).toBeNull();
  });

  it("warns about the outstanding count but makes clear it is not a block", () => {
    const msg = preFreezeCloseoutWarning({ total: 5, discharged: 2 });
    expect(msg).toContain("3 of 5");
    expect(msg).toContain("still outstanding");
    expect(msg!.toLowerCase()).toContain("not a block");
  });

  it("singularises a single obligation", () => {
    const msg = preFreezeCloseoutWarning({ total: 1, discharged: 0 });
    expect(msg).toContain("1 of 1 closeout obligation ");
  });
});
