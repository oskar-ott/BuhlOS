import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The feed reads filters live from the URL; mock next/navigation for SSR.
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/activity",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { CrossJobActivityFeed } from "./CrossJobActivityFeed";
import type { AuditLogEntry } from "@/domains/audit-log/types";

/**
 * #220 — the cross-job activity feed: day-grouped, job-labelled rows, honest
 * empty state. The endpoint bounds + filters are pinned by audit-log-api.test;
 * this pins the day grouping + the shared ActivityRow with a job label.
 */
const entry = (over: Partial<AuditLogEntry>): AuditLogEntry =>
  ({
    id: "e1", ts: "2026-06-20T10:00:00.000Z", action: "snag.created",
    actorId: "u1", actorName: "Sparky", actorRole: "electrician",
    jobId: "job-1", targetType: "snag", targetId: "sn_1", summary: "raised a snag",
    ...over,
  }) as AuditLogEntry;

describe("CrossJobActivityFeed", () => {
  const NAMES = { "job-1": "100 Arthur", "job-2": "Birdwood IV" };

  it("renders entries grouped by day with the job label and the action", () => {
    const html = renderToString(
      createElement(CrossJobActivityFeed, {
        entries: [
          entry({ id: "a", ts: "2026-06-20T11:00:00Z", jobId: "job-1" }),
          entry({ id: "b", ts: "2026-06-19T09:00:00Z", jobId: "job-2", action: "evidence.captured", targetType: "evidence" }),
        ],
        jobNameById: NAMES,
        fetchError: null,
      })
    );
    expect(html).toContain("Activity across all jobs");
    expect(html).toContain("100 Arthur"); // job label on the row
    expect(html).toContain("Birdwood IV");
    expect(html).toContain("2026-06-20"); // day group heading
    expect(html).toContain("2026-06-19");
    expect(html).toContain("Raised snag"); // actionLabel via shared ActivityRow
  });

  it("shows an honest empty state when there's nothing", () => {
    const html = renderToString(
      createElement(CrossJobActivityFeed, { entries: [], jobNameById: {}, fetchError: null })
    );
    expect(html).toContain("No activity in this window");
  });
});
