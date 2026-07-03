import { z } from "zod";
import { httpDelete, httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";
import {
  ClaimGearPayloadSchema,
  CreateGearAssetPayloadSchema,
  GearDetailResponseSchema,
  GearListResponseSchema,
  GearMutationResponseSchema,
  MarkGearGoodPayloadSchema,
  ReportGearPayloadSchema,
  ScanInfoResponseSchema,
  TransferGearPayloadSchema,
  UpdateGearAssetPayloadSchema,
} from "./schema";
import type {
  ClaimGearPayload,
  CreateGearAssetPayload,
  GearDetailResponse,
  GearListResponse,
  GearMutationResponse,
  MarkGearGoodPayload,
  ReportGearPayload,
  ScanInfoResponse,
  TransferGearPayload,
  UpdateGearAssetPayload,
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

/** #306: accept or decline a pending handover (receiver only, server-enforced). */
export function respondToTransfer(
  assetId: string,
  accept: boolean,
): Promise<HttpResult<GearMutationResponse>> {
  return httpPost<GearMutationResponse>(
    "/api/assets?action=transfer-response",
    { assetId, accept },
    { schema: GearMutationResponseSchema, init: { cache: "no-store", credentials: "same-origin" } },
  );
}

const HoldersResponseSchema = z.object({
  users: z.array(z.object({ id: z.string(), username: z.string() }).passthrough()),
});

/** Workmate directory for the handover picker (#306 widened the gate to field). */
export function listGearHolders(): Promise<
  HttpResult<{ users: Array<{ id: string; username: string }> }>
> {
  return httpGet("/api/users?action=listTradies", {
    schema: HoldersResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/** Edit asset metadata (#389). Admin-only server-side; holder changes are
 *  rejected by the endpoint (use transferGear). */
export function updateGearAsset(
  assetId: string,
  patch: UpdateGearAssetPayload,
): Promise<HttpResult<GearMutationResponse>> {
  const parsed = UpdateGearAssetPayloadSchema.safeParse(patch);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
  }
  return httpPut<GearMutationResponse>(
    `/api/assets?id=${encodeURIComponent(assetId)}`,
    parsed.data,
    { schema: GearMutationResponseSchema, init: { cache: "no-store", credentials: "same-origin" } },
  );
}

/** Soft-archive (#389) — record + history kept; register filter shows it under Retired. */
export function archiveGearAsset(assetId: string): Promise<HttpResult<GearMutationResponse>> {
  return httpDelete<GearMutationResponse>(`/api/assets?id=${encodeURIComponent(assetId)}`, {
    schema: GearMutationResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * Set or clear an asset's calibration due-date (#305). Admin-only
 * server-side (PUT /api/assets is the metadata-edit path; holder changes
 * stay on ?action=transfer). `null` clears — "not a calibrated instrument".
 */
export function setGearCalibrationDue(
  assetId: string,
  calibrationDue: string | null
): Promise<HttpResult<GearMutationResponse>> {
  return httpPut<GearMutationResponse>(
    `/api/assets?id=${encodeURIComponent(assetId)}`,
    { calibrationDue },
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

/**
 * #303 scan-to-claim. Claim an in-storage asset scanned from its QR label.
 * Server-gated: only assignable holder roles, only when the asset is in storage
 * (409 with a pointer to the request-transfer path otherwise), fresh-read race
 * guard. Writes a `{ from:null, to:me }` history row.
 */
export function claimGear(
  payload: ClaimGearPayload
): Promise<HttpResult<GearMutationResponse>> {
  const parsed = ClaimGearPayloadSchema.safeParse(payload);
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
  return httpPost<GearMutationResponse>("/api/assets?action=claim", parsed.data, {
    schema: GearMutationResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * #303 scan landing read. The summary-only view of a scanned asset — enough to
 * render it and pick the ONE right action, without the full detail/history
 * payload that the normal GET ?id= would 403 for a non-holder.
 */
export function getScanInfo(assetId: string): Promise<HttpResult<ScanInfoResponse>> {
  return httpPost<ScanInfoResponse>(
    "/api/assets?action=scan-info",
    { assetId },
    { schema: ScanInfoResponseSchema, init: { cache: "no-store", credentials: "same-origin" } },
  );
}

export const gearClient = {
  listGear,
  getGearDetail,
  createGearAsset,
  transferGear,
  reportGear,
  markGearGood,
  claimGear,
  getScanInfo,
} as const;
