import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobDiary } from "./JobDiary";
import type { DiaryEntry } from "@/domains/diary/types";

/**
 * Render tests for JobDiary (#210). Server-render only (no jsdom) — asserts the
 * integrity-relevant UI is present: entries render, gaps show "No diary entry"
 * (never fabricated), a delay reason is visible, attendance rows render, and an
 * amendment shows UNDER the original (original text stays). Archived → read-only.
 */

function entry(over: Partial<DiaryEntry> & { id: string; date: string }): DiaryEntry {
  return {
    jobId: "job-1",
    happenings: "Rough-in level 2",
    weatherNote: null,
    delay: { flagged: false, reason: null },
    attendance: [],
    attendanceSource: { fetchedAt: null, adjusted: false },
    amendments: [],
    createdById: "u_boss",
    createdByName: "Boss",
    createdByRole: "boss",
    createdAt: "2026-06-15T08:00:00.000Z",
    updatedAt: "2026-06-15T08:00:00.000Z",
    auditLogIds: [],
    ...over,
  } as DiaryEntry;
}

describe("JobDiary", () => {
  it("renders the empty state (gaps show 'No diary entry', never fabricated)", () => {
    const html = renderToString(
      createElement(JobDiary, {
        jobId: "job-1",
        jobName: "Birdwood IV",
        initialEntries: [],
        fetchError: null,
      }),
    );
    expect(html).toContain("Site diary");
    expect(html).toContain("Birdwood IV");
    expect(html).toContain("No diary entry");
    // The editor is present for a writable job.
    expect(html).toContain("Add today");
  });

  it("renders an entry with its happenings and attendance rows", () => {
    const html = renderToString(
      createElement(JobDiary, {
        jobId: "job-1",
        jobName: "Birdwood IV",
        initialEntries: [
          entry({
            id: "di_1",
            date: "2026-06-15",
            happenings: "Slab pour, east bay",
            attendance: [
              { userId: "u1", userName: "Sam", hours: 8, status: "approved" },
              { userId: "u2", userName: "Jo", hours: 6, status: "submitted" },
            ],
          }),
        ],
        fetchError: null,
      }),
    );
    expect(html).toContain("Slab pour, east bay");
    expect(html).toContain("Sam");
    expect(html).toContain("Jo");
    expect(html).toContain("2 on site");
  });

  it("styles a delay-flagged entry and shows the reason", () => {
    const html = renderToString(
      createElement(JobDiary, {
        jobId: "job-1",
        jobName: "Birdwood IV",
        initialEntries: [
          entry({
            id: "di_2",
            date: "2026-06-16",
            happenings: "Stood down half day",
            delay: { flagged: true, reason: "Builder failed to provide access" },
          }),
        ],
        fetchError: null,
      }),
    );
    expect(html).toContain("Delay flagged");
    expect(html).toContain("Builder failed to provide access");
    expect(html).toContain('data-delay="true"');
  });

  it("shows an amendment UNDER the original (original text stays visible)", () => {
    const html = renderToString(
      createElement(JobDiary, {
        jobId: "job-1",
        jobName: "Birdwood IV",
        initialEntries: [
          entry({
            id: "di_3",
            date: "2026-06-17",
            happenings: "ORIGINAL happenings text",
            amendments: [
              {
                id: "dia_1",
                createdAt: "2026-06-18T09:00:00.000Z",
                createdById: "u_boss",
                createdByName: "Boss",
                createdByRole: "boss",
                note: "corrected",
                changes: { happenings: "AMENDED happenings text" },
              },
            ],
          }),
        ],
        fetchError: null,
      }),
    );
    // Both the original and the amendment are visible — append-only.
    expect(html).toContain("ORIGINAL happenings text");
    expect(html).toContain("AMENDED happenings text");
    expect(html).toContain("Amended");
    expect(html).toContain('data-amended="true"');
  });

  it("renders a named fetch error rather than a silent empty list", () => {
    const html = renderToString(
      createElement(JobDiary, {
        jobId: "job-1",
        jobName: "Birdwood IV",
        initialEntries: [],
        fetchError: "Diary API returned 500",
      }),
    );
    expect(html).toContain("Diary API returned 500");
  });

  it("is read-only for an archived job (no editor)", () => {
    const html = renderToString(
      createElement(JobDiary, {
        jobId: "job-1",
        jobName: "Birdwood IV",
        initialEntries: [entry({ id: "di_4", date: "2026-06-15" })],
        fetchError: null,
        readOnly: true,
      }),
    );
    expect(html).toContain("archived");
    expect(html).not.toContain("Add today");
    expect(html).not.toContain("Amend this entry");
  });
});
