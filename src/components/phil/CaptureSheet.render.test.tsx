import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CaptureSheet } from "./CaptureSheet";
import type { Job, JobStage } from "@/domains/jobs/types";

/**
 * CaptureSheet — worker-first capture shutter (v1 UX).
 *
 * Locks the v1 shape: photo-first, note optional, and the stage/area/task
 * context collapsed by default behind ONE optional row, so a fresh sheet reads
 * as "take a photo, done" — not a form. Also guards the test-sensitive
 * accessible names the Preview Smoke + Phase-D3 e2e depend on (the
 * `Capture evidence` dialog and the `Take a photo` affordance), and that no
 * admin / office / compliance language leaks into the field UI.
 *
 * Node-env SSR render (no jsdom) — matches the repo's *.render.test.tsx style.
 * The default render reflects the collapsed (initial useState) state, which is
 * exactly the worker-first behaviour we want to pin.
 */

const job = {
  id: "job-1",
  name: "Birdwood IV3232",
  status: "active",
  areaGroups: [
    {
      id: "g1",
      name: "Ground floor",
      areas: [
        { id: "a1", name: "Kitchen" },
        { id: "a2", name: "Laundry" },
      ],
    },
  ],
} as unknown as Job;

function render(initialContext?: { stage?: JobStage | null; areaId?: string | null }) {
  return renderToString(
    createElement(CaptureSheet, {
      open: true,
      job,
      initialContext,
      onClose: () => {},
      onCaptured: () => {},
    }),
  );
}

describe("CaptureSheet — worker-first shutter", () => {
  it("leads with the photo and keeps the dialog's test-sensitive names", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    // Dialog accessible name + header — smoke + phase-d3 e2e match /Capture evidence/.
    expect(html).toContain("Capture evidence");
    // Photo-first affordance — smoke asserts this is visible on open.
    expect(html).toContain("Take a photo");
  });

  it("keeps the note clearly optional and the submit/cancel actions present", () => {
    const html = render();
    expect(html).toContain("Note");
    expect(html).toContain("(optional)");
    expect(html).toContain("Submit");
    expect(html).toContain("Cancel");
  });

  it("is honest that flash + zoom are OS-camera-owned, and shows no low-light hint without a measured photo (#148)", () => {
    const html = render();
    // We add no in-app flash/zoom controls — one honest worker-voice line says
    // they live on the camera (AC: no dead controls).
    expect(html).toContain("Flash and zoom are on your camera.");
    // The low-light hint is gated on a measured photo (client-only resize), so
    // a fresh SSR sheet never shows a dishonest "bit dark" on no photo.
    expect(html).not.toContain("Bit dark");
  });

  it("keeps the test-sensitive dialog name + header byte-identical with dictation wired in (#147)", () => {
    const html = render();
    // The dialog accessible name MUST stay exactly this string — the Preview
    // Smoke + Phase-D3 e2e match on it, and the #147 mic must not perturb it.
    expect(html).toContain('aria-label="Capture evidence"');
    expect(html).toContain("Capture evidence");
    // The note field the mic appends into is still present (maxLength cap intact
    // so dictation can never push the note past the server-validated limit).
    expect(html).toContain('id="capture-note"');
    expect(html).toContain('maxLength="280"');
    // The mic is a client-only control (device mode resolves after mount), so it
    // correctly paints nothing under SSR — typed input is never blocked on it,
    // and no dishonest "no audio leaves the device" claim sneaks in.
    expect(html.toLowerCase()).not.toContain("no audio");
  });

  it("collapses stage/area/task behind one optional row by default (not a form)", () => {
    const html = render();
    // The single optional disclosure is present...
    expect(html).toContain("Add area or stage");
    // ...and the full area picker list is NOT rendered until the worker opens
    // it, so a fresh sheet is photo + note + one line — never a wall of fields.
    expect(html).not.toContain("Kitchen");
    expect(html).not.toContain("Laundry");
  });

  it("shows carried-in context as an honest summary without expanding the list", () => {
    const html = render({ stage: "roughIn", areaId: "a1" });
    // The stage + area that carried in from the job page are shown plainly, so
    // nothing the capture will attach is hidden from the worker...
    expect(html).toContain("Rough-in");
    expect(html).toContain("Kitchen");
    // ...but the other areas stay collapsed — it's a summary, not the open list.
    expect(html).not.toContain("Laundry");
  });

  it("uses plain field language — no admin / office / compliance framing", () => {
    const html = render().toLowerCase();
    for (const banned of [
      "admin",
      "payroll",
      "xero",
      "compliance",
      "approve",
      "timesheet",
      "dashboard",
    ]) {
      expect(html).not.toContain(banned);
    }
  });
});
