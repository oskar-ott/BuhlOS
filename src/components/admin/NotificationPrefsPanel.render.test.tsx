import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { NotificationPrefsPanel, NotificationPrefRow } from "./NotificationPrefsPanel";
import { NOTIFICATION_PREF_META } from "@/domains/platform/notification-prefs";

/**
 * SSR render tests (node env — no jsdom). The optimistic-flip + rollback logic
 * is exercised as pure functions in
 * src/domains/platform/notification-prefs.test.ts; here we pin the markup:
 *   - the panel starts in its loading skeleton (effects never run under SSR);
 *   - the props-only row reflects on/off via aria-checked and disables in-flight.
 */

describe("NotificationPrefsPanel — initial render", () => {
  it("renders the loading skeleton before the prefs fetch resolves", () => {
    const html = renderToString(createElement(NotificationPrefsPanel));
    expect(html).toContain('data-testid="notification-prefs-loading"');
    expect(html).toContain('aria-busy="true"');
    // It does NOT prematurely render the loaded panel or an error.
    expect(html).not.toContain('data-testid="notification-prefs-panel"');
    expect(html).not.toContain('data-testid="notification-prefs-error"');
  });
});

describe("NotificationPrefRow — props-only toggle", () => {
  const meta = NOTIFICATION_PREF_META.find((m) => m.key === "hoursApproved")!;

  function row(on: boolean, disabled = false): string {
    return renderToString(
      createElement(NotificationPrefRow, { meta, on, disabled, onToggle: () => {} }),
    );
  }

  it("an ON pref renders aria-checked=true with the label + description", () => {
    const html = row(true);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(meta.label);
    // The description's recipient clause has no apostrophes to HTML-escape.
    expect(html).toContain("Sent to the worker whose hours were approved");
    expect(html).toContain('data-testid="toggle-hoursApproved"');
  });

  it("an OFF pref renders aria-checked=false", () => {
    expect(row(false)).toContain('aria-checked="false"');
  });

  it("a saving row is disabled (prevents a second in-flight toggle)", () => {
    expect(row(true, true)).toContain("disabled");
  });

  it("every meta row carries a who-receives-it description, never a bare key", () => {
    for (const m of NOTIFICATION_PREF_META) {
      const html = renderToString(
        createElement(NotificationPrefRow, { meta: m, on: true, disabled: false, onToggle: () => {} }),
      );
      // The recipient clause is rendered (apostrophe-free, so no entity escaping).
      expect(html).toContain("Sent to ");
      // Labels may contain "&" which SSR escapes to "&amp;" — compare decoded.
      expect(html.replace(/&amp;/g, "&")).toContain(m.label);
      expect(html).not.toContain(`>${m.key}<`); // the raw key is never a visible label
    }
  });
});
