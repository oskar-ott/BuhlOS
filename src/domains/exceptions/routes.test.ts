import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ACTION_ROUTES,
  encodeSegment,
  isSafeActionHref,
  resolveAction,
  withFragment,
  withQuery,
  type ActionRouteKey,
} from "./routes";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("ACTION_ROUTES — every registered route is a real page on disk", () => {
  it.each(Object.entries(ACTION_ROUTES))(
    "%s → its sourceFile exists",
    (_key, def) => {
      expect(existsSync(resolve(REPO_ROOT, def.sourceFile))).toBe(true);
    },
  );

  it("builds canonical, safe hrefs for every route (with a sample jobId)", () => {
    for (const [, def] of Object.entries(ACTION_ROUTES)) {
      const href = def.build({ jobId: "job-1" });
      expect(href.startsWith("/")).toBe(true);
      expect(isSafeActionHref(href)).toBe(true);
    }
  });
});

describe("isSafeActionHref — hardened internal-only guard", () => {
  it("accepts canonical internal paths (including encoded segments and hyphens)", () => {
    expect(isSafeActionHref("/hours/approvals")).toBe(true);
    expect(isSafeActionHref("/v2/jobs/job-1/builder")).toBe(true);
    expect(isSafeActionHref("/v2/jobs/job%2F1%3Fx/observations")).toBe(true);
  });

  it("rejects external, scheme, protocol-relative, backslash, whitespace, control and empty", () => {
    expect(isSafeActionHref("https://evil.example")).toBe(false);
    expect(isSafeActionHref("http://evil.example")).toBe(false);
    expect(isSafeActionHref("javascript:alert(1)")).toBe(false);
    expect(isSafeActionHref("/path?x=javascript:alert(1)")).toBe(false); // colon anywhere → out
    expect(isSafeActionHref("//evil.example")).toBe(false);
    expect(isSafeActionHref("/a\\b")).toBe(false);
    expect(isSafeActionHref("/a b")).toBe(false); // space
    expect(isSafeActionHref("/a\tb")).toBe(false); // tab
    expect(isSafeActionHref("/a\nb")).toBe(false); // newline
    expect(isSafeActionHref("not-a-path")).toBe(false);
    expect(isSafeActionHref("")).toBe(false);
    expect(isSafeActionHref(undefined)).toBe(false);
    expect(isSafeActionHref(null)).toBe(false);
  });
});

describe("encodeSegment + resolveAction", () => {
  it("encodes dynamic job segments containing / ? #", () => {
    expect(encodeSegment("job/1?x=#frag")).toBe("job%2F1%3Fx%3D%23frag");
    const a = resolveAction("jobBuilder", { jobId: "job/1#frag" });
    expect(a.actionState).toBe("available");
    expect(a.actionHref).toBe("/v2/jobs/job%2F1%23frag/builder");
    expect(isSafeActionHref(a.actionHref)).toBe(true);
  });

  it("returns `available` with the default or overridden label for known routes", () => {
    expect(resolveAction("hoursApprovals")).toMatchObject({ actionState: "available", actionHref: "/hours/approvals", actionLabel: "Review approvals" });
    expect(resolveAction("hoursApprovals", {}, { label: "Review rejections" }).actionLabel).toBe("Review rejections");
  });

  it("downgrades a per-job route to `unavailable` (with reason) when no jobId is given", () => {
    const a = resolveAction("jobEvidence", {});
    expect(a.actionState).toBe("unavailable");
    expect(a.actionHref).toBeUndefined();
    expect(a.actionReason).toMatch(/specific job/i);
  });

  it("degrades to `fallback` with a SAFE fallback href, or `unavailable` without one", () => {
    const safe = resolveAction("jobObservations", {}, { fallbackHref: "/observations" });
    expect(safe).toMatchObject({ actionState: "fallback", actionHref: "/observations" });
    const unsafe = resolveAction("jobObservations", {}, { fallbackHref: "https://evil.example" });
    expect(unsafe.actionState).toBe("unavailable");
    expect(unsafe.actionHref).toBeUndefined();
  });

  it("returns `unavailable` for an unregistered key (no fabricated route)", () => {
    const a = resolveAction("totally-made-up" as ActionRouteKey);
    expect(a.actionState).toBe("unavailable");
    expect(a.actionHref).toBeUndefined();
    expect(a.actionReason).toMatch(/no route registered/i);
  });
});

describe("withFragment + resolveAction fragments (deep-link anchors)", () => {
  it("appends a valid fragment and keeps the href safe", () => {
    expect(withFragment("/v2/jobs/j1/builder", "assigned-field-workers")).toBe("/v2/jobs/j1/builder#assigned-field-workers");
    expect(isSafeActionHref(withFragment("/v2/jobs/j1/builder", "publish"))).toBe(true);
  });

  it("ignores empty / malformed fragments (no anchor appended)", () => {
    expect(withFragment("/x", undefined)).toBe("/x");
    expect(withFragment("/x", "")).toBe("/x");
    expect(withFragment("/x", "Bad Frag")).toBe("/x"); // space
    expect(withFragment("/x", "../escape")).toBe("/x"); // not an id
    expect(withFragment("/x", "a#b")).toBe("/x"); // second hash
  });

  it("resolveAction applies the fragment only on the resolved available href", () => {
    const ok = resolveAction("jobBuilder", { jobId: "j1" }, { fragment: "assigned-field-workers", label: "Assign field workers" });
    expect(ok).toMatchObject({ actionState: "available", actionHref: "/v2/jobs/j1/builder#assigned-field-workers", actionLabel: "Assign field workers" });
    // a degraded (fallback/unavailable) result never carries the primary anchor
    const degraded = resolveAction("jobBuilder", {}, { fragment: "publish", fallbackHref: "/v2/jobs" });
    expect(degraded.actionState).toBe("fallback");
    expect(degraded.actionHref).toBe("/v2/jobs");
  });

  it("encodes the jobId before appending the anchor (jobId '#' cannot inject)", () => {
    const a = resolveAction("jobBuilder", { jobId: "j#1/2" }, { fragment: "publish" });
    expect(a.actionHref).toBe("/v2/jobs/j%231%2F2/builder#publish");
    expect(isSafeActionHref(a.actionHref)).toBe(true);
  });
});

describe("withQuery + resolveAction query (deep-link to a focused list item)", () => {
  it("appends an encoded query string and stays safe", () => {
    expect(withQuery("/material-requests", { focus: "mr_1" })).toBe("/material-requests?focus=mr_1");
    expect(isSafeActionHref(withQuery("/material-requests", { focus: "mr_1" }))).toBe(true);
  });

  it("encodes ids containing / ? # and spaces (no path break, no param injection)", () => {
    expect(withQuery("/material-requests", { focus: "a/b?c#d e" })).toBe(
      "/material-requests?focus=a%2Fb%3Fc%23d%20e",
    );
    expect(isSafeActionHref(withQuery("/material-requests", { focus: "a/b?c#d e" }))).toBe(true);
  });

  it("drops empty / nullish params", () => {
    expect(withQuery("/x", { a: "", b: undefined, c: null })).toBe("/x");
    expect(withQuery("/x", { a: "1", b: "" })).toBe("/x?a=1");
  });

  it("resolveAction applies a query to the material-requests deep-link", () => {
    const a = resolveAction("materialRequests", {}, { label: "Open request", query: { focus: "mr#7/8" } });
    expect(a).toMatchObject({ actionState: "available", actionLabel: "Open request" });
    expect(a.actionHref).toBe("/material-requests?focus=mr%237%2F8");
    expect(isSafeActionHref(a.actionHref)).toBe(true);
  });
});
