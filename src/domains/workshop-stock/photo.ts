import { resizeImageWithMeta } from "@/domains/evidence/service";
import { isLowLight } from "@/domains/evidence/luma";

/**
 * Prepare a product photo on the phone before it is sent (Workshop Stock).
 *
 * Reuses the capture path's decoder (createImageBitmap honours the photo's
 * orientation; the canvas re-encode drops EXIF incl. GPS) at the receipt
 * reader's label-legible settings — ≤1600 px, JPEG 0.8 — so a label stays
 * readable while the upload stays well under the server's 3 MB cap.
 *
 * A file the browser can't decode (a HEIC on a browser without HEIC support, a
 * corrupt file, a non-image) is an honest error, not a silent drop.
 *
 * A small copy (≤ 320 px) is made alongside for lists, so a long list never
 * downloads every full-size label shot; if it can't be made, lists fall back
 * to the photo itself.
 */

export const MAX_DIM = 1600;
export const QUALITY = 0.8;
export const THUMB_DIM = 320;
const THUMB_QUALITY = 0.7;

export type PreparedPhoto =
  | { ok: true; dataUrl: string; thumbDataUrl: string | null; dark: boolean }
  | { ok: false; reason: "not_image" | "cannot_open" | "too_large" };

export async function preparePhoto(file: File | Blob): Promise<PreparedPhoto> {
  const type = (file as File).type || "";
  if (type && !type.startsWith("image/")) return { ok: false, reason: "not_image" };
  try {
    const { dataUrl, avgLuma } = await resizeImageWithMeta(file, MAX_DIM, QUALITY);
    // base64 is ~4/3 of the bytes; stay well below the server cap (3 MB)
    if (dataUrl.length > 3_900_000) return { ok: false, reason: "too_large" };
    let thumbDataUrl: string | null = null;
    try {
      thumbDataUrl = (await resizeImageWithMeta(file, THUMB_DIM, THUMB_QUALITY)).dataUrl;
      if (thumbDataUrl.length > 260_000) thumbDataUrl = null; // the server takes ≤ 200 KB
    } catch {
      thumbDataUrl = null;
    }
    return { ok: true, dataUrl, thumbDataUrl, dark: isLowLight(avgLuma) };
  } catch {
    return { ok: false, reason: "cannot_open" };
  }
}

export const PHOTO_PROBLEM_COPY: Record<"not_image" | "cannot_open" | "too_large", string> = {
  not_image: "That isn't a photo. Take a photo or pick one from your library.",
  cannot_open: "Couldn't open that photo on this phone. Take it again with the camera, or pick a JPEG.",
  too_large: "That photo is too big. Take it again a bit further back.",
};
