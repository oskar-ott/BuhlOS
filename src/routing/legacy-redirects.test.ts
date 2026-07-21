import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Legacy-URL routing contract (unit level).
 *
 * After the legacy-interface cutover, vercel.json is the single edge
 * routing truth: every old public URL 307-redirects to its canonical
 * modern route, and the ONLY rewrites left are the kept client portal.
 * Installed field PWAs (start_url was /my-day), crew bookmarks and old
 * push deep-links all depend on this matrix — losing an entry strands
 * real devices on a 404.
 *
 * Mirrors scripts/check-legacy-quarantine.js §3/§4 so a drift fails in
 * `npm run test:unit` too (the scripts run in predeploy/CI, this runs in
 * every vitest invocation).
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface RouteRule {
  source: string;
  destination: string;
  permanent?: boolean;
}
const vercel = JSON.parse(readFileSync(resolve(REPO, "vercel.json"), "utf8")) as {
  rewrites?: RouteRule[];
  redirects?: RouteRule[];
};

describe("vercel.json rewrites", () => {
  it("contains ONLY the kept client-portal rewrites", () => {
    expect((vercel.rewrites ?? []).map((r) => `${r.source} -> ${r.destination}`).sort()).toEqual([
      "/client -> /client.html",
      "/client/jobs/:jobId -> /client.html",
    ]);
  });
});

describe("vercel.json legacy redirect matrix", () => {
  const bySource = new Map((vercel.redirects ?? []).map((r) => [r.source, r]));

  it.each([
    ["/login", "/v2/login"],
    ["/login.html", "/v2/login"],
    ["/buhlos", "/v2/login"],
    ["/buhlos/login", "/v2/login"],
    ["/phil/login", "/v2/login"],
    ["/phil", "/phil/my-day"],
    ["/phil/app", "/phil/my-day"],
    ["/my-day", "/phil/my-day"],
    ["/my-day.html", "/phil/my-day"],
    ["/my-gear", "/phil/gear"],
    ["/lh", "/phil/my-day"],
    ["/lh-home", "/phil/my-day"],
    ["/install", "/phil/my-day"],
    ["/jobs", "/v2/jobs"],
    ["/jobs/:jobId", "/phil/jobs/:jobId"],
    ["/admin", "/command-centre"],
    ["/admin/operations", "/command-centre"],
    ["/overview", "/command-centre"],
    ["/admin/approvals", "/hours/approvals"],
    ["/approvals", "/hours/approvals"],
    ["/admin/hours", "/hours"],
    ["/admin/crew", "/employees"],
    ["/admin/jobs", "/v2/jobs"],
    ["/admin/jobs/:jobId", "/v2/jobs/:jobId"],
    ["/admin/assets", "/gear"],
    ["/admin/materials", "/material-requests"],
    ["/buhlos/admin", "/command-centre"],
  ])("redirects %s → %s", (source, destination) => {
    const rule = bySource.get(source);
    expect(rule, `missing redirect for ${source}`).toBeDefined();
    expect(rule?.destination).toBe(destination);
  });

  it("never redirects the root — / is owned by src/app/page.tsx", () => {
    expect(bySource.has("/")).toBe(false);
  });

  it("no redirect targets a static HTML file", () => {
    for (const r of vercel.redirects ?? []) {
      expect(r.destination, `${r.source} → ${r.destination}`).not.toMatch(/\.html(\b|$)/);
    }
  });

  it("uses temporary (307) redirects so targets stay re-mappable", () => {
    for (const r of vercel.redirects ?? []) {
      expect(r.permanent, `${r.source} must not be permanent`).toBe(false);
    }
  });
});

describe("PWA manifest", () => {
  const manifest = JSON.parse(readFileSync(resolve(REPO, "public/manifest.json"), "utf8")) as {
    name?: string;
    short_name?: string;
    start_url?: string;
    shortcuts?: Array<{ url?: string }>;
  };

  it("is the field PWA starting on /phil/my-day", () => {
    expect(manifest.name).toBe("BuhlOS");
    expect(manifest.short_name).toBe("BuhlOS");
    expect(manifest.start_url).toBe("/phil/my-day");
  });

  it("shortcuts deep-link into /phil/*", () => {
    for (const sc of manifest.shortcuts ?? []) {
      expect(sc.url ?? "").toMatch(/^\/phil\//);
    }
  });
});
