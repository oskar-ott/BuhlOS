import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

describe("LoginForm — worker mode (#421, email-first 2026-07-28)", () => {
  const html = renderToString(createElement(LoginForm, { initialMode: "worker" }));

  it("renders an email field, a numeric PIN field and a full 0–9 keypad", () => {
    expect(html).toContain("worker-name"); // testid frozen — smoke hook
    expect(html).toContain("Your email");
    expect(html).not.toContain("Your name");
    expect(html.toLowerCase()).toContain('type="email"');
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

/**
 * #575 P1a — drift guard: a successful sign-in MUST purge the offline /phil page
 * cache so a shared device never serves the previous worker's pages. The flow is
 * a `useTransition` async handler ending in `window.location.assign` (not
 * cleanly drivable in jsdom), so we assert the source wires the purge on the
 * sign-in path. `purgePhilPageCaches` itself is behaviour-tested in
 * src/domains/phil/page-cache.test.ts.
 */
describe("LoginForm — clears the offline page cache on sign-in (#575 P1a)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./login-form.tsx", import.meta.url)),
    "utf8",
  );

  it("imports and calls purgePhilPageCaches before navigating", () => {
    expect(src).toContain("purgePhilPageCaches");
    expect(src).toContain("await purgePhilPageCaches()");
    // purge must run before the hard navigation that loads the new session.
    const purgeAt = src.indexOf("await purgePhilPageCaches()");
    const assignAt = src.indexOf("window.location.assign(target)");
    expect(purgeAt).toBeGreaterThan(-1);
    expect(assignAt).toBeGreaterThan(purgeAt);
  });
});
