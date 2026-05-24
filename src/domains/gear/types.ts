import type { z } from "zod";
import type {
  GearAssetSchema,
  GearAssetStatusSchema,
  GearAssetConditionSchema,
  GearAssetTypeSchema,
  GearHistoryEntrySchema,
  GearHistoryKindSchema,
  GearListResponseSchema,
  GearDetailResponseSchema,
  CreateGearAssetPayloadSchema,
  TransferGearPayloadSchema,
  ReportGearPayloadSchema,
  ReportKindSchema,
  MarkGearGoodPayloadSchema,
  GearMutationResponseSchema,
} from "./schema";

/**
 * Phase C gear entity types.
 *
 * Wire shape mirrors api/assets.js verbatim — the legacy endpoint is consumed
 * unchanged for list / single / create / transfer. The one Phase C addition
 * is the `?action=report` action used by `submitReport` in client.ts; the
 * server-side handler lives in api/assets.js alongside the existing actions.
 *
 * Status (`GearAssetStatus`) is a derived enum computed in service.ts from
 * the legacy storage fields (`currentHolderId`, `condition`, `archived`).
 * The wire row does NOT carry a `status` column — derivation keeps the
 * legacy admin/assets.html consumer working.
 *
 * Cross-ref:
 *   docs/rebuild-audit/12-domain-model-deep-dive.md §Gear
 *   docs/rebuild-audit/13-ui-information-architecture.md §Tab Gear / §Section Gear
 *   api/assets.js
 */

export type GearAssetType = z.infer<typeof GearAssetTypeSchema>;
export type GearAssetStatus = z.infer<typeof GearAssetStatusSchema>;
export type GearAssetCondition = z.infer<typeof GearAssetConditionSchema>;

export type GearAsset = z.infer<typeof GearAssetSchema>;

export type GearHistoryKind = z.infer<typeof GearHistoryKindSchema>;
export type GearHistoryEntry = z.infer<typeof GearHistoryEntrySchema>;

export type ReportKind = z.infer<typeof ReportKindSchema>;

export type CreateGearAssetPayload = z.infer<typeof CreateGearAssetPayloadSchema>;
export type TransferGearPayload = z.infer<typeof TransferGearPayloadSchema>;
export type ReportGearPayload = z.infer<typeof ReportGearPayloadSchema>;
export type MarkGearGoodPayload = z.infer<typeof MarkGearGoodPayloadSchema>;

export type GearListResponse = z.infer<typeof GearListResponseSchema>;
export type GearDetailResponse = z.infer<typeof GearDetailResponseSchema>;
export type GearMutationResponse = z.infer<typeof GearMutationResponseSchema>;

/**
 * A "transferable user" — a worker who can hold gear. Admin sees these in
 * the assignment picker; Phil never sees this list. Shape mirrors the
 * subset of `users.json` that /api/users?action=listTradies returns.
 */
export interface GearHolderUser {
  id: string;
  username: string;
  role: "tradie" | "leadingHand" | "apprentice" | "labourer" | "electrician" | string;
}
