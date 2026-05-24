import { httpGet, httpPost, type HttpResult } from "@/lib/http";
import {
  CreateGearAssetPayloadSchema,
  GearDetailResponseSchema,
  GearListResponseSchema,
  GearMutationResponseSchema,
  MarkGearGoodPayloadSchema,
  ReportGearPayloadSchema,
  TransferGearPayloadSchema,
} from "./schema";
import type {
  CreateGearAssetPayload,
  GearDetailResponse,
  GearListResponse,
  GearMutationResponse,
  MarkGearGoodPayload,
  ReportGearPayload,
  TransferGearPayload,
} from "./types";

/**
 * Typed wrapper around /api/assets (legacy endpoint) + the Phase C
 * `?action=report` action added in api/assets.js. Every call returns an
 * HttpResult so callers can branch on success vs typed failure without
 * throws.
 *
 * Endpoints consumed:
 *   GET   /api/assets                       → list visible assets (admin = all; worker = own held)
 *   GET   /api/assets?archived=1            → include archived/retired
 *   GET   /api/assets?id=<id>               → asset + history
 *   POST  /api/assets                       → create (admin only)
 *   POST  /api/assets?action=transfer       → assign / return
 *   POST  /api/assets?action=report         → check / damaged / missing (Phase C addition)
 *
 * Permissions are enforced server-side in api/assets.js:
 *   - admin: everything
 *   - leadingHand / tradie / apprentice / labourer / electrician:
 *     list/transfer/report only on assets they currently hold
 *   - client: 403 everywhere
 *
 * Cross-ref:
 *   docs/rebuild-audit/19-phase-b-hours-implementation-brief.md §API
 *      (Phase B pattern for typed clients over legacy endpoints)
 *   api/assets.js
 */

interface ListGearOptions {
  /** Include archived/retired assets in the response. Admin register only. */
  includeArchived?: boolean;
}

export function listGear(
  options: ListGearOptions = {}
): Promise<HttpResult<GearListResponse>> {
  const url = options.includeArchived ? "/api/assets?archived=1" : "/api/assets";
  return httpGet<GearListResponse>(url, {
    schema: GearListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function getGearDetail(assetId: string): Promise<HttpResult<GearDetailResponse>> {
  return httpGet<GearDetailResponse>(
    `/api/assets?id=${encodeURIComponent(assetId)}`,
    {
      schema: GearDetailResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

export function createGearAsset(
  payload: CreateGearAssetPayload
): Promise<HttpResult<GearMutationResponse>> {
  const parsed = CreateGearAssetPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.format(),
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
  }
  return httpPost<GearMutationResponse>("/api/assets", parsed.data, {
    schema: GearMutationResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function transferGear(
  payload: TransferGearPayload
): Promise<HttpResult<GearMutationResponse>> {
  const parsed = TransferGearPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.format(),
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
  }
  return httpPost<GearMutationResponse>(
    "/api/assets?action=transfer",
    parsed.data,
    {
      schema: GearMutationResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

/**
 * The Phase C `?action=report` addition. Records a worker's possession
 * confirmation (`check`) or condition report (`damaged` / `missing`). The
 * server appends a history entry with the corresponding `kind` and, for
 * `damaged` / `missing`, updates the asset's `condition` field.
 */
export function reportGear(
  payload: ReportGearPayload
): Promise<HttpResult<GearMutationResponse>> {
  const parsed = ReportGearPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.format(),
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
  }
  return httpPost<GearMutationResponse>(
    "/api/assets?action=report",
    parsed.data,
    {
      schema: GearMutationResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

/**
 * The Phase C hardening `?action=mark-good` addition. Admin-only — clears
 * a damaged or missing condition back to `good` after an asset has been
 * repaired or recovered. Logs a `kind: 'admin_updated'` history entry so
 * the admin reset is distinguishable from a worker report.
 */
export function markGearGood(
  payload: MarkGearGoodPayload
): Promise<HttpResult<GearMutationResponse>> {
  const parsed = MarkGearGoodPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.format(),
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
  }
  return httpPost<GearMutationResponse>(
    "/api/assets?action=mark-good",
    parsed.data,
    {
      schema: GearMutationResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

export const gearClient = {
  listGear,
  getGearDetail,
  createGearAsset,
  transferGear,
  reportGear,
  markGearGood,
} as const;
