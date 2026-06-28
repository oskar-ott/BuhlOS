import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { Package } from "lucide-react";
import {
  InboxBanner,
  InboxFilterBar,
  InboxFilterSelect,
  InboxLoadErrorCard,
  InboxStatStrip,
  type InboxStat,
} from "./InboxShell";

// RefreshButton (rendered in the load-error card) calls useRouter; stub it so
// the SSR smoke doesn't need a mounted app router (mirrors the inbox tests).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

/**
 * Server-render smoke for the shared inbox shell primitives (brief §6). Mirrors
 * the project's renderToString approach — node env, no browser. Confirms the
 * shell renders the HONEST states: a real zero stays muted, a dash placeholder
 * stays muted, an earned count carries its tone, and the load-error card shows
 * the server reason.
 */

describe("InboxStatStrip", () => {
  it("renders each tile's label and value", () => {
    const stats: InboxStat[] = [
      { key: "a", label: "Awaiting review", value: 3, tone: "warning" },
      { key: "b", label: "On order", value: "—", tone: "info", icon: Package },
    ];
    const html = renderToString(<InboxStatStrip stats={stats} />);
    expect(html).toContain("Awaiting review");
    expect(html).toContain(">3<");
    expect(html).toContain("On order");
  });

  it("renders a non-zero tone tile with its earned colour on the value", () => {
    // The label is always muted by design; the assertion targets the VALUE's
    // tone class (the tabular-nums line) so it can't be satisfied by the label.
    const html = renderToString(
      <InboxStatStrip stats={[{ key: "x", label: "Urgent", value: 2, tone: "danger" }]} />
    );
    expect(html).toContain("tabular-nums text-rose-700");
  });

  it("renders a real zero as a muted value (calm empty queue, no unearned colour)", () => {
    const html = renderToString(
      <InboxStatStrip stats={[{ key: "x", label: "Urgent", value: 0, tone: "danger" }]} />
    );
    expect(html).toContain("tabular-nums text-text-muted");
    expect(html).not.toContain("text-rose-700");
  });

  it("renders the dash placeholder as a muted value (signal not loaded, never a fake 0)", () => {
    const html = renderToString(
      <InboxStatStrip
        stats={[{ key: "x", label: "Unsigned value", value: "—", tone: "warning" }]}
      />
    );
    expect(html).toContain("—");
    expect(html).toContain("tabular-nums text-text-muted");
    expect(html).not.toContain("text-amber-700");
  });
});

describe("InboxFilterBar", () => {
  it("renders the N-of-M count and its filter children", () => {
    const html = renderToString(
      <InboxFilterBar shown={4} total={10}>
        <InboxFilterSelect
          label="Status"
          value=""
          onChange={() => {}}
          options={[{ value: "open", label: "Open" }]}
        />
      </InboxFilterBar>
    );
    expect(html).toContain("4 of 10");
    expect(html).toContain("Status");
    expect(html).toContain("Open");
  });

  it("shows a Clear control only when onClear is provided", () => {
    const withClear = renderToString(
      <InboxFilterBar shown={1} total={2} onClear={() => {}}>
        x
      </InboxFilterBar>
    );
    expect(withClear).toContain("Clear");

    const without = renderToString(
      <InboxFilterBar shown={1} total={2}>
        x
      </InboxFilterBar>
    );
    expect(without).not.toContain(">Clear<");
  });
});

describe("InboxBanner", () => {
  it("renders success and danger tones", () => {
    expect(renderToString(<InboxBanner tone="success">Updated.</InboxBanner>)).toContain(
      "Updated."
    );
    const danger = renderToString(<InboxBanner tone="danger">Failed.</InboxBanner>);
    expect(danger).toContain("Failed.");
    expect(danger).toContain("bg-rose-50");
  });
});

describe("InboxLoadErrorCard", () => {
  it("renders the honest server reason and a retry", () => {
    const html = renderToString(
      <InboxLoadErrorCard title="Couldn’t load defects" message="API returned 500." />
    );
    expect(html).toContain("Couldn");
    expect(html).toContain("API returned 500.");
    expect(html).toContain("Try again");
  });
});
