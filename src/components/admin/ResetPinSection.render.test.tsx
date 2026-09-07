import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ResetPinSection } from "./ResetPinSection";

/**
 * Server-render guards for the employee drawer's "Login PIN" section — the
 * office's reset for a locked-out worker. The in-place reset itself is pinned
 * by the users-api harness (PUT /api/users {id, secret}); these pin what the
 * office SEES: the honest "no account yet" note, the real Reset action when a
 * login exists, the 4-digit-PIN vs password wording by role, and a Save that is
 * disabled until a matching value is typed. (renderToString skips effects and
 * interaction — initial states only; the PIN is never rendered back.)
 */

type Props = Parameters<typeof ResetPinSection>[0];

/** renderToString separates adjacent text/expression nodes with `<!-- -->`
 *  ("Login <!-- -->PIN"); strip them so copy asserts read as a person would. */
function render(props: Props): string {
  return renderToString(createElement(ResetPinSection, props)).replace(/<!-- -->/g, "");
}

describe("ResetPinSection — honest initial states", () => {
  it("no worker account yet → explains the reset keys off the account, offers no button", () => {
    const html = render({ userId: null, workerName: "Anders", role: "apprentice" });
    expect(html).toContain("Login PIN");
    expect(html).toContain("finishes BuhlOS setup");
    expect(html).not.toContain('data-testid="reset-pin-open"');
    expect(html).not.toContain('data-testid="reset-pin-form"');
  });

  it("account exists → a real Reset PIN action, no form until asked", () => {
    const html = render({ userId: "u_field", workerName: "Anders", role: "apprentice" });
    expect(html).toContain('data-testid="reset-pin-open"');
    expect(html).toContain("Reset PIN");
    expect(html).toContain("same account, nothing else changes");
    expect(html).not.toContain('data-testid="reset-pin-form"');
  });

  it("open: PIN form asks for 4 digits + confirm, and Save is disabled at rest", () => {
    const html = render({
      userId: "u_field",
      workerName: "Anders",
      role: "apprentice",
      defaultOpen: true,
    });
    expect(html).toContain('data-testid="reset-pin-form"');
    expect(html).toContain("(4 digits)");
    expect(html).toContain("Confirm PIN");
    expect(html.toLowerCase()).toContain('inputmode="numeric"');
    const idx = html.indexOf('data-testid="reset-pin-save"');
    expect(idx).toBeGreaterThan(-1);
    // The Save button carries `disabled` at rest — nothing typed yet.
    const btn = html.slice(Math.max(0, idx - 400), idx + 200);
    expect(btn).toContain("disabled");
    expect(html).toContain("Save PIN");
    // The PIN is never rendered back into the page.
    expect(html).toContain('value=""');
  });

  it("a literal admin login is a PASSWORD (6+ chars), mirroring api/users.js validateSecret", () => {
    const html = render({
      userId: "u_admin",
      workerName: "Tom",
      role: "admin",
      defaultOpen: true,
    });
    expect(html).toContain("Login password");
    expect(html).toContain("(6+ characters)");
    expect(html).toContain('type="password"');
    expect(html).not.toContain("(4 digits)");
    expect(html).toContain("Save password");
  });
});
