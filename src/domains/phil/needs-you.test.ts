import { describe, expect, it } from "vitest";
import { buildPhilNeedsYou } from "./needs-you";
import type { TimeEntry } from "@/domains/timesheets/types";
import type { ExpiringCalibration } from "@/domains/gear/types";

const ME = "user-me";

function entry(p: Partial<TimeEntry>): TimeEntry {
  return {
    id: "e1",
    date: "2024-05-23",
    totalHours: 7.6,
    status: "submitted",
    rejectedReason: null,
    ...p,
  } as unknown as TimeEntry;
}
function calibration(p: Partial<ExpiringCalibration>): ExpiringCalibration {
  return {
    kind: "calibration",
    key: "cal:a1",
    assetId: "a1",
    assetName: "Fluke 1587",
    identifier: "FLK-01",
    holderId: ME,
    holderName: "Me",
    calibrationDue: "2026-06-20",
    daysToExpiry: 8,
    status: "expiring",
    ...p,
  } as ExpiringCalibration;
}

describe("buildPhilNeedsYou", () => {
  it("returns NO items (never a fabricated row) when nothing is real", () => {
    expect(buildPhilNeedsYou({ viewerId: ME, entries: [] })).toEqual([]);

    // submitted/approved hours must not appear
    const items = buildPhilNeedsYou({
      viewerId: ME,
      entries: [entry({ status: "submitted" }), entry({ id: "e2", status: "approved" })],
    });
    expect(items).toEqual([]);
  });

  it("surfaces a rejected-hours item deep-linked to the My Day fix flow", () => {
    const items = buildPhilNeedsYou({
      viewerId: ME,
      entries: [
        entry({ id: "e9", status: "rejected", rejectedReason: "Stage doesn't match roster", date: "2024-05-22" }),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "rejected-hours",
      severity: "urgent",
      // Same ?fixDate= deep link the "Hours rejected" push uses — selects the
      // day and auto-opens the inline fix-and-resubmit sheet on My Day.
      href: "/phil/my-day?fixDate=2024-05-22",
      actionLabel: "Fix hours",
      detail: "Stage doesn't match roster",
    });
    expect(items[0]!.title).toContain("need a fix");
  });

  it("gives every item a real, non-empty in-app href", () => {
    const items = buildPhilNeedsYou({
      viewerId: ME,
      entries: [entry({ id: "e", status: "rejected", rejectedReason: "x" })],
      calibrations: [calibration({})],
    });
    expect(items.every((i) => i.href.startsWith("/phil/"))).toBe(true);
  });
});

describe("buildPhilNeedsYou — calibration items (#305)", () => {
  it("surfaces an EXPIRED calibration on held gear as urgent with a don't-use warning", () => {
    const items = buildPhilNeedsYou({
      viewerId: ME,
      entries: [],
      calibrations: [
        calibration({ status: "expired", daysToExpiry: -3, calibrationDue: "2026-06-09" }),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "calibration:a1",
      kind: "calibration",
      severity: "urgent",
      href: "/phil/gear",
      actionLabel: "View gear",
    });
    expect(items[0]!.title).toContain("Fluke 1587 calibration expired");
    expect(items[0]!.detail).toContain("Don't test with it");
  });

  it("surfaces an upcoming calibration as a warning with the due date", () => {
    const items = buildPhilNeedsYou({
      viewerId: ME,
      entries: [],
      calibrations: [calibration({})],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: "warning" });
    expect(items[0]!.title).toContain("calibration due");
  });

  it("drops a calibration row held by SOMEONE ELSE (defence-in-depth on holderId)", () => {
    const items = buildPhilNeedsYou({
      viewerId: ME,
      entries: [],
      calibrations: [calibration({ holderId: "someone-else" })],
    });
    expect(items).toEqual([]);
  });

  it("omitting the calibrations input changes nothing (existing callers untouched)", () => {
    expect(buildPhilNeedsYou({ viewerId: ME, entries: [] })).toEqual([]);
  });

  it("ranks an expired calibration alongside urgent rejected-hours", () => {
    const items = buildPhilNeedsYou({
      viewerId: ME,
      entries: [entry({ id: "e9", status: "rejected", date: "2024-05-22" })],
      calibrations: [
        calibration({ status: "expired", daysToExpiry: -1, calibrationDue: "2026-06-11" }),
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(["rejected-hours", "calibration"]);
  });
});

// Guards the My Day streaming split (PhilNeedsYouSection): the page computes the
// hero from entries ALONE (no calibrations) while the feed streams the
// calibrations separately. That is only safe if the rejected-hours items — the
// only kind the hero reads — are independent of the calibrations.
describe("buildPhilNeedsYou — rejected-hours are independent of calibrations", () => {
  const entries = [
    entry({ id: "r1", status: "rejected", rejectedReason: "Wrong job", date: "2024-05-21" }),
    entry({ id: "ok", status: "submitted", date: "2024-05-22" }),
    entry({ id: "r2", status: "rejected", rejectedReason: null, date: "2024-05-20" }),
  ];

  it("yields the SAME rejected-hours items with empty vs populated calibrations", () => {
    const heroInput = buildPhilNeedsYou({ viewerId: ME, entries });
    const fullInput = buildPhilNeedsYou({
      viewerId: ME,
      entries,
      calibrations: [calibration({ status: "expired" })],
    });
    const rejectedOnly = (items: ReturnType<typeof buildPhilNeedsYou>) =>
      items.filter((i) => i.kind === "rejected-hours");

    expect(rejectedOnly(heroInput)).toEqual(rejectedOnly(fullInput));
    expect(rejectedOnly(heroInput).length).toBe(2);
  });
});
