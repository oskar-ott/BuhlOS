import { describe, it, expect } from "vitest";
import { hoursExceptions, jobExceptions } from "./mappers";
import {
  buildExceptions,
  decorateAges,
  deriveAgeLabel,
  filterExceptions,
  isActionable,
  isSafeActionHref,
  jobOptions,
  sortExceptions,
  summariseExceptions,
} from "./service";
import type { TimeEntry } from "@/domains/timesheets/types";
import type { Job } from "@/domains/jobs/types";
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

// ── hours ─────────────────────────────────────────────────────────────
describe("hoursExceptions", () => {
  it("maps submitted → waiting approval and rejected → needs correction", () => {
    const items = hoursExceptions(
      [te({ id: "t1", status: "submitted" })],
      [te({ id: "t2", status: "rejected", rejectedReason: "Wrong job", rejectedAt: "2026-06-02T00:00:00.000Z" })],
    );
    expect(items.map((i) => i.id)).toEqual(["hours-pending:t1", "hours-rejected:t2"]);
    expect(items[0]).toMatchObject({ source: "hours", severity: "warning", status: "waiting", actionHref: "/hours/approvals", actionState: "available", jobId: "job-1" });
    expect(items[1]).toMatchObject({ status: "blocked" });
    expect(items[1]!.summary).toContain("Wrong job");
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

// ── jobs ──────────────────────────────────────────────────────────────
describe("jobExceptions", () => {
  it("emits a pending-evidence item, an active-no-crew critical, and a draft info", () => {
    const items = jobExceptions([
      job({ id: "j1", name: "Alpha", status: "active", statsEvidenceV2Pending: 2, statsCrewCount: 4 }),
      job({ id: "j2", name: "Bravo", status: "active", statsCrewCount: 0 }),
      job({ id: "j3", name: "Charlie", status: "draft", statsEvidenceV2Pending: 5 }),
      job({ id: "j4", name: "Old", status: "archived", statsEvidenceV2Pending: 9 }),
    ]);
    const ids = items.map((i) => i.id);
    expect(ids).toContain("evidence-job:j1");
    expect(ids).toContain("job-no-crew:j2");
    expect(ids).toContain("job-draft:j3");
    // archived job never surfaces, draft job has no field-work queues
    expect(ids).not.toContain("evidence-job:j4");
    expect(ids).not.toContain("evidence-job:j3");
    // no-crew deep-links to the assignment section anchor; draft to the publish tab
    expect(items.find((i) => i.id === "job-no-crew:j2")).toMatchObject({
      severity: "critical",
      actionHref: "/v2/jobs/j2/builder#assigned-field-workers",
      actionLabel: "Assign field workers",
    });
    expect(items.find((i) => i.id === "job-draft:j3")).toMatchObject({
      severity: "info",
      actionHref: "/v2/jobs/j3/builder#publish",
      actionLabel: "Publish job",
    });
  });

  it("encodes dynamic job route segments BEFORE the anchor (jobId '#' → %23, only the literal anchor '#' remains)", () => {
    const items = jobExceptions([
      job({ id: "j/1#frag", name: "Odd id", status: "active", statsCrewCount: 0 }),
    ]);
    expect(items[0]!.actionHref).toBe("/v2/jobs/j%2F1%23frag/builder#assigned-field-workers");
    expect(isSafeActionHref(items[0]!.actionHref)).toBe(true);
  });

  it("encodes dynamic job route segments in a per-job section href", () => {
    const item = jobExceptions([
      job({ id: "job/1?bad=true", name: "Odd id", status: "active", statsEvidenceV2Pending: 1, statsCrewCount: 2 }),
    ])[0];
    expect(item!.actionHref).toBe("/v2/jobs/job%2F1%3Fbad%3Dtrue/evidence");
    expect(isSafeActionHref(item!.actionHref)).toBe(true);
  });
});

// ── aggregation / sort / filters ──────────────────────────────────────
const SOURCES: ExceptionSources = {
  hoursPending: [te({ id: "t1", status: "submitted", submittedAt: "2026-06-03T00:00:00.000Z" })],
  hoursRejected: [],
  jobs: [
    job({ id: "j1", name: "Alpha", status: "active", statsEvidenceV2Pending: 2, statsCrewCount: 3 }), // evidence, warning
    job({ id: "j2", name: "Bravo", status: "active", statsCrewCount: 0 }), // critical
    job({ id: "j3", name: "Charlie", status: "draft" }), // info
  ],
};

describe("buildExceptions", () => {
  const items = buildExceptions(SOURCES);

  it("aggregates all sources", () => {
    expect(items.length).toBe(4);
    expect(new Set(items.map((i) => i.source))).toEqual(new Set(["hours", "evidence", "job"]));
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

  it("produces unique ids, all `available`, with only safe internal action hrefs", () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    for (const it of items) {
      // Every Phase-1 source links to a real registered route → available.
      expect(it.actionState).toBe("available");
      expect(isSafeActionHref(it.actionHref)).toBe(true);
    }
  });

  it("is order-independent (same multiset of ids regardless of source order)", () => {
    const shuffled = buildExceptions({
      ...SOURCES,
      jobs: [...SOURCES.jobs].reverse(),
    });
    expect(shuffled.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
  });

  it("returns an empty list for empty sources", () => {
    expect(buildExceptions({ hoursPending: [], hoursRejected: [], jobs: [] })).toEqual([]);
  });

  it("decorates every item with its human sourceLabel", () => {
    expect(items.find((i) => i.id === "evidence-job:j1")!.sourceLabel).toBe("Evidence");
    expect(items.find((i) => i.id === "hours-pending:t1")!.sourceLabel).toBe("Hours");
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
    expect(s.total).toBe(4);
    expect(s.bySeverity.critical).toBe(1); // the no-crew job
    expect(s.bySource.hours).toBe(1);
  });

  it("lists distinct jobs for the filter, sorted by name", () => {
    expect(jobOptions(items).map((o) => o.jobId)).toEqual(["j1", "j2", "j3", "job-1"]); // Alpha, Bravo, Charlie, then the un-named hours job
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

describe("filterExceptions — availability + text query", () => {
  const items = buildExceptions(SOURCES);

  it("filters to actionable (available/fallback) vs waiting (unavailable/future)", () => {
    // All Phase-1 sources are available, so 'actionable' keeps all, 'waiting' none.
    expect(filterExceptions(items, { availability: "actionable" })).toHaveLength(items.length);
    expect(filterExceptions(items, { availability: "waiting" })).toHaveLength(0);
  });

  it("filters by free-text against title / summary / jobName", () => {
    const bravo = filterExceptions(items, { query: "bravo" });
    expect(bravo.length).toBeGreaterThan(0);
    expect(bravo.every((i) => `${i.title} ${i.summary ?? ""} ${i.jobName ?? ""}`.toLowerCase().includes("bravo"))).toBe(true);
    expect(filterExceptions(items, { query: "zzz-nope" })).toHaveLength(0);
  });
});

describe("sort — explainable & deterministic", () => {
  it("orders actionable before waiting within the same severity", () => {
    const sorted = sortExceptions([
      { id: "w", source: "gear", sourceId: "w", title: "waiting", severity: "warning", actionState: "unavailable" },
      { id: "a", source: "hours", sourceId: "a", title: "actionable", severity: "warning", actionState: "available", actionHref: "/hours/approvals" },
    ] as never);
    expect(sorted.map((i) => i.id)).toEqual(["a", "w"]);
  });

  it("isActionable is true for available + fallback, false otherwise", () => {
    expect(isActionable({ actionState: "available", actionHref: "/x" } as never)).toBe(true);
    expect(isActionable({ actionState: "fallback", actionHref: "/x" } as never)).toBe(true);
    expect(isActionable({ actionState: "unavailable", actionHref: undefined } as never)).toBe(false);
    expect(isActionable({ actionState: "future", actionHref: "/x" } as never)).toBe(false);
  });
});

describe("age labels", () => {
  const now = Date.parse("2026-06-04T12:00:00.000Z");
  it("derives relative age buckets", () => {
    expect(deriveAgeLabel("2026-06-04T11:59:30.000Z", now)).toBe("just now");
    expect(deriveAgeLabel("2026-06-04T11:30:00.000Z", now)).toBe("30m ago");
    expect(deriveAgeLabel("2026-06-04T09:00:00.000Z", now)).toBe("3h ago");
    expect(deriveAgeLabel("2026-06-01T12:00:00.000Z", now)).toBe("3d ago");
    expect(deriveAgeLabel(undefined, now)).toBeUndefined();
    expect(deriveAgeLabel("not-a-date", now)).toBeUndefined();
  });

  it("decorateAges adds ageLabel without re-sorting", () => {
    const items = buildExceptions(SOURCES);
    const decorated = decorateAges(items, now);
    expect(decorated.map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(decorated.some((i) => i.ageLabel)).toBe(true);
  });
});
