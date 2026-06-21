import { describe, expect, it } from "vitest";
import { formatEditedAt, boardEditedLine } from "./format";

// Local-time inputs (no TZ designator → parsed as local per ES spec), so
// getHours()/getMinutes() are deterministic regardless of the runner's TZ.
const NOW = new Date("2026-06-21T15:00:00");

describe("formatEditedAt", () => {
  it("returns empty for an empty value", () => {
    expect(formatEditedAt("", NOW)).toBe("");
    expect(formatEditedAt(undefined, NOW)).toBe("");
  });

  it("passes through a non-ISO string (sample/legacy display strings)", () => {
    expect(formatEditedAt("Today · 14:20", NOW)).toBe("Today · 14:20");
  });

  it("formats a same-day ISO as Today · HH:MM", () => {
    expect(formatEditedAt("2026-06-21T14:05:00", NOW)).toBe("Today · 14:05");
  });

  it("formats an earlier day as D Mon · HH:MM", () => {
    expect(formatEditedAt("2026-06-12T16:40:00", NOW)).toBe("12 Jun · 16:40");
  });
});

describe("boardEditedLine", () => {
  it("joins when + who", () => {
    expect(boardEditedLine({ updated: "2026-06-21T14:05:00", updatedBy: "boss" }, NOW)).toBe("Today · 14:05 · boss");
  });

  it("drops a placeholder author and an empty stamp", () => {
    expect(boardEditedLine({ updated: "2026-06-21T14:05:00", updatedBy: "—" }, NOW)).toBe("Today · 14:05");
    expect(boardEditedLine({ updated: "", updatedBy: "" }, NOW)).toBe("");
  });
});
