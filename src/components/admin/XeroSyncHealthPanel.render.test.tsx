import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SyncHealthView, XeroSyncHealthPanel } from "./XeroSyncHealthPanel";

/**
 * #251 — the sync-health panel's honest states. The pure view is rendered
 * with each Load shape (fetches are pinned by the API harness); the wrapper
 * mounts to its loading state under renderToString.
 */

const noop = () => {};
const HANDLERS = {
  busy: null,
  actionError: null,
  ackFor: null,
  ackNote: "",
  onAckOpen: noop,
  onAckNote: noop,
  onAck: noop,
  onRetry: noop,
  onRetryAll: noop,
};

function view(load: Parameters<typeof SyncHealthView>[0]["load"]) {
  // Strip React's SSR text-node separators so copy asserts read naturally.
  return renderToString(createElement(SyncHealthView, { ...HANDLERS, load })).replace(/<!-- -->/g, "");
}

const READY_BASE = {
  counts: { total: 0, byType: {} },
  lastSuccessAt: { timesheet_export: "2026-07-18T06:00:00Z" },
  items: [],
};

describe("SyncHealthView — the honest states", () => {
  it("wrapper mounts to loading", () => {
    const html = renderToString(createElement(XeroSyncHealthPanel));
    expect(html).toContain("Xero sync health");
    expect(html).toContain("Checking the sync log");
  });

  it("unreadable store is loud, never empty-green", () => {
    const html = view({ kind: "unreadable", message: "boom" });
    expect(html).toContain("NOT an all-clear");
    expect(html).toContain("boom");
    expect(html).not.toContain("0 outstanding");
  });

  it("never-connected and disconnected are distinct from all-clear", () => {
    expect(view({ kind: "ready", headline: "never_connected", state: READY_BASE })).toContain(
      "never been connected",
    );
    expect(view({ kind: "ready", headline: "disconnected", state: READY_BASE })).toContain(
      "Xero is disconnected",
    );
    const clear = view({ kind: "ready", headline: "all_clear", state: READY_BASE });
    expect(clear).toContain("0 outstanding");
    expect(clear).toContain("every recorded exchange has landed");
  });

  it("attention lists the failure with operator message, required action and both actions", () => {
    const html = view({
      kind: "ready",
      headline: "attention",
      state: {
        counts: { total: 1, byType: { timesheet_export: 1 } },
        lastSuccessAt: {},
        items: [
          {
            operation: "tsx:b-1",
            syncType: "timesheet_export",
            status: "failed",
            recordRef: "b-1",
            reason: "1 of 2 workers not landed (Bob: rejected)",
            category: "period_locked",
            firstSeenAt: "2026-07-18T05:00:00Z",
            lastSeenAt: "2026-07-18T06:00:00Z",
            seenCount: 2,
          },
        ],
      },
    });
    expect(html).toContain("1 outstanding failure");
    expect(html).toContain("That pay period is locked in Xero");
    expect(html).toContain("Unlock the period in Xero");
    expect(html).toContain("seen 2");
    expect(html).toContain("Retry");
    expect(html).toContain("Acknowledge");
    expect(html).toContain("Retry all");
  });
});
