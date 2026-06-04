import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ACTION_ROUTES,
  encodeSegment,
  isSafeActionHref,
  resolveAction,
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

  it("uses a SAFE fallback href when the primary can't resolve, and drops an unsafe one", () => {
    const safe = resolveAction("jobObservations", {}, { fallbackHref: "/observations" });
    expect(safe).toMatchObject({ actionState: "unavailable", actionHref: "/observations" });
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
