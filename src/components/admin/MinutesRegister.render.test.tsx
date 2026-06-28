import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { MinutesRegister } from "./MinutesRegister";
import type { MinuteEntry } from "@/domains/minutes/schema";

/**
 * SSR render tests for the meeting-minutes register (#217): the record form, the
 * newest-first list, the stamped amendment rendered BENEATH the unchanged
 * original body, the attachment link, the honest empty state for a missing body,
 * and the honest "no minutes yet" empty state.
 */

function minute(over: Partial<MinuteEntry> & Pick<MinuteEntry, "id" | "title" | "date">): MinuteEntry {
  return {
    jobId: "job-1",
    attendees: [],
    body: "",
    attachment: null,
    amendments: [],
    createdBy: "boss",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    auditLogIds: [],
    ...over,
  };
}

const strip = (h: string) => h.replace(/<!-- -->/g, "");

describe("MinutesRegister — render", () => {
  const html = strip(
    renderToString(
      createElement(MinutesRegister, {
        jobId: "job-1",
        initialMinutes: [
          minute({
            id: "m1",
            date: "2026-05-10",
            title: "Kickoff meeting",
            body: "Agreed the program.",
          }),
          minute({
            id: "m2",
            date: "2026-06-20",
            title: "Coordination meeting",
            attendees: [
              { name: "Pat Builder", contactId: "c_1" },
              { name: "Sam Sparky", contactId: null },
            ],
            body: "Discussed the riser route.",
            amendments: [{ at: "2026-06-21T00:00:00.000Z", by: "boss", note: "Action 3 reassigned." }],
          }),
        ],
        fetchError: null,
      })
    )
  );

  it("shows the record form", () => {
    expect(html).toContain("Record minutes");
    expect(html).toContain("Attendees");
  });

  it("lists minutes newest-first (June before May)", () => {
    expect(html).toContain("Coordination meeting");
    expect(html).toContain("Kickoff meeting");
    expect(html.indexOf("Coordination meeting")).toBeLessThan(html.indexOf("Kickoff meeting"));
  });

  it("renders attendees and the body", () => {
    expect(html).toContain("Pat Builder");
    expect(html).toContain("Discussed the riser route.");
  });

  it("renders a stamped amendment beneath the unchanged original", () => {
    expect(html).toContain("Amendments");
    expect(html).toContain("Action 3 reassigned.");
    // The original body still appears, unchanged, above the amendment.
    expect(html.indexOf("Discussed the riser route.")).toBeLessThan(
      html.indexOf("Action 3 reassigned.")
    );
  });
});

describe("MinutesRegister — honest empty states", () => {
  it("states 'no minutes yet' plainly when the list is empty", () => {
    const html = strip(
      renderToString(
        createElement(MinutesRegister, { jobId: "job-1", initialMinutes: [], fetchError: null })
      )
    );
    expect(html).toContain("No minutes recorded on this job yet");
  });

  it("states a missing body honestly (no fake placeholder) and links the attachment", () => {
    const html = strip(
      renderToString(
        createElement(MinutesRegister, {
          jobId: "job-1",
          initialMinutes: [
            minute({
              id: "m3",
              date: "2026-06-22",
              title: "Attachment-only minute",
              body: "",
              attachment: {
                blobPath: "jobs/job-1/minutes/m3.pdf",
                url: "https://blob.test/m3.pdf",
                fileName: "minutes.pdf",
                mimeType: "application/pdf",
                sizeBytes: 100,
              },
            }),
          ],
          fetchError: null,
        })
      )
    );
    expect(html).toContain("No written minutes");
    expect(html).toContain("minutes.pdf");
    expect(html).toContain("https://blob.test/m3.pdf");
  });
});
