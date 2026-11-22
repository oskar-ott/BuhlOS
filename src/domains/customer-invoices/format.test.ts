import { describe, expect, it } from "vitest";
import {
  STATUS_LABEL,
  STATUS_TONE,
  bpToInput,
  centsToInput,
  errorMessage,
  formatBp,
  formatCents,
  formatDay,
  parseDollarsToCents,
  parsePercentToBp,
  xeroBlocker,
} from "./format";
import { STAGE_DISPLAY_STATUSES, XERO_READINESS_STATES } from "./schema";

describe("customer-invoices format — Xero set-up (#1149)", () => {
  it("only a connected Xero has no blocker; every other state names a reason and a fix", () => {
    expect(xeroBlocker("connected")).toBeNull();
    for (const state of XERO_READINESS_STATES.filter((s) => s !== "connected")) {
      const b = xeroBlocker(state);
      expect(b, state).not.toBeNull();
      expect(b!.message.length).toBeGreaterThan(10);
      expect(b!.action.length).toBeGreaterThan(5);
    }
    expect(xeroBlocker("missing_permission")!.action).toBe("Reconnect Xero to allow invoices");
  });

  it("words every Xero and set-up error code plainly, without leaking the code", () => {
    const codes = [
      "contact_not_found", "contact_not_active", "account_not_in_xero", "tax_rate_not_in_xero",
      "xero_reconnect_required", "xero_not_connected", "xero_pending_selection", "xero_not_configured",
      "xero_rate_limit", "xero_timeout", "xero_network", "xero_server", "xero_forbidden", "xero_auth",
    ];
    for (const code of codes) {
      const msg = errorMessage(code, 409);
      expect(msg, code).not.toContain(code);
      expect(msg, code).not.toMatch(/error 409/);
    }
    // an unmapped Xero category still gets an honest generic line
    expect(errorMessage("xero_unexpected", 502)).toContain("502");
  });
});

describe("customer-invoices format", () => {
  it("formats cents exactly, to two decimals, with thousands separators", () => {
    expect(formatCents(12_345_60)).toBe("$12,345.60");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(-2_500_00)).toBe("-$2,500.00");
    expect(formatCents(null)).toBe("—");
    expect(formatCents(undefined)).toBe("—");
  });

  it("formats basis points as a plain percentage", () => {
    expect(formatBp(500)).toBe("5%");
    expect(formatBp(1250)).toBe("12.5%");
    expect(formatBp(333)).toBe("3.33%");
    expect(formatBp(10000)).toBe("100%");
    expect(formatBp(null)).toBe("—");
  });

  it("parses typed dollars to cents and refuses anything ambiguous", () => {
    expect(parseDollarsToCents("12000")).toBe(12_000_00);
    expect(parseDollarsToCents("12,000.50")).toBe(12_000_50);
    expect(parseDollarsToCents("$1,200")).toBe(1_200_00);
    expect(parseDollarsToCents(" 0.05 ")).toBe(5);
    expect(parseDollarsToCents("12.5")).toBe(12_50);
    expect(parseDollarsToCents("")).toBeNull();
    expect(parseDollarsToCents("0")).toBeNull();
    expect(parseDollarsToCents("-50")).toBeNull();
    expect(parseDollarsToCents("12.345")).toBeNull(); // never rounded into shape
    expect(parseDollarsToCents("twelve")).toBeNull();
    expect(parseDollarsToCents("1e5")).toBeNull();
    expect(parseDollarsToCents("999999999999")).toBeNull(); // over the typo guard
  });

  it("parses typed percentages to basis points", () => {
    expect(parsePercentToBp("20")).toBe(2000);
    expect(parsePercentToBp("12.5")).toBe(1250);
    expect(parsePercentToBp("5%")).toBe(500);
    expect(parsePercentToBp("100")).toBe(10000);
    expect(parsePercentToBp("100.01")).toBeNull();
    expect(parsePercentToBp("0")).toBeNull();
    expect(parsePercentToBp("0", { allowZero: true })).toBe(0);
    expect(parsePercentToBp("2.555")).toBeNull();
    expect(parsePercentToBp("-5")).toBeNull();
    expect(parsePercentToBp("")).toBeNull();
  });

  it("round-trips stored values back into the inputs", () => {
    expect(centsToInput(12_000_00)).toBe("12000");
    expect(centsToInput(12_000_50)).toBe("12000.50");
    expect(centsToInput(null)).toBe("");
    expect(parseDollarsToCents(centsToInput(98_765_43))).toBe(98_765_43);
    expect(bpToInput(1250)).toBe("12.5");
    expect(bpToInput(500)).toBe("5");
    expect(parsePercentToBp(bpToInput(333))).toBe(333);
  });

  it("formats a calendar day without timezone drift", () => {
    expect(formatDay("2026-12-01")).toBe("1 Dec 2026");
    expect(formatDay("2027-01-31")).toBe("31 Jan 2027");
    expect(formatDay(null)).toBe("");
    expect(formatDay("not-a-date")).toBe("");
    expect(formatDay("2026-13-01")).toBe("");
  });

  it("has a label and a tone for every status the server can send", () => {
    for (const s of STAGE_DISPLAY_STATUSES) {
      expect(STATUS_LABEL[s]).toBeTruthy();
      expect(STATUS_TONE[s]).toBeTruthy();
    }
  });

  it("explains every stable error code in plain words and never leaks the code", () => {
    for (const code of ["stale_version", "stage_not_editable", "stage_not_found", "job_not_found", "invalid_request", "store_unavailable", "store_unprovisioned"]) {
      const msg = errorMessage(code, 409);
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toContain(code);
    }
    expect(errorMessage(null, 500)).toContain("500");
    expect(errorMessage(null, 0)).toContain("Couldn't reach BuhlOS");
  });
});
