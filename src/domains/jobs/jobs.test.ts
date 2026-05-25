import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JOB_STATUSES,
  JobSchema,
  JobListResponseSchema,
  JobDetailResponseSchema,
} from "./schema";
import {
  effectiveTasks,
  hasSiteContext,
  lastActivityCaption,
  pickWhen,
  relativeWhen,
  stageLabel,
  statusLabel,
  statusTone,
  visibleAreaGroups,
  whenCaption,
} from "./format";
import { getJobDetail, listJobs } from "./client";
import type { Job } from "./types";

/* ----------------------------------------------------------------------
 * Schema
 * -------------------------------------------------------------------- */

const minimalJob: Job = {
  id: "birdwood-iv3232",
  name: "Birdwood IV3232",
};

const richJob: Job = {
  id: "birdwood-iv3232",
  name: "Birdwood IV3232",
  status: "active",
  ref: "BW-3232",
  type: "renovation",
  typeName: "Renovation",
  siteAddress: "12 Birdwood St, Sydney NSW",
  siteContactName: "Jane Doe",
  siteContactPhone: "0400 000 000",
  accessNotes: "Key in lockbox 4521.",
  parkingNotes: "Street parking only.",
  safetyNotes: "Live mains in switchboard cupboard.",
  inductionRequired: true,
  startDate: "2026-05-01",
  dueDate: "2026-07-30",
  programmedDurationDays: 60,
  areaGroups: [
    {
      id: "ag-1",
      name: "Ground floor",
      areas: [
        { id: "a-1", name: "Kitchen", spaceType: "Kitchen" },
        { id: "a-2", name: "Lounge", spaceType: "Lounge" },
        { id: "a-3", name: "Hallway", archived: true },
      ],
    },
    {
      id: "ag-2",
      name: "Old shed",
      archived: true,
      areas: [{ id: "a-9", name: "Shed", archived: true }],
    },
  ],
  roughInTasks: [
    { id: "rt-1", name: "Cable pull" },
    { id: "rt-2", name: "Switchboard rough" },
  ],
  fitOffTasks: [{ id: "ft-1", name: "Power points" }],
  modules: { areas: true, snags: true, photos: true },
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-22T08:30:00.000Z",
};

describe("JobSchema", () => {
  it("accepts a minimal job (id + name only)", () => {
    expect(JobSchema.safeParse(minimalJob).success).toBe(true);
  });

  it("accepts a rich legacy-shaped job", () => {
    expect(JobSchema.safeParse(richJob).success).toBe(true);
  });

  it("rejects when id is missing", () => {
    const { id, ...broken } = richJob;
    void id;
    expect(JobSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects when name is missing", () => {
    const { name, ...broken } = richJob;
    void name;
    expect(JobSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects unknown status values", () => {
    const broken = { ...richJob, status: "in-flight" };
    expect(JobSchema.safeParse(broken).success).toBe(false);
  });

  it("passes through unknown legacy admin-only fields", () => {
    const adminish = {
      ...richJob,
      contractValue: 125000,
      paidToDate: 50000,
      oldestClaimDays: 4,
    };
    const parsed = JobSchema.safeParse(adminish);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // .passthrough() keeps the field on the parsed shape.
      expect((parsed.data as { contractValue?: number }).contractValue).toBe(125000);
    }
  });

  it("JOB_STATUSES covers the documented enum", () => {
    expect(JOB_STATUSES).toEqual([
      "active",
      "complete",
      "archived",
      "on_hold",
      "draft",
    ]);
  });
});

describe("response schemas", () => {
  it("parses an empty list", () => {
    const r = JobListResponseSchema.safeParse({ jobs: [] });
    expect(r.success).toBe(true);
  });

  it("parses a list of one rich job", () => {
    const r = JobListResponseSchema.safeParse({ jobs: [richJob] });
    expect(r.success).toBe(true);
  });

  it("parses a single-job response", () => {
    const r = JobDetailResponseSchema.safeParse({ job: richJob });
    expect(r.success).toBe(true);
  });

  it("rejects a single-job response without job key", () => {
    const r = JobDetailResponseSchema.safeParse({ jobs: [richJob] });
    expect(r.success).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Format helpers
 * -------------------------------------------------------------------- */

describe("statusLabel", () => {
  it("falls back to Active when status is missing", () => {
    expect(statusLabel(undefined)).toBe("Active");
  });

  it("renders each documented status label", () => {
    expect(statusLabel("active")).toBe("Active");
    expect(statusLabel("on_hold")).toBe("On hold");
    expect(statusLabel("complete")).toBe("Complete");
    expect(statusLabel("archived")).toBe("Archived");
    expect(statusLabel("draft")).toBe("Draft");
  });
});

describe("statusTone (doc 27 §6.1)", () => {
  it("active and complete are success", () => {
    expect(statusTone("active")).toBe("success");
    expect(statusTone("complete")).toBe("success");
  });

  it("on_hold is warning", () => {
    expect(statusTone("on_hold")).toBe("warning");
  });

  it("archived and draft are neutral", () => {
    expect(statusTone("archived")).toBe("neutral");
    expect(statusTone("draft")).toBe("neutral");
  });

  it("missing status falls back to success (active default)", () => {
    expect(statusTone(undefined)).toBe("success");
  });
});

describe("stageLabel", () => {
  it("renders Rough-in and Fit-off", () => {
    expect(stageLabel("roughIn")).toBe("Rough-in");
    expect(stageLabel("fitOff")).toBe("Fit-off");
  });
});

describe("pickWhen", () => {
  it("prefers updatedAt over createdAt", () => {
    const r = pickWhen({
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
    });
    expect(r).toEqual({ iso: "2026-05-22T00:00:00.000Z", label: "Updated" });
  });

  it("falls back to createdAt when updatedAt is absent", () => {
    const r = pickWhen({ createdAt: "2026-05-01T00:00:00.000Z" });
    expect(r).toEqual({ iso: "2026-05-01T00:00:00.000Z", label: "Created" });
  });

  it("returns null when neither timestamp is set", () => {
    expect(pickWhen({})).toBeNull();
  });
});

describe("relativeWhen", () => {
  const now = new Date("2026-05-24T12:00:00.000Z");

  it("renders just now for sub-minute diffs", () => {
    expect(relativeWhen("2026-05-24T11:59:40.000Z", now)).toBe("just now");
  });

  it("renders minutes ago", () => {
    expect(relativeWhen("2026-05-24T11:30:00.000Z", now)).toBe("30m ago");
  });

  it("renders hours ago", () => {
    expect(relativeWhen("2026-05-24T08:00:00.000Z", now)).toBe("4h ago");
  });

  it("renders days ago", () => {
    expect(relativeWhen("2026-05-21T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("falls back to month + year for old timestamps", () => {
    // ~ 3 months in the past — should drop into the localised month label.
    const result = relativeWhen("2026-02-01T12:00:00.000Z", now);
    expect(result).toMatch(/Feb 2026/);
  });

  it("treats future timestamps as just now (clock skew defence)", () => {
    expect(relativeWhen("2026-05-24T12:05:00.000Z", now)).toBe("just now");
  });

  it("returns an empty string for an unparseable input", () => {
    expect(relativeWhen("not-a-date", now)).toBe("");
  });
});

describe("whenCaption", () => {
  const now = new Date("2026-05-24T12:00:00.000Z");

  it("composes 'Updated 3d ago' from updatedAt", () => {
    expect(
      whenCaption(
        { createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-21T12:00:00.000Z" },
        now
      )
    ).toBe("Updated 3d ago");
  });

  it("falls back to 'Created Xd ago' when only createdAt is set", () => {
    expect(whenCaption({ createdAt: "2026-05-21T12:00:00.000Z" }, now)).toBe(
      "Created 3d ago"
    );
  });

  it("returns null when nothing is known", () => {
    expect(whenCaption({}, now)).toBeNull();
  });
});

describe("lastActivityCaption (doc 31 §4.1)", () => {
  const now = new Date("2026-05-24T12:00:00.000Z");

  it("returns 'Updated Nd ago' when updatedAt is present", () => {
    expect(
      lastActivityCaption(
        { createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-21T12:00:00.000Z" },
        now
      )
    ).toBe("Updated 3d ago");
  });

  it("suppresses the 'Created' fallback so a worker doesn't read it as last-activity", () => {
    expect(
      lastActivityCaption({ createdAt: "2026-05-21T12:00:00.000Z" }, now)
    ).toBeNull();
  });

  it("returns null when nothing is known", () => {
    expect(lastActivityCaption({}, now)).toBeNull();
  });
});

describe("hasSiteContext", () => {
  it("is true when any site field is set", () => {
    expect(hasSiteContext({ siteAddress: "1 Park St" })).toBe(true);
    expect(hasSiteContext({ accessNotes: "Lockbox" })).toBe(true);
    expect(hasSiteContext({ inductionRequired: true })).toBe(true);
  });

  it("is false when every site field is null/undefined", () => {
    expect(
      hasSiteContext({
        siteAddress: null,
        accessNotes: null,
        parkingNotes: null,
        safetyNotes: null,
        inductionRequired: false,
        siteContactName: null,
        siteContactPhone: null,
      })
    ).toBe(false);
  });
});

describe("visibleAreaGroups", () => {
  it("hides archived groups", () => {
    const result = visibleAreaGroups(richJob.areaGroups);
    expect(result.map((g) => g.id)).toEqual(["ag-1"]);
  });

  it("hides archived areas inside a visible group", () => {
    const result = visibleAreaGroups(richJob.areaGroups);
    expect(result[0]?.areas?.map((a) => a.id)).toEqual(["a-1", "a-2"]);
  });

  it("returns an empty array when input is undefined", () => {
    expect(visibleAreaGroups(undefined)).toEqual([]);
  });
});

describe("effectiveTasks", () => {
  const jobWithTemplate: Pick<Job, "roughInTasks" | "fitOffTasks"> = {
    roughInTasks: [
      { id: "rt-1", name: "Cable pull" },
      { id: "rt-2", name: "Switchboard rough", archived: true },
      { id: "rt-3", name: "Backboxes" },
    ],
    fitOffTasks: [{ id: "ft-1", name: "Power points" }],
  };

  it("returns job-level rough-in template when area has no override", () => {
    const result = effectiveTasks(jobWithTemplate, { roughInTasks: undefined }, "roughIn");
    expect(result.map((t) => t.id)).toEqual(["rt-1", "rt-3"]);
  });

  it("returns job-level fit-off template when area has no override", () => {
    const result = effectiveTasks(jobWithTemplate, { fitOffTasks: undefined }, "fitOff");
    expect(result.map((t) => t.id)).toEqual(["ft-1"]);
  });

  it("filters archived templates from the job-level list", () => {
    const result = effectiveTasks(jobWithTemplate, null, "roughIn");
    expect(result.map((t) => t.id)).not.toContain("rt-2");
  });

  it("uses the per-area override when it has tasks", () => {
    const result = effectiveTasks(
      jobWithTemplate,
      {
        roughInTasks: [
          { id: "ov-1", name: "Custom rough" },
          { id: "ov-2", name: "Custom rough 2" },
        ],
      },
      "roughIn"
    );
    expect(result.map((t) => t.id)).toEqual(["ov-1", "ov-2"]);
  });

  it("falls back to job-level when per-area override is an empty array", () => {
    const result = effectiveTasks(
      jobWithTemplate,
      { roughInTasks: [] },
      "roughIn"
    );
    expect(result.map((t) => t.id)).toEqual(["rt-1", "rt-3"]);
  });

  it("returns an empty list when neither override nor job-level template exists", () => {
    expect(
      effectiveTasks(
        { roughInTasks: undefined, fitOffTasks: undefined },
        null,
        "roughIn"
      )
    ).toEqual([]);
  });
});

/* ----------------------------------------------------------------------
 * Client (smoke — verifies URL + cache headers, not the full network path)
 * -------------------------------------------------------------------- */

describe("jobsClient", () => {
  const originalFetch = globalThis.fetch;
  // Capture the (url, init) pair each call as a typed tuple — vi.fn() infers
  // an empty params shape from the async () => Response factory, which
  // breaks fetchMock.mock.calls[0][1] under noUncheckedIndexedAccess.
  let fetchCalls: Array<[input: string, init?: RequestInit]>;

  function installFetch(response: () => Response): void {
    fetchCalls = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([String(input), init]);
      return Promise.resolve(response());
    }) as unknown as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("listJobs hits /api/jobs with no-store and parses an empty list", async () => {
    installFetch(() =>
      new Response(JSON.stringify({ jobs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const result = await listJobs();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.jobs).toEqual([]);
    }
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0]!;
    expect(url).toBe("/api/jobs");
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("same-origin");
  });

  it("getJobDetail URL-encodes the jobId", async () => {
    installFetch(() =>
      new Response(JSON.stringify({ job: minimalJob }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await getJobDetail("birdwood iv3232/special");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]![0]).toBe("/api/jobs?id=birdwood%20iv3232%2Fspecial");
  });

  it("getJobDetail surfaces a schema mismatch as ok: false", async () => {
    installFetch(() =>
      new Response(JSON.stringify({ wrongKey: "nope" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const result = await getJobDetail("any");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("response schema mismatch");
    }
  });

  it("listJobs propagates a 403 from the legacy API", async () => {
    installFetch(() =>
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    const result = await listJobs();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(403);
    }
  });
});
