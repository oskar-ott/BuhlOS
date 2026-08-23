import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * api/_lib/worker-names.js — the ONE worker-label resolver shared by the hours
 * boards (api/time-entries-overview.js, #1020) and the per-job Labour card
 * (api/job-hours.js, #1027). Pins the order: register "First Last" → live
 * users.json name → stored snapshot → username → id — and that the register's
 * displayName (a nickname) is never used.
 */
const requireFromHere = createRequire(import.meta.url);
const { buildWorkerLabeller } = requireFromHere("../../../api/_lib/worker-names.js") as {
  buildWorkerLabeller: (refs: {
    users?: Array<{ id: string; name?: string; username?: string }>;
    employees?: Array<{ userId?: string; firstName?: string; lastName?: string; displayName?: string }>;
  }) => (userId: string, stored?: string | null) => string;
};

describe("buildWorkerLabeller", () => {
  const labelFor = buildWorkerLabeller({
    users: [
      { id: "u1", name: "Jonathan Borg", username: "jb@example.com" },
      { id: "u2", name: "Craig Rafferty", username: "craig@example.com" },
      { id: "u3", username: "anders@example.com" },
    ],
    employees: [
      { userId: "u1", firstName: "Jonathan", lastName: "Borg", displayName: "Mr Borg" },
      { userId: "u4", firstName: "Louis", displayName: "Louie" },
    ],
  });

  it("register 'First Last' wins and its nickname displayName is ignored", () => {
    expect(labelFor("u1", "Mr Borg")).toBe("Jonathan Borg");
    expect(labelFor("u4", "Louie")).toBe("Louis");
  });

  it("falls to the live users.json full name over a stored snapshot", () => {
    expect(labelFor("u2", "Craigo")).toBe("Craig Rafferty");
  });

  it("keeps the stored snapshot when no live name exists, then username, then id", () => {
    expect(labelFor("u3", "Anders")).toBe("Anders");
    expect(labelFor("u3", null)).toBe("anders@example.com");
    expect(labelFor("u_gone", null)).toBe("u_gone");
    expect(labelFor("u_gone", "Snapshot")).toBe("Snapshot");
  });

  it("tolerates missing reference data", () => {
    expect(buildWorkerLabeller({})("u9", "Nine")).toBe("Nine");
  });
});
