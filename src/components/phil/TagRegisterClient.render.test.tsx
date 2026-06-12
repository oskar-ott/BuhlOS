import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TagRegisterClient } from "./TagRegisterClient";
import type { TagItem } from "@/domains/tags/schema";

/**
 * Static-render guard for the Test & tag register (#388): honest empty state
 * (capture flow explained, human-confirm promise), expired-first ordering
 * with overdue flags, fail-loud load errors. Interaction flows (photo → OCR
 * → confirm) are exercised on the PR preview — `next dev`/jsdom can't run
 * api/*.js (see docs: local verification limits).
 */

function ddmm(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

const tag = (id: string, expiryDate?: string, extra: Partial<TagItem> = {}): TagItem =>
  ({ id, applianceType: `Item ${id}`, expiryDate, ...extra }) as TagItem;

describe("TagRegisterClient", () => {
  it("empty register: explains photo capture and the human-confirm step", () => {
    const html = renderToString(
      createElement(TagRegisterClient, { jobId: "j1", initialTags: [], fetchError: null }),
    );
    expect(html).toContain("Add a tag");
    expect(html).toContain("No test &amp; tag entries on this job yet");
    expect(html).toContain("you confirm them before anything is saved");
  });

  it("renders expired entries first with an overdue pill; failed result is loud", () => {
    const html = renderToString(
      createElement(TagRegisterClient, {
        jobId: "j1",
        initialTags: [
          tag("ok", ddmm(200), { result: "pass" }),
          tag("bad", ddmm(-4), { result: "fail", tagNumber: "T-9" }),
        ],
        fetchError: null,
      }),
    );
    expect(html).toContain("4d overdue");
    expect(html).toContain("FAIL");
    expect(html).toContain("In date");
    // expired row renders before the in-date row
    expect(html.indexOf("Item bad")).toBeLessThan(html.indexOf("Item ok"));
  });

  it("surfaces a load error as an alert instead of an empty-register lie", () => {
    const html = renderToString(
      createElement(TagRegisterClient, {
        jobId: "j1",
        initialTags: [],
        fetchError: "Tags API returned 500",
      }),
    );
    expect(html).toContain("Tags API returned 500");
    expect(html).not.toContain("No test &amp; tag entries");
  });
});
