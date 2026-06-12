import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { NotificationBell } from "./NotificationBell";
import type { NotificationItem } from "@/domains/platform/notification-item";

/**
 * SSR render tests for the notification bell (#218), driven by `NotificationItem`
 * FIXTURES (node env — no jsdom). The bell is deliberately NOT mounted; the last
 * test proves no source file imports it as live chrome, so this component can be
 * "done" without becoming dead UI.
 */

const requireFromHere = createRequire(import.meta.url);

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: "n1",
    kind: "hoursApproved",
    title: "Hours approved",
    deepLink: "/phil/my-day",
    occurredAt: "2026-06-12T01:00:00.000Z",
    ...over,
  };
}

function render(props: Parameters<typeof NotificationBell>[0]): string {
  return renderToString(createElement(NotificationBell, props));
}

describe("NotificationBell — badge", () => {
  it("shows an unread count badge when rows are unread", () => {
    const html = render({ items: [item(), item({ id: "n2" })] });
    expect(html).toContain('data-testid="notification-bell-badge"');
    expect(html).toContain(">2<");
    // The bell button's aria-label announces the unread count.
    expect(html).toContain('aria-label="Notifications, 2 unread"');
  });

  it("caps the badge at 9+ for large counts", () => {
    const items = Array.from({ length: 12 }, (_, i) => item({ id: `n${i}` }));
    expect(render({ items })).toContain(">9+<");
  });

  it("renders no badge when everything is read", () => {
    const html = render({
      items: [item({ readAt: "2026-06-12T02:00:00.000Z" })],
    });
    expect(html).not.toContain('data-testid="notification-bell-badge"');
    expect(html).toContain('aria-label="Notifications"');
  });
});

describe("NotificationBell — dropdown states", () => {
  it("is closed by default (no dropdown in the DOM)", () => {
    expect(render({ items: [item()] })).not.toContain(
      'data-testid="notification-bell-dropdown"',
    );
  });

  it("open with rows renders the list, deep links and per-row mark-read", () => {
    const html = render({ items: [item()], open: true });
    expect(html).toContain('data-testid="notification-bell-dropdown"');
    expect(html).toContain('data-testid="notification-row-n1"');
    expect(html).toContain('data-testid="notification-link-n1"');
    expect(html).toContain('href="/phil/my-day"');
    expect(html).toContain("Hours approved");
    expect(html).toContain('data-testid="notification-mark-n1"'); // unread → mark-read control
    expect(html).toContain('data-testid="notification-bell-mark-all"'); // mark-all when unread exists
  });

  it("a read row shows no mark-read control and no unread dot styling", () => {
    const html = render({
      items: [item({ readAt: "2026-06-12T02:00:00.000Z" })],
      open: true,
    });
    expect(html).not.toContain('data-testid="notification-mark-n1"');
    // mark-all only appears when there is something unread
    expect(html).not.toContain('data-testid="notification-bell-mark-all"');
  });

  it("a row without a deepLink renders as plain text, not a link", () => {
    const html = render({ items: [item({ deepLink: undefined })], open: true });
    expect(html).toContain('data-testid="notification-row-n1"');
    expect(html).not.toContain('data-testid="notification-link-n1"');
  });

  it("empty open dropdown shows 'You're all caught up.'", () => {
    const html = render({ items: [], open: true });
    expect(html).toContain('data-testid="notification-bell-empty"');
    expect(html).toContain("You&#x27;re all caught up.");
  });

  it("error state replaces the list with a retry message", () => {
    const html = render({ items: [item()], open: true, error: true });
    expect(html).toContain('data-testid="notification-bell-error"');
    expect(html).not.toContain('data-testid="notification-row-n1"');
  });
});

describe("NotificationBell — not mounted (hide-unfinished)", () => {
  it("is imported by nothing except its own test (no dead chrome until a feed exists)", () => {
    const fs = requireFromHere("node:fs") as typeof import("fs");
    const path = requireFromHere("node:path") as typeof import("path");
    const root = path.resolve(__dirname, "..", "..");

    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (entry.name.startsWith("NotificationBell")) continue; // the component + its own test
        const src = fs.readFileSync(full, "utf8");
        // Match an actual IMPORT of the component (live chrome), not a doc-comment
        // mention of the file path. A `from ".../NotificationBell"` import is the
        // only thing that would mount it.
        if (/from\s+["'][^"']*NotificationBell["']/.test(src)) {
          importers.push(path.relative(root, full));
        }
      }
    };
    walk(root);

    expect(importers).toEqual([]);
  });
});
