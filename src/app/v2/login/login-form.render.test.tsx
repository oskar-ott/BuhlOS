import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { LoginForm } from "./login-form";

/**
 * #421 — worker sign-in mode. Pins (a) the OFFICE form stays byte-identical
 * on its load-bearing hooks (the smoke specs drive these), and (b) the WORKER
 * mode is a name + big-key PIN keypad with no office dialect.
 */

describe("LoginForm — office mode (frozen smoke hooks)", () => {
  const html = renderToString(createElement(LoginForm, {}));

  it("keeps the load-bearing testids and strings the smoke specs depend on", () => {
    for (const hook of ["login-username", "login-password", "login-submit"]) {
      expect(html).toContain(hook);
    }
    expect(html).toContain("Work email");
    expect(html).toContain("Welcome back.");
    expect(html).toContain("Sign in");
  });

  it("offers the worker switch but renders no keypad in office mode", () => {
    expect(html).toContain("login-worker-switch");
    expect(html).not.toContain("worker-key-1");
    expect(html).not.toContain("worker-pin");
  });
});

describe("LoginForm — worker mode (#421)", () => {
  const html = renderToString(createElement(LoginForm, { initialMode: "worker" }));

  it("renders a name field, a numeric PIN field and a full 0–9 keypad", () => {
    expect(html).toContain("worker-name");
    expect(html).toContain("worker-pin");
    expect(html.toLowerCase()).toContain('inputmode="numeric"');
    for (let d = 0; d <= 9; d++) expect(html).toContain(`worker-key-${d}`);
    expect(html).toContain("worker-submit");
  });

  it("speaks no office dialect — no 'Work email' or 'Password' on this path", () => {
    expect(html).not.toContain("Work email");
    expect(html).not.toContain(">Password<");
    // ...and none of the office testids leak into worker mode.
    expect(html).not.toContain("login-username");
    expect(html).not.toContain("login-password");
  });
});
