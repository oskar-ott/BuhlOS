import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SignupFlow } from "./SignupFlow";
import { CrewSignupPanel } from "@/components/admin/CrewSignupPanel";

/**
 * Server-render smoke for the crew sign-up flow (public /onboarding/[code])
 * and the admin panel shell. Same renderToString approach as the O1 render
 * tests — catches SSR crashes and copy drift without auth or Blob.
 */

const LINK = {
  companyName: "bühl electrical",
  createdByName: "oskar",
  expiresAt: "2026-07-30T00:00:00.000Z",
};

describe("SignupFlow (public)", () => {
  it("valid link renders the landing with the approval story", () => {
    const html = renderToString(
      createElement(SignupFlow, { code: "abc", state: "valid", link: LINK }),
    );
    expect(html).toContain("invited to join");
    expect(html).toContain("bühl electrical");
    expect(html).toContain("on BuhlOS.");
    expect(html).toContain("the office approves you");
    expect(html).toContain("Start");
    // Single brand — never the internal name.
    expect(html).not.toMatch(/\bPhil\b/);
  });

  it.each([
    ["expired", "This link has expired"],
    ["paused", "Sign-ups are paused"],
    ["capped", "hit its limit"],
    ["revoked", "no longer active"],
    ["invalid", "isn&#x27;t valid"],
  ] as const)("dead state %s says what to do next", (state, needle) => {
    const html = renderToString(
      createElement(SignupFlow, { code: "abc", state, link: null }),
    );
    expect(html).toContain(needle);
    expect(html).toContain("Already set up? Sign in");
  });
});

describe("CrewSignupPanel (admin)", () => {
  it("SSR renders the loading shell without crashing (fetch happens client-side)", () => {
    const html = renderToString(createElement(CrewSignupPanel));
    expect(html).toContain("Crew sign-up link");
  });
});
