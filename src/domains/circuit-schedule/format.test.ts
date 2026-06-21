import { describe, expect, it } from "vitest";
import {
  formatEditedAt,
  boardEditedLine,
  installState,
  boardProgress,
  boardProgressLine,
  scheduleSummary,
  scheduleSummaryLine,
} from "./format";

const ways = (...states: Array<string | undefined>) => ({ circuits: states.map((install) => ({ install })) });

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

describe("install state", () => {
  it("narrows to a known state, defaulting unknown/absent to todo", () => {
    expect(installState("installed")).toBe("installed");
    expect(installState("tested")).toBe("tested");
    expect(installState("bogus")).toBe("todo");
    expect(installState(undefined)).toBe("todo");
  });
});

describe("boardProgress", () => {
  it("counts installed (installed + tested) and tested honestly", () => {
    // todo, installed, tested, tested, (absent → todo)
    const p = boardProgress(ways("todo", "installed", "tested", "tested", undefined));
    expect(p).toEqual({ total: 5, installed: 3, tested: 2, todo: 2 });
  });

  it("is honest-empty with no ways", () => {
    expect(boardProgressLine(ways())).toBe("No ways yet");
  });

  it("reads installed/total with a tested tail", () => {
    expect(boardProgressLine(ways("installed", "tested", "todo"))).toBe("2/3 installed · 1 tested");
    expect(boardProgressLine(ways("todo", "todo"))).toBe("0/2 installed");
  });
});

describe("scheduleSummary", () => {
  it("rolls up boards + ways + installed across the job", () => {
    const boards = [ways("installed", "todo"), ways("tested")];
    expect(scheduleSummary(boards)).toEqual({ boards: 2, ways: 3, installed: 2, tested: 1 });
  });

  it("lines are honest for none / no-ways / progress", () => {
    expect(scheduleSummaryLine([])).toBe("No boards yet");
    expect(scheduleSummaryLine([ways()])).toBe("1 board · no ways yet");
    expect(scheduleSummaryLine([ways("installed", "todo"), ways("todo")])).toBe("2 boards · 1/3 ways installed");
  });
});
