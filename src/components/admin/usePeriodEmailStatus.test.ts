import { describe, expect, it } from "vitest";
import { formatPeriodSend, parsePeriodEmailStatus } from "./usePeriodEmailStatus";

/**
 * The send surfaces show, BEFORE the button, who the email goes to and whether
 * this period already went (2026-09-23 audit). A failed/odd read is "unknown",
 * never "not sent".
 */
describe("parsePeriodEmailStatus", () => {
  it("not sent yet → ready with lastSent null", () => {
    expect(parsePeriodEmailStatus({ recipients: ["tia@x.com"], lastSent: null })).toEqual({
      kind: "ready",
      recipients: ["tia@x.com"],
      lastSent: null,
    });
  });

  it("a journalled send → who, when, to whom", () => {
    const s = parsePeriodEmailStatus({
      recipients: ["tia@x.com"],
      lastSent: {
        at: "2026-09-22T06:32:00.000Z",
        byName: "Tom Buhl",
        recipients: ["tia@x.com"],
        workerCount: 2,
        totalHours: 40,
      },
    });
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready" || !s.lastSent) throw new Error("expected a send");
    expect(s.lastSent.byName).toBe("Tom Buhl");
    expect(formatPeriodSend(s.lastSent)).toMatch(/by Tom Buhl$/);
  });

  it("a journal read the server couldn't do is unknown — never 'not sent'", () => {
    expect(parsePeriodEmailStatus({ recipients: [], lastSent: null, lastSentUnknown: true }).kind).toBe(
      "unknown"
    );
    // An old server that doesn't answer the question at all: also unknown.
    expect(parsePeriodEmailStatus({ recipients: ["tia@x.com"] }).kind).toBe("unknown");
  });
});
