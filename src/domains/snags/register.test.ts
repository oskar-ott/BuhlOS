import { describe, expect, it } from "vitest";
import {
  compareRegisterSnags,
  filterRegisterSnags,
  isRegisterSnagClosable,
  legacyPriorityToRegister,
  legacyStatusToRegister,
  normaliseLegacySnag,
  normaliseV2Snag,
  parseRegisterPriorityParam,
  parseRegisterStatusParam,
  registerActiveCount,
  registerEmptyStateMessage,
  registerStatusCounts,
  REGISTER_DEFAULT_STATUSES,
  type RegisterJobContext,
  type RegisterSnag,
} from "./register";
import { statusLabel } from "./format";

/**
 * #414 — the pure legacy+v2 → register-shape contract. These functions
 * are ALSO the oracle the snags-all API-harness test compares the real
 * handler against, so the assertions here define the wire shape.
 */

const CTX: RegisterJobContext = {
  jobId: "job-1",
  jobName: "Birdwood",
  jobStatus: "active",
  areaNameById: { d1: "Unit 1" },
};

describe("legacy → register mapping", () => {
  it("maps the full legacy store shape (the pre-cutover writers' fields)", () => {
    const item = normaliseLegacySnag(
      {
        id: "lg_1",
        desc: "Cracked switch plate in laundry",
        priority: "High",
        status: "Open",
        dwelling: "d1",
        by: "phil",
        createdAt: "2026-01-02T00:00:00.000Z",
        photos: [{ url: "a" }, { url: "b" }],
        assignedToName: "Macca",
      },
      CTX
    );
    expect(item).toEqual({
      id: "lg_1",
      source: "legacy",
      jobId: "job-1",
      jobName: "Birdwood",
      jobStatus: "active",
      title: "Cracked switch plate in laundry",
      status: "open",
      priority: "high",
      areaName: "Unit 1",
      assignedToName: "Macca",
      createdAt: "2026-01-02T00:00:00.000Z",
      evidenceCount: 2,
    });
  });

  it("maps a minimal/defaulted legacy row (missing fields predate every schema)", () => {
    const item = normaliseLegacySnag({ id: "lg_2", desc: "x" }, CTX);
    expect(item.status).toBe("open"); // legacy default
    expect(item.priority).toBe("normal"); // Medium was the legacy default
    expect(item.areaName).toBeNull();
    expect(item.assignedToName).toBeNull();
    expect(item.createdAt).toBe("");
    expect(item.evidenceCount).toBe(0);
  });

  it("Open→open, Closed→closed — and nothing else exists in the legacy vocabulary", () => {
    expect(legacyStatusToRegister("Open")).toBe("open");
    expect(legacyStatusToRegister("Closed")).toBe("closed");
    expect(legacyStatusToRegister(undefined)).toBe("open");
    expect(legacyStatusToRegister("Bananas")).toBe("open");
  });

  it("High→high, Medium→normal, Low→low", () => {
    expect(legacyPriorityToRegister("High")).toBe("high");
    expect(legacyPriorityToRegister("Medium")).toBe("normal");
    expect(legacyPriorityToRegister("Low")).toBe("low");
    expect(legacyPriorityToRegister(undefined)).toBe("normal");
  });

  it("falls back to the raw dwelling id when areaGroups can't resolve it (pre-#414 behaviour)", () => {
    const item = normaliseLegacySnag({ id: "lg_3", desc: "x", dwelling: "ghost" }, CTX);
    expect(item.areaName).toBe("ghost");
  });

  it("legacy `date` backs up a missing createdAt", () => {
    const item = normaliseLegacySnag({ id: "lg_4", desc: "x", date: "2025-12-01" }, CTX);
    expect(item.createdAt).toBe("2025-12-01");
  });
});

describe("v2 → register mapping", () => {
  it("maps the snagsV2 store shape written by api/snags.js", () => {
    const item = normaliseV2Snag(
      {
        id: "sn_1",
        title: "GPO hanging off wall",
        status: "in_progress",
        priority: "urgent",
        areaName: "Kitchen",
        assignedToName: "Sparky",
        createdAt: "2026-02-03T00:00:00.000Z",
        evidenceIds: ["ev_1", "ev_2", "ev_3"],
      },
      CTX
    );
    expect(item).toEqual({
      id: "sn_1",
      source: "v2",
      jobId: "job-1",
      jobName: "Birdwood",
      jobStatus: "active",
      title: "GPO hanging off wall",
      status: "in_progress",
      priority: "urgent",
      areaName: "Kitchen",
      assignedToName: "Sparky",
      createdAt: "2026-02-03T00:00:00.000Z",
      evidenceCount: 3,
    });
  });

  it("tolerates hand-edited blobs: unknown status/priority fall back to store defaults", () => {
    const item = normaliseV2Snag({ id: "sn_2", title: "x", status: "weird", priority: "??" }, CTX);
    expect(item.status).toBe("open");
    expect(item.priority).toBe("normal");
  });
});

describe("default statuses + sort", () => {
  it("the default set is exactly the domain's isActive() statuses — never hand-listed", () => {
    expect(REGISTER_DEFAULT_STATUSES).toEqual(["open", "in_progress", "resolved"]);
  });

  function snag(over: Partial<RegisterSnag>): RegisterSnag {
    return {
      id: "s",
      source: "v2",
      jobId: "j",
      jobName: "J",
      jobStatus: "active",
      title: "t",
      status: "open",
      priority: "normal",
      areaName: null,
      assignedToName: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      evidenceCount: 0,
      ...over,
    };
  }

  it("sorts active-first, then urgent→low, then OLDEST first, then id", () => {
    const rows = [
      snag({ id: "e", status: "closed", priority: "urgent" }),
      snag({ id: "d", status: "open", priority: "low" }),
      snag({ id: "c", status: "resolved", priority: "high", createdAt: "2026-01-05" }),
      snag({ id: "b", status: "open", priority: "high", createdAt: "2026-01-01" }),
      snag({ id: "a", status: "in_progress", priority: "urgent" }),
    ];
    const order = rows.slice().sort(compareRegisterSnags).map((r) => r.id);
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("ties on everything sort stably by id", () => {
    const rows = [snag({ id: "z" }), snag({ id: "a" })];
    expect(rows.sort(compareRegisterSnags).map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("counts: per-status map + the Active pill total", () => {
    const rows = [
      snag({ status: "open" }),
      snag({ status: "open" }),
      snag({ status: "resolved" }),
      snag({ status: "closed" }),
      snag({ status: "rejected" }),
    ];
    const counts = registerStatusCounts(rows);
    expect(counts.get("open")).toBe(2);
    expect(counts.get("closed")).toBe(1);
    expect(counts.get("verified")).toBeUndefined();
    expect(registerActiveCount(rows)).toBe(3); // open+open+resolved
  });

  it("filters: default hides done+rejected; 'all' keeps everything; status/priority/jobId narrow", () => {
    const rows = [
      snag({ id: "1", status: "open", priority: "high", jobId: "j1" }),
      snag({ id: "2", status: "verified", jobId: "j1" }),
      snag({ id: "3", status: "closed", jobId: "j2" }),
      snag({ id: "4", status: "rejected", jobId: "j2" }),
    ];
    const ids = (f: Parameters<typeof filterRegisterSnags>[1]) =>
      filterRegisterSnags(rows, f).map((r) => r.id);
    expect(ids({ status: null, priority: null, jobId: null })).toEqual(["1"]);
    expect(ids({ status: "all", priority: null, jobId: null })).toEqual(["1", "2", "3", "4"]);
    expect(ids({ status: "verified", priority: null, jobId: null })).toEqual(["2"]);
    expect(ids({ status: "all", priority: "high", jobId: null })).toEqual(["1"]);
    expect(ids({ status: "all", priority: null, jobId: "j2" })).toEqual(["3", "4"]);
  });

  it("closable = not closed and not rejected (one rule covers both stores)", () => {
    expect(isRegisterSnagClosable({ status: "open" })).toBe(true);
    expect(isRegisterSnagClosable({ status: "resolved" })).toBe(true);
    expect(isRegisterSnagClosable({ status: "verified" })).toBe(true);
    expect(isRegisterSnagClosable({ status: "closed" })).toBe(false);
    expect(isRegisterSnagClosable({ status: "rejected" })).toBe(false);
  });
});

describe("query-param parsing (?status= / ?priority=)", () => {
  it("status: v2 vocabulary + 'all'; case-insensitive so legacy Open/Closed still land", () => {
    expect(parseRegisterStatusParam("open")).toBe("open");
    expect(parseRegisterStatusParam("Open")).toBe("open"); // pre-#414 caller vocabulary
    expect(parseRegisterStatusParam("Closed")).toBe("closed");
    expect(parseRegisterStatusParam("in_progress")).toBe("in_progress");
    expect(parseRegisterStatusParam("all")).toBe("all");
    expect(parseRegisterStatusParam("bogus")).toBeNull();
    expect(parseRegisterStatusParam(null)).toBeNull();
  });

  it("priority: v2 vocabulary; legacy High/Medium/Low map in (Medium→normal)", () => {
    expect(parseRegisterPriorityParam("urgent")).toBe("urgent");
    expect(parseRegisterPriorityParam("High")).toBe("high");
    expect(parseRegisterPriorityParam("Medium")).toBe("normal");
    expect(parseRegisterPriorityParam("Low")).toBe("low");
    expect(parseRegisterPriorityParam("bogus")).toBeNull();
    expect(parseRegisterPriorityParam(null)).toBeNull();
  });
});

describe("empty-state copy is filter-aware (never a bare nothing-here)", () => {
  const opts = { statusLabelOf: statusLabel };
  it("default view", () => {
    expect(registerEmptyStateMessage({ status: null, priority: null, jobId: null }, opts)).toBe(
      "No active defects across your jobs."
    );
  });
  it("status + priority + job compose", () => {
    expect(
      registerEmptyStateMessage(
        { status: "rejected", priority: "urgent", jobId: "j1" },
        { ...opts, jobName: "Birdwood" }
      )
    ).toBe("No rejected defects with urgent priority on Birdwood.");
  });
  it("'all' with a job names the job", () => {
    expect(
      registerEmptyStateMessage({ status: "all", priority: null, jobId: "j9" }, opts)
    ).toBe("No defects on that job.");
  });
});
