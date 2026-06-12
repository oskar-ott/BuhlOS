import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { LeaveApprovalsCard } from "./LeaveApprovalsCard";
import type { LeaveRequest } from "@/domains/timesheets/types";

/**
 * Static guards for the /hours leave card (#333). Decide/record write paths
 * are pinned by the leave API harness; these pin the admin-facing surface:
 * the pending queue, the record-on-behalf form and the honest empty state.
 */

const req = (extra: Partial<LeaveRequest>): LeaveRequest =>
  ({
    id: "lv_1",
    userId: "u1",
    userName: "Jack Smith",
    type: "sick",
    fromDate: "2026-07-06",
    toDate: "2026-07-06",
    note: null,
    status: "pending",
    ...extra,
  }) as LeaveRequest;

const workers = [
  { id: "u1", username: "Jack Smith" },
  { id: "u2", username: "Tom Brown" },
];

describe("LeaveApprovalsCard", () => {
  it("renders the pending queue with Approve/Decline and the exemption promise", () => {
    const html = renderToString(
      createElement(LeaveApprovalsCard, {
        initialRequests: [req({ note: "Flu" })],
        fetchError: null,
        workers,
      }),
    );
    expect(html).toContain("Leave");
    expect(html).toContain("Jack Smith");
    expect(html).toContain("Flu");
    expect(html).toContain("Approve");
    expect(html).toContain("Decline");
    expect(html).toContain("missing hours");
    expect(html).toContain("leave-record-open");
  });

  it("decided requests leave the queue; approved count stays visible", () => {
    const html = renderToString(
      createElement(LeaveApprovalsCard, {
        initialRequests: [
          req({ id: "lv_a", status: "approved" }),
          req({ id: "lv_d", status: "declined" }),
        ],
        fetchError: null,
        workers,
      }),
    );
    expect(html).toContain("No pending requests");
    expect(html).toContain("1");
    expect(html).toContain("approved on file");
  });

  it("surfaces the load error", () => {
    const html = renderToString(
      createElement(LeaveApprovalsCard, {
        initialRequests: [],
        fetchError: "Leave queue: API 500",
        workers,
      }),
    );
    expect(html).toContain("Leave queue: API 500");
  });
});
