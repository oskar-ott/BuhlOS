import { describe, expect, it } from "vitest";
import {
  CreateServiceLocationPayloadSchema,
  SERVICE_LOCATION_DESCRIPTION_MAX,
  SERVICE_LOCATION_LABEL_MAX,
  SERVICE_LOCATION_PHOTO_MAX,
  ServiceLocationListResponseSchema,
  ServiceLocationRecordSchema,
} from "./schema";
import { denormalisePhoto, validateInput } from "./service";
import { displayHeading, hasServices, sortForDisplay, typeLabel } from "./format";
import type { ServiceLocationRecord } from "./types";

/* ----------------------------------------------------------------------
 * Schema — closed enum + caps + record/list shape
 * -------------------------------------------------------------------- */

const validRecord: ServiceLocationRecord = {
  id: "sl_abc",
  type: "switchboard",
  label: "Main board",
  description: "In the garage behind the roller door.",
  photos: [
    { evidenceId: "ev_1", photoUrl: "https://blob/x.jpg", thumbnailUrl: null, photoId: "p_1", capturedByName: "Sam" },
  ],
  createdBy: "Sam",
  createdById: "u_1",
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedBy: "Sam",
  updatedById: "u_1",
  updatedAt: "2026-06-28T00:00:00.000Z",
};

describe("ServiceLocationRecordSchema", () => {
  it("accepts a fully populated record", () => {
    expect(ServiceLocationRecordSchema.safeParse(validRecord).success).toBe(true);
  });

  it("accepts a text-only record (no photos)", () => {
    expect(
      ServiceLocationRecordSchema.safeParse({ ...validRecord, photos: [] }).success,
    ).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(
      ServiceLocationRecordSchema.safeParse({ ...validRecord, type: "transformer" }).success,
    ).toBe(false);
  });

  it("requires a description (the whole point of the record)", () => {
    const broken = { ...validRecord } as Record<string, unknown>;
    delete broken.description;
    expect(ServiceLocationRecordSchema.safeParse(broken).success).toBe(false);
  });

  it("passes through unknown forward-compat fields (.passthrough)", () => {
    const future = { ...validRecord, areaId: "ar_1" };
    const parsed = ServiceLocationRecordSchema.safeParse(future);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { areaId?: string }).areaId).toBe("ar_1");
    }
  });
});

describe("ServiceLocationListResponseSchema", () => {
  it("parses an empty list", () => {
    expect(ServiceLocationListResponseSchema.safeParse({ locations: [] }).success).toBe(true);
  });
  it("parses a populated list", () => {
    expect(
      ServiceLocationListResponseSchema.safeParse({ locations: [validRecord] }).success,
    ).toBe(true);
  });
});

describe("CreateServiceLocationPayloadSchema", () => {
  it("accepts the minimal text-only create (type + description)", () => {
    expect(
      CreateServiceLocationPayloadSchema.safeParse({
        type: "meter",
        description: "Front fence, left of the gate.",
      }).success,
    ).toBe(true);
  });

  it("rejects a blank description", () => {
    expect(
      CreateServiceLocationPayloadSchema.safeParse({ type: "meter", description: "   " }).success,
    ).toBe(false);
  });

  it("rejects a description over the cap", () => {
    expect(
      CreateServiceLocationPayloadSchema.safeParse({
        type: "pit",
        description: "x".repeat(SERVICE_LOCATION_DESCRIPTION_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it("rejects a label over the cap", () => {
    expect(
      CreateServiceLocationPayloadSchema.safeParse({
        type: "pit",
        label: "x".repeat(SERVICE_LOCATION_LABEL_MAX + 1),
        description: "ok",
      }).success,
    ).toBe(false);
  });

  it("rejects more than the photo cap of evidenceIds", () => {
    expect(
      CreateServiceLocationPayloadSchema.safeParse({
        type: "pit",
        description: "ok",
        evidenceIds: Array.from({ length: SERVICE_LOCATION_PHOTO_MAX + 1 }, (_, i) => `ev_${i}`),
      }).success,
    ).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * service.ts — validateInput + denormalisePhoto
 * -------------------------------------------------------------------- */

describe("validateInput", () => {
  it("normalises a valid create (trims + dedupes evidenceIds)", () => {
    const r = validateInput({
      type: "switchboard",
      label: "  Main board  ",
      description: "  In the garage.  ",
      evidenceIds: ["ev_1", "ev_1", "ev_2"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.label).toBe("Main board");
      expect(r.value.description).toBe("In the garage.");
      expect(r.value.evidenceIds).toEqual(["ev_1", "ev_2"]);
    }
  });

  it("rejects an unknown type", () => {
    const r = validateInput({ type: "nope", description: "x" });
    expect(r.ok).toBe(false);
  });

  it("rejects a blank description on create", () => {
    const r = validateInput({ type: "meter", description: "   " });
    expect(r.ok).toBe(false);
  });

  it("treats an empty label as null (falls back to the type label)", () => {
    const r = validateInput({ type: "meter", label: "   ", description: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.label).toBeNull();
  });

  it("allows an update that omits description (requireDescription: false)", () => {
    const r = validateInput({ type: "meter" }, { requireDescription: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.description).toBe("");
  });

  it("still rejects a present-but-blank description on update", () => {
    const r = validateInput({ type: "meter", description: "  " }, { requireDescription: false });
    expect(r.ok).toBe(false);
  });

  it("caps evidenceIds at the photo max", () => {
    const r = validateInput({
      type: "pit",
      description: "x",
      evidenceIds: Array.from({ length: SERVICE_LOCATION_PHOTO_MAX + 1 }, (_, i) => `ev_${i}`),
    });
    expect(r.ok).toBe(false);
  });
});

describe("denormalisePhoto", () => {
  it("copies the display fields off an evidence item", () => {
    const photo = denormalisePhoto({
      id: "ev_9",
      kind: "photo",
      photoId: "p_9",
      photoUrl: "https://blob/board.jpg",
      thumbnailUrl: "https://blob/board-thumb.jpg",
      capturedByName: "Dana",
    });
    expect(photo).toEqual({
      evidenceId: "ev_9",
      photoUrl: "https://blob/board.jpg",
      thumbnailUrl: "https://blob/board-thumb.jpg",
      photoId: "p_9",
      capturedByName: "Dana",
    });
  });

  it("returns null for a note-only evidence row (no photoUrl)", () => {
    expect(denormalisePhoto({ id: "ev_note", kind: "note", note: "hi" } as never)).toBeNull();
    expect(denormalisePhoto({ id: "ev_blank", photoUrl: "   " })).toBeNull();
  });
});

/* ----------------------------------------------------------------------
 * format.ts — typeLabel / displayHeading / hasServices / sortForDisplay
 * -------------------------------------------------------------------- */

describe("format helpers", () => {
  it("typeLabel uses site language", () => {
    expect(typeLabel("switchboard")).toBe("Main switchboard");
    expect(typeLabel("tempSupply")).toBe("Temp supply");
    expect(typeLabel("meter")).toBe("Meter");
  });

  it("displayHeading prefers the worker's label, else the type label", () => {
    expect(displayHeading({ type: "meter", label: "Smart meter" })).toBe("Smart meter");
    expect(displayHeading({ type: "meter", label: "  " })).toBe("Meter");
    expect(displayHeading({ type: "pit", label: null })).toBe("Pit");
  });

  it("hasServices reflects whether the job has any record", () => {
    expect(hasServices([])).toBe(false);
    expect(hasServices([validRecord])).toBe(true);
  });

  it("sortForDisplay groups by site order then newest-first, without mutating", () => {
    const board: ServiceLocationRecord = { ...validRecord, id: "a", type: "switchboard", createdAt: "2026-01-01" };
    const meter: ServiceLocationRecord = { ...validRecord, id: "b", type: "meter", createdAt: "2026-01-01" };
    const pitOld: ServiceLocationRecord = { ...validRecord, id: "c", type: "pit", createdAt: "2026-01-01" };
    const pitNew: ServiceLocationRecord = { ...validRecord, id: "d", type: "pit", createdAt: "2026-02-01" };
    const input = [pitOld, meter, board, pitNew];
    const out = sortForDisplay(input);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "d", "c"]);
    // input untouched
    expect(input.map((r) => r.id)).toEqual(["c", "b", "a", "d"]);
  });
});
