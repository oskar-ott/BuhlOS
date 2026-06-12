import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";
import { SESSION_COOKIE } from "@/lib/auth/session";

/**
 * Redirect / landing contract test for src/middleware.ts.
 *
 * This locks docs/route-ownership.md §3 (route gating) and §10 (redirect /
 * landing contract) as a fast unit test — no browser, no preview, no seeded
 * credentials. The Playwright auth-routing smoke (tests/playwright/smoke/
 * auth-routing.spec.ts) proves the same contract end-to-end against a live
 * preview; this proves the middleware *decision* in CI's `test:unit` so a
 * regression is caught before a preview even builds.
 *
 * The middleware reads a `buhl_session` cookie shaped `<base64url-json>.<sig>`
 * (decodeSessionCookie does not verify the HMAC — see src/lib/auth/session.ts),
 * so a test session is minted by base64url-encoding the payload. The signature
 * segment is required to be present but is ignored.
 */

const BASE = "https://app.test";

function cookieFor(role: string): string {
  const body = Buffer.from(JSON.stringify({ role }), "utf8").toString("base64url");
  // decodeSessionCookie requires a non-empty body before the first "." and
  // ignores everything after it (HMAC is the legacy API's job).
  return `${body}.sig`;
}

function request(pathname: string, opts: { role?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.role) headers.set("cookie", `${SESSION_COOKIE}=${cookieFor(opts.role)}`);
  return new NextRequest(new URL(`${BASE}${pathname}`), { headers });
}

/** NextResponse.next() carries `x-middleware-next: 1` and no Location. */
function isPassThrough(res: Response): boolean {
  return res.headers.get("x-middleware-next") === "1" && !res.headers.get("location");
}

/** Returns the redirect target's pathname + `next` param, or null if not a 307. */
function redirectTarget(res: Response): { pathname: string; next: string | null } | null {
  if (res.status !== 307) return null;
  const loc = res.headers.get("location");
  if (!loc) return null;
  const url = new URL(loc);
  return { pathname: url.pathname, next: url.searchParams.get("next") };
}

describe("middleware — /v2/login is always public", () => {
  it("passes /v2/login through with no session", () => {
    expect(isPassThrough(middleware(request("/v2/login")))).toBe(true);
  });

  it("passes /v2/login through even with a session (the page itself bounces)", () => {
    expect(isPassThrough(middleware(request("/v2/login", { role: "admin" })))).toBe(true);
  });
});

describe("middleware — non-gated routes are never touched", () => {
  it.each(["/", "/login", "/admin/operations", "/my-day", "/phil", "/lh", "/client"])(
    "passes %s through (owned by vercel.json, not Next middleware)",
    (pathname) => {
      expect(isPassThrough(middleware(request(pathname)))).toBe(true);
    },
  );
});

describe("middleware — unauthenticated access to a gated route → /v2/login?next=", () => {
  it.each([
    "/command-centre",
    "/hours",
    "/hours/approvals",
    "/hours/weekly",
    "/gear",
    "/employees",
    "/observations",
    "/material-requests",
    "/defects",
    "/v2/jobs",
    "/v2/jobs/abc123/builder",
    "/v2/phil",
    "/phil/my-day",
    "/phil/hours",
    "/phil/gear",
    "/phil/jobs",
    "/phil/onboarding",
  ])("redirects %s to /v2/login carrying the original path as next", (pathname) => {
    const target = redirectTarget(middleware(request(pathname)));
    expect(target).not.toBeNull();
    expect(target!.pathname).toBe("/v2/login");
    expect(target!.next).toBe(pathname);
  });
});

describe("middleware — admin tier on BuhlOS admin surfaces", () => {
  it.each([
    "/command-centre",
    "/hours",
    "/hours/weekly",
    "/gear",
    "/employees",
    "/observations",
    "/material-requests",
    "/v2/jobs",
    "/v2/jobs/abc123/builder",
  ])("lets an admin through %s", (pathname) => {
    expect(isPassThrough(middleware(request(pathname, { role: "admin" })))).toBe(true);
  });

  it("lets a boss (admin tier) through /command-centre", () => {
    expect(isPassThrough(middleware(request("/command-centre", { role: "boss" })))).toBe(true);
  });

  it("redirects a field worker off /command-centre to their Phil home", () => {
    const target = redirectTarget(middleware(request("/command-centre", { role: "tradie" })));
    expect(target?.pathname).toBe("/phil/my-day");
    expect(target?.next).toBeNull(); // wrong-surface redirect clears the query
  });

  it("redirects a client off /observations to their landing", () => {
    const target = redirectTarget(middleware(request("/observations", { role: "client" })));
    expect(target?.pathname).toBe("/client");
  });
});

describe("middleware — Phil surfaces are field/LH only", () => {
  it.each(["/phil/my-day", "/phil/hours", "/phil/gear", "/phil/jobs", "/v2/phil"])(
    "lets a tradie through %s",
    (pathname) => {
      expect(isPassThrough(middleware(request(pathname, { role: "tradie" })))).toBe(true);
    },
  );

  it("lets a leading hand through /phil/my-day", () => {
    expect(isPassThrough(middleware(request("/phil/my-day", { role: "leadinghand" })))).toBe(true);
  });

  it("redirects an admin off /phil/jobs back to the Command Centre", () => {
    const target = redirectTarget(middleware(request("/phil/jobs", { role: "admin" })));
    expect(target?.pathname).toBe("/command-centre");
  });
});

describe("middleware — /v2/jobs admin-review surface (admin OR leading hand)", () => {
  it("lets a leading hand through /v2/jobs (LH read-only enforced in-page)", () => {
    expect(isPassThrough(middleware(request("/v2/jobs", { role: "lh" })))).toBe(true);
  });

  it("lets an admin through /v2/jobs", () => {
    expect(isPassThrough(middleware(request("/v2/jobs", { role: "admin" })))).toBe(true);
  });

  it("redirects a field worker off /v2/jobs to their Phil home", () => {
    const target = redirectTarget(middleware(request("/v2/jobs", { role: "tradie" })));
    expect(target?.pathname).toBe("/phil/my-day");
  });
});

describe("middleware — /defects register (#414, same surface as /v2/jobs)", () => {
  it("lets an admin through /defects", () => {
    expect(isPassThrough(middleware(request("/defects", { role: "admin" })))).toBe(true);
  });

  it("lets a leading hand through /defects (API scopes them to assigned jobs)", () => {
    expect(isPassThrough(middleware(request("/defects", { role: "lh" })))).toBe(true);
  });

  it("redirects a field worker off /defects to their Phil home", () => {
    const target = redirectTarget(middleware(request("/defects", { role: "tradie" })));
    expect(target?.pathname).toBe("/phil/my-day");
  });
});
