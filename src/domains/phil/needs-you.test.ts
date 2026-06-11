import { describe, expect, it } from "vitest";
import { buildPhilNeedsYou } from "./needs-you";
import type { TimeEntry } from "@/domains/timesheets/types";
import type { SnagItem } from "@/domains/snags/types";

const ME = "user-me";

function entry(p: Partial<TimeEntry>): TimeEntry {
  return {
    id: "e1",
    date: "2024-05-23",
    totalHours: 7.6,
    status: "submitted",
    rejectedReason: null,
    ...p,
  } as unknown as TimeEntry;
}
function snag(p: Partial<SnagItem>): SnagItem {
  return {
    id: "s1",
    title: "Conduit penetration unsealed",
    status: "open",
    priority: "normal",
    assignedToId: ME,
    areaName: "Riser 2",
    ...p,
  } as unknown as SnagItem;
}

describe("buildPhilNeedsYou", () => {
  it("returns NO items (never a fabricated row) when nothing is real", () => {
    expect(buildPhilNeedsYou({ viewerId: ME, entries: [], jobSnags: [] })).toEqual([]);

    // submitted/approved hours and not-mine / done snags must not appear
    const items = buildPhilNeedsYou({
      viewerId: ME,
      entries: [entry({ status: "submitted" }), entry({ id: "e2", status: "approved" })],
      jobSnags: [
        {
          jobId: "j1",
          jobName: "100 Arthur",
          snags: [
            snag({ id: "s-other", assignedToId: "someone-else" }),
            snag({ id: "s-closed", status: "closed" }),
            snag({ id: "s-resolved", status: "resolved" }),
            snag({ id: "s-verified", status: "verified" }),
          ],
        },
      ],
    });
    expect(items).toEqual([]);
  });

  it("surfaces a rejected-hours item routed to the real /phil/hours fix flow", () => {
    const items = buildPhilNeedsYou({
      viewerId: ME,
      entries: [
        entry({ id: "e9", status: "rejected", rejectedReason: "Stage doesn't match roster", date: "2024-05-22" }),
      ],
      jobSnags: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "rejected-hours",
      severity: "urgent",
      href: "/phil/hours",
      actionLabel: "Fix hours",
      detail: "Stage doesn't match roster",
    });
    expect(items[0]!.title).toContain("need a fix");
  });

  it("surfaces only snags ASSIGNED TO ME that are open/in-progress, routed to the job", () => {
    const items = buildPhilNeedsYou({
      viewerId: ME,
      entries: [],
      jobSnags: [
        {
          jobId: "job-1",
          jobName: "100 Arthur",
          snags: [
            snag({ id: "mine-open", title: "Pendant foul", status: "open", assignedToId: ME }),
            snag({ id: "mine-prog", title: "Riser seal", status: "in_progress", assignedToId: ME }),
            snag({ id: "not-mine", assignedToId: "other" }),
            snag({ id: "mine-done", status: "verified", assignedToId: ME }),
          ],
        },
      ],
    });
    expect(items.map((i) => i.id)).toEqual(["snag:mine-open", "snag:mine-prog"]);
    expect(items[0]).toMatchObject({
      kind: "snag",
      title: "Pendant foul",
      href: "/phil/jobs/job-1#phil-job-snags",
      actionLabel: "Open snag",
      detail: "100 Arthur",
    });
  });

  it("never attributes snags to a missing viewer", () => {
    const items = buildPhilNeedsYou({
      viewerId: null,
      entries: [],
      jobSnags: [{ jobId: "j", jobName: "X", snags: [snag({ assignedToId: ME })] }],
    });
    expect(items).toEqual([]);
  });

  it("sorts urgent (rejected hours) above snags, and marks high-priority snags as warning", () => {
    const items = buildPhilNeedsYou({
      viewerId: ME,
      entries: [entry({ id: "e", status: "rejected", rejectedReason: "x" })],
      jobSnags: [
        {
          jobId: "j",
          jobName: "X",
          snags: [
            snag({ id: "low", priority: "low", assignedToId: ME }),
            snag({ id: "high", priority: "high", assignedToId: ME }),
          ],
        },
      ],
    });
    expect(items[0]!.kind).toBe("rejected-hours");
    expect(items.find((i) => i.id === "snag:high")!.severity).toBe("warning");
    expect(items.find((i) => i.id === "snag:low")!.severity).toBe("normal");
    // every item has a real, non-empty href
    expect(items.every((i) => i.href.startsWith("/phil/"))).toBe(true);
  });
});
