import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilLeaveClient } from "./PhilLeaveClient";
import type { LeaveRequest } from "@/domains/timesheets/types";

/**
 * Static guards for /phil/leave (#333). The write paths (request / overlap
 * 409 / cancel) are pinned by the leave API harness; these pin what the
 * worker actually sees.
 */

const req = (extra: Partial<LeaveRequest>): LeaveRequest =>
  ({
    id: "lv_1",
    userId: "u1",
    userName: "Oskar",
    type: "annual",
    fromDate: "2026-07-06",
    toDate: "2026-07-10",
    note: null,
    status: "pending",
    ...extra,
  }) as LeaveRequest;

describe("PhilLeaveClient", () => {
  it("renders the request form with type/date fields and the why-this-matters promise", () => {
    const html = renderToString(
      createElement(PhilLeaveClient, { initialRequests: [], fetchError: null }),
    );
    expect(html).toContain("Request leave");
    expect(html).toContain("leave-type");
    expect(html).toContain("leave-from");
    expect(html).toContain("leave-submit");
    expect(html).toContain("Annual leave");
    expect(html).toContain("Sick leave");
    expect(html).toContain("missing hours");
    expect(html).toContain("No leave requests yet");
  });

  it("lists requests with status pills; pending ones offer Cancel", () => {
    const html = renderToString(
      createElement(PhilLeaveClient, {
        initialRequests: [
          req({ id: "lv_p", status: "pending" }),
          req({ id: "lv_a", status: "approved", fromDate: "2026-06-01", toDate: "2026-06-02" }),
        ],
        fetchError: null,
      }),
    );
    expect(html).toContain("pending");
    expect(html).toContain("approved");
    expect(html).toContain("Cancel");
    expect(html).toContain("2026-07-06");
    // Range renders an arrow between differing dates.
    expect(html).toContain("2026-07-10");
  });

  it("a declined request shows the office's reason", () => {
    const html = renderToString(
      createElement(PhilLeaveClient, {
        initialRequests: [
          req({ status: "declined", decisionNote: "Both crews committed that week" }),
        ],
        fetchError: null,
      }),
    );
    expect(html).toContain("declined");
    expect(html).toContain("Both crews committed that week");
  });

  it("surfaces the load error instead of pretending the list is empty", () => {
    const html = renderToString(
      createElement(PhilLeaveClient, {
        initialRequests: [],
        fetchError: "Couldn’t load your requests",
      }),
    );
    expect(html).toContain("Couldn’t load your requests");
  });
});
