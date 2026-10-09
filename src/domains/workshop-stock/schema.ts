import { z } from "zod";

/**
 * Workshop Stock — response shapes from /api/workshop-stock (api/workshop-stock.js).
 *
 * Quantities are integer thousandths of the item's base unit (`*Milli`) — the
 * server parses and stores them exactly; the client only formats them.
 */

export const UNIT_KEYS = ["each", "metre", "length", "bag", "box", "roll", "pack"] as const;
export type StockUnit = (typeof UNIT_KEYS)[number];
export const PACK_UNITS = ["box", "pack", "bag", "roll", "length", "carton", "coil", "reel"] as const;
export type PackUnit = (typeof PACK_UNITS)[number];

export const VERIFICATION_STATUSES = ["manufacturer_code_matched", "possible_match", "unverified"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const IdentifierSchema = z.object({
  id: z.string(),
  kind: z.enum(["manufacturer_code", "supplier_sku", "barcode"]),
  value: z.string(),
  valueKey: z.string(),
  scope: z.string(),
  packUnit: z.string().nullable(),
  packSizeMilli: z.number().nullable(),
});
export type StockIdentifier = z.infer<typeof IdentifierSchema>;

export const VerificationSchema = z
  .object({
    provider: z.string().nullable().optional(),
    checkedAt: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
    sourceTitle: z.string().nullable().optional(),
    sourceDomain: z.string().nullable().optional(),
    sourceKind: z.string().nullable().optional(),
    evidence: z.string().nullable().optional(),
    codeAsWritten: z.string().nullable().optional(),
    productName: z.string().nullable().optional(),
    reasons: z.array(z.string()).optional(),
  })
  .passthrough();

export const StockItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  manufacturerCode: z.string().nullable(),
  supplierSku: z.string().nullable(),
  supplierName: z.string().nullable(),
  variant: z.string().nullable(),
  colourFinish: z.string().nullable(),
  baseUnit: z.enum(UNIT_KEYS),
  location: z.string().nullable(),
  photoId: z.string().nullable(),
  defaultPack: z.object({ unit: z.string(), sizeMilli: z.number() }).nullable(),
  balanceMilli: z.number(),
  estimated: z.boolean(),
  version: z.number(),
  metaRevision: z.number(),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  verification: VerificationSchema.nullable(),
  lastMovementAt: z.string().nullable(),
  lastCountedAt: z.string().nullable(),
  lastCountedByName: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  createdByName: z.string().nullable(),
  updatedAt: z.string().nullable(),
  identifiers: z.array(IdentifierSchema),
});
export type StockItem = z.infer<typeof StockItemSchema>;

export const MOVEMENT_KINDS = ["opening", "add", "take", "return", "count", "reversal"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export const UndoInfoSchema = z.object({
  allowed: z.boolean(),
  until: z.string().nullable().optional(),
  needsReason: z.boolean().optional(),
});

export const MovementSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  kind: z.enum(MOVEMENT_KINDS),
  quantityMilli: z.number(),
  balanceAfterMilli: z.number(),
  itemVersionAfter: z.number(),
  countedMilli: z.number().nullable(),
  pack: z.object({ count: z.number(), unit: z.string().nullable(), sizeMilli: z.number() }).nullable(),
  estimated: z.boolean(),
  jobId: z.string().nullable(),
  jobLabel: z.string().nullable(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  reversesMovementId: z.string().nullable(),
  actorId: z.string(),
  actorName: z.string().nullable(),
  createdAt: z.string().nullable(),
  reversedBy: z
    .object({ id: z.string(), actorId: z.string(), actorName: z.string().nullable(), at: z.string().nullable(), reason: z.string().nullable() })
    .nullable(),
  /** A later count (still standing) absorbed this movement, so it can't be undone. */
  countedSince: z.boolean().optional(),
  undo: UndoInfoSchema.optional(),
  itemName: z.string().optional(),
  itemUnit: z.string().optional(),
});
export type StockMovement = z.infer<typeof MovementSchema>;

export const StockListSchema = z.object({
  items: z.array(StockItemSchema),
  viewer: z.object({ id: z.string(), office: z.boolean() }),
  capabilities: z.object({ photoRead: z.boolean(), lookup: z.boolean() }),
  undoMinutes: z.number(),
  asOf: z.string(),
});
export type StockList = z.infer<typeof StockListSchema>;

export const ItemEventSchema = z.object({
  id: z.string(),
  event: z.string(),
  detail: z.record(z.unknown()),
  actorId: z.string(),
  actorName: z.string().nullable(),
  at: z.string().nullable(),
});
export type ItemEvent = z.infer<typeof ItemEventSchema>;

export const ItemDetailSchema = z.object({
  item: StockItemSchema,
  movements: z.array(MovementSchema),
  events: z.array(ItemEventSchema).nullable(),
  undoMinutes: z.number(),
});
export type ItemDetail = z.infer<typeof ItemDetailSchema>;

export const RecentSchema = z.object({ movements: z.array(MovementSchema), undoMinutes: z.number() });

export const WriteResultSchema = z.object({
  item: StockItemSchema,
  movement: MovementSchema,
  replayed: z.boolean().optional(),
  photoAttached: z.boolean().optional(),
});
export type WriteResult = z.infer<typeof WriteResultSchema>;

export const OperationSchema = z.object({
  found: z.boolean(),
  movement: MovementSchema.optional(),
  item: StockItemSchema.optional(),
});

export const ItemOnlySchema = z.object({ item: StockItemSchema, unchanged: z.boolean().optional() });

/** One product as read from a photo — image-derived, never confirmed. */
export const ReadProductSchema = z.object({
  brand: z.string().nullable(),
  manufacturerCode: z.string().nullable(),
  supplierSku: z.string().nullable(),
  supplierName: z.string().nullable(),
  description: z.string().nullable(),
  colourFinish: z.string().nullable(),
  variantDetails: z.array(z.string()),
  barcode: z.string().nullable(),
  packQuantity: z.number().nullable(),
  packUnit: z.string().nullable(),
  labelText: z.array(z.string()),
  position: z.string().nullable(),
});
export type ReadProduct = z.infer<typeof ReadProductSchema>;

export const MatchCandidateSchema = z.object({
  itemId: z.string(),
  evidence: z.enum(["barcode", "manufacturer_code", "supplier_sku", "code_punctuation", "cross_kind", "description"]),
  strength: z.number(),
  matchedValue: z.string().nullable(),
  identifierId: z.string().nullable(),
  conflicts: z.array(z.object({ field: z.string(), wanted: z.unknown(), found: z.unknown() })),
  notes: z.array(z.string()),
  score: z.number().optional(),
});
export type MatchCandidate = z.infer<typeof MatchCandidateSchema>;

export const CandidateItemSchema = StockItemSchema.pick({
  id: true, name: true, brand: true, manufacturerCode: true, supplierSku: true, supplierName: true, variant: true,
  colourFinish: true, location: true, baseUnit: true, balanceMilli: true, estimated: true, version: true, photoId: true,
  defaultPack: true, identifiers: true,
});
export type CandidateItem = z.infer<typeof CandidateItemSchema>;

export const READ_STATUSES = ["ok", "not_configured", "daily_limit", "unreadable", "unavailable"] as const;
export type ReadStatus = (typeof READ_STATUSES)[number];

export const ReadPhotoSchema = z.object({
  readStatus: z.enum(READ_STATUSES),
  reading: z.object({ legibility: z.enum(["clear", "partial", "unreadable"]), note: z.string().nullable(), products: z.array(ReadProductSchema) }).nullable(),
  matches: z.array(z.object({ productIndex: z.number(), outcome: z.enum(["exact", "candidates", "none"]), candidates: z.array(MatchCandidateSchema) })),
  candidateItems: z.array(CandidateItemSchema),
  photoId: z.string().nullable(),
  photoStored: z.boolean().nullable(),
});
export type ReadPhotoResult = z.infer<typeof ReadPhotoSchema>;

export const LOOKUP_STATUSES = ["manufacturer_code_matched", "possible_match", "no_match", "unavailable", "not_configured", "not_checked"] as const;
export type LookupStatus = (typeof LOOKUP_STATUSES)[number];

export const LookupResultSchema = z
  .object({
    status: z.enum(LOOKUP_STATUSES),
    reasons: z.array(z.string()).default([]),
    candidate: z
      .object({
        name: z.string().nullable().optional(),
        brand: z.string().nullable().optional(),
        code: z.string().nullable().optional(),
        colour: z.string().nullable().optional(),
        imageUrl: z.string().nullable().optional(),
        sourceUrl: z.string().nullable().optional(),
        sourceTitle: z.string().nullable().optional(),
        sourceDomain: z.string().nullable().optional(),
        sourceKind: z.string().nullable().optional(),
        evidence: z.string().nullable().optional(),
        codeAsWritten: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .default(null),
    conflicts: z.array(z.object({ field: z.string(), wanted: z.unknown(), found: z.unknown() })).optional(),
    unconfirmed: z.array(z.string()).optional(),
    sources: z.array(z.object({ url: z.string(), title: z.string().nullable().optional(), domain: z.string(), kind: z.string(), opened: z.boolean(), verdict: z.string(), error: z.string().nullable().optional() })).default([]),
    checkedAt: z.string().optional(),
    cached: z.boolean().optional(),
  })
  .passthrough();
export type LookupResult = z.infer<typeof LookupResultSchema>;

export const JobPickerSchema = z.object({
  jobs: z.array(z.object({ id: z.string(), name: z.string(), code: z.string().nullable(), status: z.string() })),
});
export type JobOption = z.infer<typeof JobPickerSchema>["jobs"][number];
