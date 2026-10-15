import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PinResetLanding, PinResetRequestScreen } from "./PinResetScreens";

/**
 * Server-render guards for self-service PIN recovery. The security contract is
 * pinned by the API harness (pin-reset-api.test.ts); these pin what a locked-out
 * worker SEES — above all the two honesty rules:
 *   · asking for a link never confirms whether an account exists (P7);
 *   · with no mail provider wired, no button is offered at all — the office
 *     phone is, because a link could never arrive.
 */

const PHONE = "0421 558 902";
/** renderToString splits adjacent nodes with `<!-- -->` and escapes quotes
 *  (`G&#x27;day`); normalise both so copy asserts read as a person would. */
const render = (el: React.ReactElement) =>
  renderToString(el)
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

describe("PinResetRequestScreen", () => {
  it("offers the form when email can actually be delivered", () => {
    const html = render(
      createElement(PinResetRequestScreen, { emailConfigured: true, officePhone: PHONE }),
    );
    expect(html).toContain("Forgotten your PIN?");
    expect(html).toContain('data-testid="pin-reset-email"');
    expect(html).toContain('data-testid="pin-reset-send"');
    // Names the right address plainly — the trap that locked a worker out was
    // signing in with the wrong email (and their email password).
    expect(html).toContain("the email you used to sign up with");
  });

  it("with NO mail provider it offers the office phone, never a button that can't deliver", () => {
    const html = render(
      createElement(PinResetRequestScreen, { emailConfigured: false, officePhone: PHONE }),
    );
    expect(html).toContain(PHONE);
    expect(html).not.toContain('data-testid="pin-reset-send"');
    expect(html).not.toContain('data-testid="pin-reset-email"');
  });
});

describe("PinResetLanding — dead ends are honest, never a form that would fail", () => {
  for (const state of ["expired", "used", "invalid"] as const) {
    it(`${state}: explains it and offers a fresh link, with no PIN form`, () => {
      const html = render(
        createElement(PinResetLanding, { token: "t", state, officePhone: PHONE }),
      );
      expect(html).toContain('data-testid="pin-reset-dead-end"');
      expect(html).toContain("Send me a new link");
      expect(html).not.toContain('data-testid="pin-reset-save"');
    });
  }

  it("valid: greets by name and asks for a 4-digit PIN twice, Save disabled at rest", () => {
    const html = render(
      createElement(PinResetLanding, {
        token: "t",
        state: "valid",
        firstName: "Anders",
        officePhone: PHONE,
      }),
    );
    expect(html).toContain("G'day Anders.");
    expect(html).toContain("(4 digits)");
    expect(html).toContain('data-testid="pin-reset-confirm"');
    const idx = html.indexOf('data-testid="pin-reset-save"');
    expect(idx).toBeGreaterThan(-1);
    expect(html.slice(Math.max(0, idx - 400), idx + 200)).toContain("disabled");
    // Nothing is prefilled — the new PIN never round-trips through the page.
    expect(html).toContain('value=""');
  });

  it("valid + admin: asks for a PASSWORD (6+), mirroring the server's format rule", () => {
    const html = render(
      createElement(PinResetLanding, {
        token: "t",
        state: "valid",
        firstName: "Tom",
        isPassword: true,
        officePhone: PHONE,
      }),
    );
    expect(html).toContain("(6+ characters)");
    expect(html).toContain('type="password"');
    expect(html).not.toContain("(4 digits)");
  });
});
