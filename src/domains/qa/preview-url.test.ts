import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Unit tests for the Preview Smoke URL guard (scripts/qa/validate-preview-url.js).
 * Loaded via createRequire (CommonJS). Locks the exact bad/good cases Codex
 * called out: production, empty, malformed, bad port, look-alike hosts fail;
 * the exact Birdwood preview + localhost pass.
 */
const requireFromHere = createRequire(import.meta.url);
const { validatePreviewUrl } = requireFromHere("../../../scripts/qa/validate-preview-url.js") as {
  validatePreviewUrl: (url: unknown) => { ok: boolean; reason: string; host?: string };
};

describe("validatePreviewUrl — reject production / unsupported", () => {
  const rejected: Array<[string, unknown]> = [
    ["production buhlos.com", "https://buhlos.com"],
    ["production www.buhlos.com", "https://www.buhlos.com"],
    ["empty", ""],
    ["whitespace", "   "],
    ["undefined", undefined],
    ["malformed", "notaurl"],
    ["malformed scheme-only", "http://"],
    ["invalid port (vercel)", "https://birdwood-git-branch-oskars-projects-86c0cb7e.vercel.app:notaport"],
    ["invalid port (localhost)", "http://localhost:notaport"],
    ["out-of-range port", "http://localhost:99999"],
    ["look-alike vercel host", "https://evil-oskars-projects.vercel.app"],
    ["arbitrary vercel host", "https://something-oskars-projects-86c0cb7e.vercel.app"],
    ["non-http protocol", "ftp://birdwood-git-branch-oskars-projects-86c0cb7e.vercel.app"],
  ];
  for (const [label, url] of rejected) {
    it(`rejects: ${label}`, () => {
      expect(validatePreviewUrl(url).ok).toBe(false);
    });
  }
});

describe("validatePreviewUrl — allow only safe preview/local targets", () => {
  const allowed: Array<[string, string]> = [
    ["birdwood git preview", "https://birdwood-git-foundation-seeded-authenticated-qa-oskars-projects-86c0cb7e.vercel.app"],
    ["birdwood deployment preview", "https://birdwood-abc123-oskars-projects-86c0cb7e.vercel.app/v2/login"],
    ["localhost default", "http://localhost"],
    ["localhost valid port", "http://localhost:3000"],
    ["127.0.0.1 valid port", "http://127.0.0.1:3000"],
  ];
  for (const [label, url] of allowed) {
    it(`allows: ${label}`, () => {
      const res = validatePreviewUrl(url);
      expect(res.ok).toBe(true);
    });
  }

  it("never echoes the raw URL — only sanitized host is returned", () => {
    const res = validatePreviewUrl("https://birdwood-abc-oskars-projects-86c0cb7e.vercel.app/secret-path?token=x");
    expect(res.host).toBe("birdwood-abc-oskars-projects-86c0cb7e.vercel.app");
    expect(JSON.stringify(res)).not.toContain("secret-path");
    expect(JSON.stringify(res)).not.toContain("token=x");
  });
});
