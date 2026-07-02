// Epic 5 — browser-side page-region cropping (client components only).
//
// There is no server-side image library; every reference crop (title block,
// legend symbol cell, schedule row strip) is cut out of the stored page PNG
// with a canvas in the browser. Best-effort by design: a CORS-tainted canvas,
// load failure, or oversize result returns null and callers fall back to a
// label-only / link-to-page experience — never a fake image.

import type { CropRegion } from "./schema";

export async function cropRegionFromPng(
  pngUrl: string,
  region: CropRegion,
  maxChars: number,
  minEdgePx = 32,
): Promise<string | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image load failed"));
      el.src = pngUrl;
    });
    const sx = Math.floor(img.naturalWidth * region.x);
    const sy = Math.floor(img.naturalHeight * region.y);
    const sw = Math.floor(img.naturalWidth * region.w);
    const sh = Math.floor(img.naturalHeight * region.h);
    if (sw < minEdgePx || sh < minEdgePx) return null;
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const dataUrl = canvas.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/") || dataUrl.length > maxChars) {
      return null;
    }
    return dataUrl;
  } catch {
    return null;
  }
}

/** Pad a normalised box for visual context, clamped to the page. */
export function padRegion(r: CropRegion, factor = 0.35): CropRegion {
  const px = r.w * factor;
  const py = r.h * factor;
  const x = Math.max(0, r.x - px);
  const y = Math.max(0, r.y - py);
  return {
    x,
    y,
    w: Math.min(1 - x, r.w + px * 2),
    h: Math.min(1 - y, r.h + py * 2),
  };
}
