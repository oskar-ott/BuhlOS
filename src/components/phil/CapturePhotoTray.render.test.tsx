import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CapturePhotoTray, type TrayPhoto } from "./CapturePhotoTray";
import { LOW_LIGHT_LUMA_THRESHOLD } from "@/domains/evidence/luma";

/**
 * CapturePhotoTray — the multi-photo capture tray.
 *
 * Pins the #148 NON-BLOCKING low-light hint: a ready tile whose measured
 * avgLuma is below the cutoff shows "Bit dark — try the flash", while a
 * normally-exposed tile shows nothing. The hint is copy only — the tile, the
 * remove control, and the "Add photo" affordance are all still rendered, so it
 * never gates capture (Phil constitution P10). SSR render (no jsdom) matches the
 * repo's *.render.test.tsx style.
 */

function tile(over: Partial<TrayPhoto>): TrayPhoto {
  return {
    id: "tp_1",
    file: new File(["x"], "shot.jpg", { type: "image/jpeg" }),
    dataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    status: "ready",
    ...over,
  };
}

function render(photos: TrayPhoto[]) {
  return renderToString(
    createElement(CapturePhotoTray, {
      photos,
      max: 10,
      busy: false,
      onAdd: () => {},
      onRemove: () => {},
    }),
  );
}

describe("CapturePhotoTray — low-light hint (#148)", () => {
  it("shows the hint on a dark ready tile", () => {
    const html = render([tile({ avgLuma: LOW_LIGHT_LUMA_THRESHOLD - 20 })]);
    expect(html).toContain("Bit dark — try the flash");
  });

  it("does NOT show the hint on a normally-exposed tile", () => {
    const html = render([tile({ avgLuma: 180 })]);
    expect(html).not.toContain("Bit dark");
  });

  it("does NOT guess: no hint when avgLuma was never measured", () => {
    const html = render([tile({ avgLuma: undefined })]);
    expect(html).not.toContain("Bit dark");
  });

  it("is non-blocking: a dark tile still keeps its remove control and the Add affordance", () => {
    const html = render([tile({ avgLuma: 5 })]);
    // The hint is present...
    expect(html).toContain("Bit dark — try the flash");
    // ...but the photo is still there and removable, and the worker can keep
    // shooting — nothing is disabled by the hint.
    expect(html).toContain("Remove photo");
    expect(html).toContain("Add photo");
  });

  it("never shows the hint on a failed tile (no false dark on a decode failure)", () => {
    const html = render([
      tile({ status: "failed", dataUrl: null, error: "Photo could not be read", avgLuma: undefined }),
    ]);
    expect(html).toContain("Photo could not be read");
    expect(html).not.toContain("Bit dark");
  });
});
