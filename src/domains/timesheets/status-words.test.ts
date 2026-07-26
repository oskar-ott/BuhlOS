import { describe, expect, it } from "vitest";
import { STATUS_CELL_WORDS, STATUS_WORDS, statusPhrase, statusWord } from "./status-words";
import { TIME_ENTRY_STATUSES } from "./schema";

/**
 * The one Phil status vocabulary (2026-07-26 owner-directed). These pin the
 * four site words so a copy tweak on one screen can't silently fork the
 * language — change the words HERE (and mean it) or nowhere.
 */
describe("status-words — the one worker vocabulary", () => {
  it("pins the four site words", () => {
    expect(STATUS_WORDS).toEqual({
      draft: "Not sent",
      submitted: "Waiting on the office",
      approved: "Approved",
      rejected: "Fix needed",
    });
  });

  it("covers every legal status (no status can render wordless)", () => {
    for (const status of TIME_ENTRY_STATUSES) {
      expect(statusWord(status)).toBeTruthy();
      expect(STATUS_CELL_WORDS[status]).toBeTruthy();
    }
  });

  it("statusPhrase lowers only the leading letter for mid-sentence use", () => {
    expect(statusPhrase("submitted")).toBe("waiting on the office");
    expect(statusPhrase("approved")).toBe("approved");
    expect(statusPhrase("draft")).toBe("not sent");
    expect(statusPhrase("rejected")).toBe("fix needed");
  });

  it("cell words stay short enough for a 1-of-7 strip cell (12px floor)", () => {
    for (const status of TIME_ENTRY_STATUSES) {
      expect(STATUS_CELL_WORDS[status].length).toBeLessThanOrEqual(8);
    }
  });

  it("never uses bureaucratic words (site language, P11)", () => {
    const all = Object.values(STATUS_WORDS).join(" ").toLowerCase();
    for (const banned of ["pending", "processing", "authorised", "authorized", "timesheet"]) {
      expect(all).not.toContain(banned);
    }
  });
});
