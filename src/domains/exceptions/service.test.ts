import { describe, it, expect } from "vitest";
import {
  hoursExceptions,
  jobExceptions,
  materialExceptions,
  observationExceptions,
} from "./mappers";
import {
  buildExceptions,
  filterExceptions,
  isSafeActionHref,
  jobOptions,
  summariseExceptions,
} from "./service";
import type { TimeEntry } from "@/domains/timesheets/types";
import type { Job } from "@/domains/jobs/types";
import type { ObservationItem } from "@/domains/observations/types";
import type { MaterialRequestItem } from "@/domains/material-requests/types";
import type { ExceptionSources } from "./types";

// ── fixtures ──────────────────────────────────────────────────────────
function te(over: Partial<TimeEntry> & { id: string }): TimeEntry {
  return {
    userId: "u1",
    userName: "Oskar",
    date: "2026-06-01",
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "submitted",
    submittedAt: "2026-06-01T08:00:00.000Z",
    allocations: [{ jobId: "job-1", hours: 8 }],
    createdAt: "2026-06-01T08:00:00.000Z",
    updatedAt: "2026-06-01T08:00:00.000Z",
    ...over,
  } as TimeEntry;
}
function job(over: Partial<Job> & { id: string; name: string }): Job {
  return { status: "active", ...over } as Job;
}
function obs(over: Partial<ObservationItem> & { id: string }): ObservationItem {
  return {
    jobId: "job-1",
    jobName: "Marriott St",
    type: "blocker",
    title: "Live mains exposed",
    status: "needs_action",
    priority: "high",
    source: "phil",
    requiresAction: true,
    photoUrls: [],
    createdById: "u1",
    createdByName: "Sparky",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  } as ObservationItem;
}
function mr(over: Partial<MaterialRequestItem> & { id: string }): MaterialRequestItem {
  return {
    jobId: "job-1",
    jobName: "Marriott St",
    item: "25mm conduit",
    status: "requested",
    urgency: "high",
    requestedByName: "Sparky",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...over,
  } as MaterialRequestItem;
}

// ── hours ─────────────────────────────────────────────────────────────
describe("hoursExceptions", () => {
  it("maps submitted → waiting approval and rejected → needs correction", () => {
    const items = hoursExceptions(
      [te({ id: "t1", status: "submitted" })],
      [te({ id: "t2", status: "rejected", rejectedReason: "Wrong job", rejectedAt: "2026-06-02T00:00:00.000Z" })],
    );
    expect(items.map((i) => i.id)).toEqual(["hours-pending:t1", "hours-rejected:t2"]);
    expect(items[0]).toMatchObject({ source: "hours", severity: "warning", status: "waiting", actionHref: "/hours/approvals", jobId: "job-1" });
    expect(items[1]).toMatchObject({ status: "blocked", summary: "Reason: Wrong job" });
  });

  it("ignores entries whose status does not match the queue", () => {
    expect(hoursExceptions([te({ id: "t1", status: "approved" })], [])).toEqual([]);
    expect(hoursExceptions([], [te({ id: "t2", status: "submitted" })])).toEqual([]);
  });

  it("leaves jobId undefined for a multi-job entry", () => {
    const item = hoursExceptions([te({ id: "t1", allocations: [{ jobId: "a", hours: 4 }, { jobId: "b", hours: 4 }] as TimeEntry["allocations"] })], [])[0];
    expect(item!.jobId).toBeUndefined();
  });
});

// ── observations ──────────────────────────────────────────────────────
describe("observationExceptions", () => {
  it("includes only open + requiresAction, mapping priority → severity", () => {
    const items = observationExceptions([
      obs({ id: "o1", priority: "urgent" }),
      obs({ id: "o2", requiresAction: false }), // not actionable
      obs({ id: "o3", status: "resolved" }), // closed
      obs({ id: "o4", priority: "low" }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["observation:o1", "observation:o4"]);
    expect(items[0]).toMatchObject({ severity: "critical", actionHref: "/v2/jobs/job-1/observations" });
    expect(items[1]!.severity).toBe("info");
  });

  it("falls back to the cross-job inbox when there is no jobId", () => {
    const item = observationExceptions([obs({ id: "o1", jobId: undefined as unknown as string })])[0];
    expect(item!.actionHref).toBe("/observations");
  });

  it("encodes dynamic job route segments in action hrefs", () => {
    const item = observationExceptions([obs({ id: "o1", jobId: "job/1?bad=true" })])[0];
    expect(item!.actionHref).toBe("/v2/jobs/job%2F1%3Fbad%3Dtrue/observations");
    expect(isSafeActionHref(item!.actionHref)).toBe(true);
  });
});

// ── jobs ──────────────────────────────────────────────────────────────
describe("jobExceptions", () => {
  it("emits per-stat items, an active-no-crew critical, and a draft info", () => {
    const items = jobExceptions([
      job({ id: "j1", name: "Alpha", status: "active", statsEvidenceV2Pending: 2, statsSnagsV2Active: 1, statsItpsNeedsReview: 3, statsCrewCount: 4 }),
      job({ id: "j2", name: "Bravo", status: "active", statsCrewCount: 0 }),
      job({ id: "j3", name: "Charlie", status: "draft" }),
      job({ id: "j4", name: "Old", status: "archived", statsSnagsV2Active: 9 }),
    ]);
    const ids = items.map((i) => i.id);
    expect(ids).toContain("evidence-job:j1");
    expect(ids).toContain("snag-job:j1");
    expect(ids).toContain("itp-job:j1");
    expect(ids).toContain("job-no-crew:j2");
    expect(ids).toContain("job-draft:j3");
    // archived job never surfaces, draft job has no field-work queues
    expect(ids).not.toContain("snag-job:j4");
    expect(items.find((i) => i.id === "job-no-crew:j2")).toMatchObject({ severity: "critical", actionHref: "/v2/jobs/j2/builder", actionLabel: "Assign workers" });
    expect(items.find((i) => i.id === "job-draft:j3")!.severity).toBe("info");
  });

  it("encodes dynamic job route segments for job-derived action hrefs", () => {
    const items = jobExceptions([
      job({ id: "j/1#frag", name: "Odd id", status: "active", statsCrewCount: 0 }),
    ]);
    expect(items[0]!.actionHref).toBe("/v2/jobs/j%2F1%23frag/builder");
    expect(isSafeActionHref(items[0]!.actionHref)).toBe(true);
  });
});

// ── material ──────────────────────────────────────────────────────────
describe("materialExceptions", () => {
  it("includes only open requests, mapping urgency → severity", () => {
    const items = materialExceptions([
      mr({ id: "m1", status: "requested", urgency: "urgent" }),
      mr({ id: "m2", status: "ordered" }), // not open
      mr({ id: "m3", status: "approved", urgency: "low" }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["material:m1", "material:m3"]);
    expect(items[0]!.severity).toBe("critical");
    expect(items[1]).toMatchObject({ severity: "info", status: "waiting" });
  });
});

// ── aggregation / sort / filters ──────────────────────────────────────
const SOURCES: ExceptionSources = {
  hoursPending: [te({ id: "t1", status: "submitted", submittedAt: "2026-06-03T00:00:00.000Z" })],
  hoursRejected: [],
  jobs: [
    job({ id: "j2", name: "Bravo", status: "active", statsCrewCount: 0 }), // critical
    job({ id: "j3", name: "Charlie", status: "draft" }), // info
  ],
  observations: [obs({ id: "o1", priority: "high", createdAt: "2026-06-01T00:00:00.000Z" })],
  materialRequests: [mr({ id: "m1", status: "requested", urgency: "urgent" })], // critical
};

describe("buildExceptions", () => {
  const items = buildExceptions(SOURCES);

  it("aggregates all sources", () => {
    expect(items.length).toBe(5);
  });

  it("sorts critical first, then warning, then info (deterministic)", () => {
    const sev = items.map((i) => i.severity);
    const order = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < sev.length; i++) {
      expect(order[sev[i]!]).toBeGreaterThanOrEqual(order[sev[i - 1]!]);
    }
    // last item is the draft (info)
    expect(items[items.length - 1]!.id).toBe("job-draft:j3");
  });

  it("produces unique ids and only safe internal action hrefs", () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    for (const it of items) expect(isSafeActionHref(it.actionHref)).toBe(true);
  });

  it("is order-independent (same multiset of ids regardless of source order)", () => {
    const shuffled = buildExceptions({
      ...SOURCES,
      jobs: [...SOURCES.jobs].reverse(),
    });
    expect(shuffled.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
  });

  it("returns an empty list for empty sources", () => {
    expect(buildExceptions({ hoursPending: [], hoursRejected: [], jobs: [], observations: [], materialRequests: [] })).toEqual([]);
  });
});

describe("filterExceptions + summary + jobOptions", () => {
  const items = buildExceptions(SOURCES);

  it("filters by source, severity and job", () => {
    expect(filterExceptions(items, { source: "hours" }).every((i) => i.source === "hours")).toBe(true);
    expect(filterExceptions(items, { severity: "critical" }).every((i) => i.severity === "critical")).toBe(true);
    expect(filterExceptions(items, { jobId: "j2" }).every((i) => i.jobId === "j2")).toBe(true);
    expect(filterExceptions(items, { source: "all", severity: "all", jobId: "all" })).toHaveLength(items.length);
  });

  it("summarises counts by severity and source", () => {
    const s = summariseExceptions(items);
    expect(s.total).toBe(5);
    expect(s.bySeverity.critical).toBe(2); // no-crew job + urgent material
    expect(s.bySource.hours).toBe(1);
  });

  it("lists distinct jobs for the filter, sorted by name", () => {
    expect(jobOptions(items).map((o) => o.jobId)).toEqual(["j2", "j3", "job-1"]); // Bravo, Charlie, Marriott St
  });
});

describe("isSafeActionHref", () => {
  it("accepts canonical internal paths, rejects external / protocol-relative", () => {
    expect(isSafeActionHref("/hours/approvals")).toBe(true);
    expect(isSafeActionHref("//evil.example")).toBe(false);
    expect(isSafeActionHref("https://evil.example")).toBe(false);
    expect(isSafeActionHref(undefined)).toBe(false);
  });
});
