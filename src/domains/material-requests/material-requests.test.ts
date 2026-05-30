import { describe, expect, it } from "vitest";
import {
  CreateMaterialRequestPayloadSchema,
  MaterialRequestItemSchema,
  UpdateMaterialRequestPayloadSchema,
} from "./schema";
import {
  canTransition,
  compareForInbox,
  isOpenRequest,
  summariseInbox,
} from "./service";
import { formatQuantity, statusLabel, statusTone, urgencyLabel, urgencyTone } from "./format";
import type { MaterialRequestItem } from "./types";

function mr(over: Partial<MaterialRequestItem> & { id: string }): MaterialRequestItem {
  return {
    jobId: "job-1",
    item: "25mm conduit",
    quantity: 20,
    unit: "m",
    status: "requested",
    urgency: "normal",
    source: "observation",
    requestedById: "u_field",
    requestedByName: "Sparky",
    requestedAt: "2026-05-29T00:00:00.000Z",
    auditLogIds: [],
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...over,
  } as MaterialRequestItem;
}

describe("canTransition", () => {
  it("allows the happy path requested → approved → ordered → delivered", () => {
    expect(canTransition(null, "requested")).toBe(true);
    expect(canTransition("requested", "approved")).toBe(true);
    expect(canTransition("approved", "ordered")).toBe(true);
    expect(canTransition("ordered", "delivered")).toBe(true);
  });
  it("allows common shortcuts", () => {
    expect(canTransition("requested", "ordered")).toBe(true);
    expect(canTransition("delivered", "ordered")).toBe(true);
    expect(canTransition("approved", "requested")).toBe(true);
  });
  it("allows cancel from any open state", () => {
    expect(canTransition("requested", "cancelled")).toBe(true);
    expect(canTransition("approved", "cancelled")).toBe(true);
    expect(canTransition("ordered", "cancelled")).toBe(true);
  });
  it("forbids backwards / illegal jumps", () => {
    expect(canTransition("delivered", "requested")).toBe(false);
    expect(canTransition("cancelled", "requested")).toBe(false);
    expect(canTransition("ordered", "approved")).toBe(false);
  });
});

describe("isOpenRequest", () => {
  it("requested / approved / ordered are open; delivered + cancelled are closed", () => {
    expect(isOpenRequest("requested")).toBe(true);
    expect(isOpenRequest("approved")).toBe(true);
    expect(isOpenRequest("ordered")).toBe(true);
    expect(isOpenRequest("delivered")).toBe(false);
    expect(isOpenRequest("cancelled")).toBe(false);
  });
});

describe("compareForInbox", () => {
  it("puts requested before ordered before delivered (status order)", () => {
    const list = [
      mr({ id: "delivered", status: "delivered" }),
      mr({ id: "ordered", status: "ordered" }),
      mr({ id: "requested", status: "requested" }),
    ];
    const sorted = list.slice().sort(compareForInbox).map((x) => x.id);
    expect(sorted).toEqual(["requested", "ordered", "delivered"]);
  });
  it("within a status, urgent before normal before low", () => {
    const list = [
      mr({ id: "low", urgency: "low" }),
      mr({ id: "urgent", urgency: "urgent" }),
      mr({ id: "normal", urgency: "normal" }),
    ];
    const sorted = list.slice().sort(compareForInbox).map((x) => x.id);
    expect(sorted).toEqual(["urgent", "normal", "low"]);
  });
});

describe("summariseInbox", () => {
  it("counts each bucket + open + urgentOpen", () => {
    const s = summariseInbox([
      mr({ id: "1", status: "requested", urgency: "urgent" }),
      mr({ id: "2", status: "requested", urgency: "normal" }),
      mr({ id: "3", status: "ordered", urgency: "high" }),
      mr({ id: "4", status: "delivered", urgency: "normal" }),
      mr({ id: "5", status: "cancelled", urgency: "normal" }),
    ]);
    expect(s.total).toBe(5);
    expect(s.requested).toBe(2);
    expect(s.ordered).toBe(1);
    expect(s.delivered).toBe(1);
    expect(s.cancelled).toBe(1);
    expect(s.open).toBe(3); // 1, 2, 3
    expect(s.urgentOpen).toBe(2); // urgent + high among 1, 2, 3
  });
});

describe("CreateMaterialRequestPayloadSchema", () => {
  it("accepts a minimal valid payload", () => {
    const r = CreateMaterialRequestPayloadSchema.safeParse({ item: "25mm conduit", quantity: 20, unit: "m" });
    expect(r.success).toBe(true);
  });
  it("rejects zero/negative quantity", () => {
    expect(CreateMaterialRequestPayloadSchema.safeParse({ item: "x", quantity: 0, unit: "m" }).success).toBe(false);
    expect(CreateMaterialRequestPayloadSchema.safeParse({ item: "x", quantity: -1, unit: "m" }).success).toBe(false);
  });
  it("rejects empty item / unit", () => {
    expect(CreateMaterialRequestPayloadSchema.safeParse({ item: "  ", quantity: 1, unit: "m" }).success).toBe(false);
    expect(CreateMaterialRequestPayloadSchema.safeParse({ item: "x", quantity: 1, unit: "" }).success).toBe(false);
  });
  it("requires stage when taskId is provided", () => {
    expect(
      CreateMaterialRequestPayloadSchema.safeParse({ item: "x", quantity: 1, unit: "m", taskId: "t1" }).success
    ).toBe(false);
  });
});

describe("UpdateMaterialRequestPayloadSchema", () => {
  it("requires id + at least one changed field", () => {
    expect(UpdateMaterialRequestPayloadSchema.safeParse({ id: "m1" }).success).toBe(false);
    expect(UpdateMaterialRequestPayloadSchema.safeParse({ id: "m1", status: "ordered" }).success).toBe(true);
  });
  it("requires cancelReason when status=cancelled", () => {
    expect(UpdateMaterialRequestPayloadSchema.safeParse({ id: "m1", status: "cancelled" }).success).toBe(false);
    expect(
      UpdateMaterialRequestPayloadSchema.safeParse({ id: "m1", status: "cancelled", cancelReason: "duplicate" }).success
    ).toBe(true);
  });
});

describe("MaterialRequestItemSchema", () => {
  it("rejects a persisted item with status=cancelled but no reason", () => {
    const r = MaterialRequestItemSchema.safeParse(mr({ id: "x", status: "cancelled" }));
    expect(r.success).toBe(false);
  });
  it("accepts a cancelled item with a reason", () => {
    const r = MaterialRequestItemSchema.safeParse(mr({ id: "x", status: "cancelled", cancelReason: "duplicate" }));
    expect(r.success).toBe(true);
  });
});

describe("format helpers", () => {
  it("renders labels + tones", () => {
    expect(statusLabel("ordered")).toBe("Ordered");
    expect(statusTone("delivered")).toBe("success");
    expect(urgencyLabel("urgent")).toBe("Urgent");
    expect(urgencyTone("urgent")).toBe("danger");
  });
  it("formats quantities cleanly", () => {
    expect(formatQuantity(20, "m")).toBe("20 m");
    expect(formatQuantity(1.5, "kg")).toBe("1.5 kg");
    expect(formatQuantity(2.0, "box")).toBe("2 box");
    expect(formatQuantity(0.25, "L")).toBe("0.25 L");
  });
});
