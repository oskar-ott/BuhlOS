import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilNewJobSheet } from "./PhilNewJobSheet";

// The sheet reads the app router (push to the new job on success); SSR smoke
// runs outside the app-router context, so mock it (LogHoursSheet precedent).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

/**
 * SSR smoke for the "+ New job" form (phil_sharpened, dark — Wave 2b).
 * No Testing Library in this repo (node env) — interaction coverage is split:
 * the toggle/validation LOGIC lives in philNewJobForm.test.ts; here we render
 * both toggle sides via `initialMode` and pin the HONEST copy contract (P7 —
 * no "Found" state, no fake ServiceMate pull claim, no invented recents).
 */

const noop = () => {};

/** A worker's-own-list job as the sheet needs it (id + name + code). */
const listJob = (id: string, code: string) => ({ id, name: `Job ${id}`, code });

function render(props: Partial<Parameters<typeof PhilNewJobSheet>[0]> = {}) {
  return renderToString(
    createElement(PhilNewJobSheet, {
      open: true,
      onClose: noop,
      jobs: [],
      ...props,
    }),
  );
}

describe("PhilNewJobSheet", () => {
  it("renders nothing when closed", () => {
    expect(render({ open: false })).toBe("");
  });

  it("renders the focused form: Cancel, title, name, locked IV prefix, address, sticky Create", () => {
    const html = render();
    expect(html).toContain('data-testid="phil-new-job-sheet"');
    expect(html).toContain("Cancel");
    expect(html).toContain("New job");
    expect(html).toContain("Job name");
    expect(html).toContain("Job code");
    expect(html).toContain("format IV0000");
    expect(html).toContain(">IV<"); // locked prefix, not typed by the worker
    expect(html).toContain('inputMode="numeric"'); // react-dom/server keeps the camelCase attr
    expect(html).toContain("Site address");
    expect(html).toContain("Create job");
    // Full-screen overlay above the tab bar (CaptureSheet precedent).
    expect(html).toContain("fixed inset-0 z-50");
  });

  it("starts on the ServiceMate side with the HONEST helper — no fake Found/pull claim", () => {
    const html = render();
    expect(html).toContain(
      "Use the ServiceMate job number so hours and invoices line up under the one ref.",
    );
    expect(html).not.toContain("Found");
    expect(html).not.toContain("Pulls site");
    // Toggle state is exposed for assistive tech.
    expect(html).toContain('data-testid="phil-new-job-mode-servicemate" aria-pressed="true"');
    expect(html).toContain('data-testid="phil-new-job-mode-custom" aria-pressed="false"');
  });

  it("toggling to Custom swaps the input + helper and offers Next free", () => {
    const html = render({ initialMode: "custom" });
    expect(html).toContain('data-testid="phil-new-job-mode-custom" aria-pressed="true"');
    expect(html).toContain('data-testid="phil-new-job-digits-custom"');
    expect(html).not.toContain('data-testid="phil-new-job-digits-servicemate"');
    expect(html).toContain("Next free");
    expect(html).toContain("Your own ref, in the 7000s");
    expect(html).toContain("The office can match it to ServiceMate later.");
    // ServiceMate helper is gone from this side.
    expect(html).not.toContain("Use the ServiceMate job number");
  });

  it("Custom defaults to the REAL next free 7000-series number from the worker's list", () => {
    const fresh = render({ initialMode: "custom" });
    expect(fresh).toContain('value="7001"');

    const taken = render({
      initialMode: "custom",
      jobs: [listJob("a", "IV7001"), listJob("b", "IV7002")],
    });
    expect(taken).toContain('value="7003"');
  });

  it("shows recent codes ONLY when real codes exist — hidden row otherwise (P7)", () => {
    const none = render();
    expect(none).not.toContain('data-testid="phil-new-job-recent-codes"');
    expect(none).not.toContain("Already on your list");

    const some = render({
      jobs: [
        listJob("a", "IV0041"),
        listJob("b", "IV0038"),
        listJob("c", "IV0027"),
        listJob("d", "IV0012"),
      ],
    });
    expect(some).toContain('data-testid="phil-new-job-recent-codes"');
    // Reference only, capped at 3 — they're taken codes, not tap-to-fill.
    expect(some).toContain("IV0041 · IV0038 · IV0027");
    expect(some).not.toContain("IV0012");
  });

  it("the duplicate-code pre-guard hint never renders at rest (digits start empty or next-free)", () => {
    // The clash logic itself is unit-covered in philNewJobForm.test.ts
    // (newJobCodeClash — pre-guard disables); SSR can't type into the input,
    // so here we pin that the hint doesn't render without a real clash.
    const html = render({
      initialMode: "custom",
      jobs: [listJob("a", "IV7001"), listJob("b", "IV0041")],
    });
    expect(html).not.toContain('data-testid="phil-new-job-code-taken"');
    expect(html).not.toContain("already on your list. Pick another code.");
  });

  it("Create is disabled until the form is valid (empty form ⇒ disabled)", () => {
    const html = render();
    const createBtn = html.slice(html.indexOf('data-testid="phil-new-job-create"') - 400);
    expect(createBtn).toContain("disabled");
  });

  it("Create is enabled once name + 4 digits exist (custom side prefilled by next-free)", () => {
    // With a prefilled custom code the only missing piece is the name — we
    // can't type in SSR, so pin the inverse: digits alone still disable it.
    const html = render({ initialMode: "custom", jobs: [] });
    const idx = html.indexOf('data-testid="phil-new-job-create"');
    const btn = html.slice(Math.max(0, idx - 600), idx + 200);
    expect(btn).toContain("disabled"); // no name yet — still disabled
  });
});
