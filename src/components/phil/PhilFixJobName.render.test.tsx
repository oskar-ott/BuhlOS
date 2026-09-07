import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilFixJobName } from "./PhilFixJobName";

// The sheet reads the app router (refresh after a confirmed save); SSR smoke
// runs outside the app-router context, so mock it (PhilNewJobSheet precedent).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

/**
 * SSR smoke for "Wrong job name? Fix it" (owner ruling 2026-08-31 — whoever
 * can add a job can fix its name). No Testing Library in this repo (node
 * env): closed state pins the quiet row; `defaultOpen` (the SiteCard test
 * hook) pins the sheet's copy + the disabled-at-rest Save contract. The PUT
 * permission contract lives in jobs-phil-create-api.test.ts.
 */

const job = { id: "job-1", name: "Norwod Depot" };

describe("PhilFixJobName", () => {
  it("at rest renders ONLY the quiet row — site voice, no sheet in the tree", () => {
    const html = renderToString(createElement(PhilFixJobName, { job }));
    expect(html).toContain('data-testid="phil-fix-job-name-open"');
    expect(html).toContain("Wrong job name? Fix it");
    expect(html).not.toContain('data-testid="phil-fix-job-name-sheet"');
  });

  it("open: full-screen sheet with the current name prefilled and honest helper copy", () => {
    const html = renderToString(createElement(PhilFixJobName, { job, defaultOpen: true }));
    expect(html).toContain('data-testid="phil-fix-job-name-sheet"');
    // Full-screen overlay above the tab bar (CaptureSheet precedent).
    expect(html).toContain("fixed inset-0 z-50");
    expect(html).toContain("Fix job name");
    expect(html).toContain("Cancel");
    // The input starts as the CURRENT name — fixing, not re-typing.
    expect(html).toContain('value="Norwod Depot"');
    expect(html).toContain("Changes it for everyone — the office sees the new name too.");
    expect(html).toContain("Save name");
  });

  it("Save is disabled while the name is unchanged (nothing to save)", () => {
    const html = renderToString(createElement(PhilFixJobName, { job, defaultOpen: true }));
    const idx = html.indexOf('data-testid="phil-fix-job-name-save"');
    const btn = html.slice(Math.max(0, idx - 600), idx + 200);
    expect(btn).toContain("disabled");
  });
});
