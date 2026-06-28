import { describe, expect, it } from "vitest";
import {
  MINUTE_BODY_MAX,
  MinuteEntrySchema,
  MinutesResponseSchema,
} from "./schema";

/**
 * Schema tests for the meeting-minutes register (#217): the entry shape, the
 * 10000-char body cap, body defaulting to "", nullable attachment + contactId,
 * and the response envelope.
 */

function entry(over: Record<string, unknown> = {}) {
  return {
    id: "min_1",
    jobId: "job-1",
    date: "2026-06-20",
    title: "Site coordination meeting",
    attendees: [
      { name: "Pat Builder", contactId: "c_1" },
      { name: "Free Text", contactId: null },
    ],
    body: "Discussed the riser route.",
    attachment: null,
    amendments: [],
    createdBy: "boss",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    auditLogIds: [],
    ...over,
  };
}

describe("MinuteEntrySchema", () => {
  it("accepts a well-formed entry", () => {
    expect(MinuteEntrySchema.safeParse(entry()).success).toBe(true);
  });

  it("defaults body to an empty string when omitted", () => {
    const { body, ...rest } = entry();
    void body;
    const parsed = MinuteEntrySchema.parse(rest);
    expect(parsed.body).toBe("");
  });

  it("caps the body at MINUTE_BODY_MAX characters", () => {
    expect(MINUTE_BODY_MAX).toBe(10000);
    const ok = MinuteEntrySchema.safeParse(entry({ body: "x".repeat(MINUTE_BODY_MAX) }));
    expect(ok.success).toBe(true);
    const tooLong = MinuteEntrySchema.safeParse(entry({ body: "x".repeat(MINUTE_BODY_MAX + 1) }));
    expect(tooLong.success).toBe(false);
  });

  it("accepts an attachment object and stamped amendments", () => {
    const parsed = MinuteEntrySchema.safeParse(
      entry({
        body: "",
        attachment: {
          blobPath: "jobs/job-1/minutes/min_1.pdf",
          url: "https://blob.example/min_1.pdf",
          fileName: "minutes.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1234,
        },
        amendments: [{ at: "2026-06-21T00:00:00.000Z", by: "boss", note: "Action 3 reassigned." }],
      })
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects a malformed attendee (missing name)", () => {
    expect(
      MinuteEntrySchema.safeParse(entry({ attendees: [{ contactId: null }] })).success
    ).toBe(false);
  });
});

describe("MinutesResponseSchema", () => {
  it("parses an envelope of entries", () => {
    const r = MinutesResponseSchema.safeParse({ minutes: [entry()] });
    expect(r.success).toBe(true);
  });
});
