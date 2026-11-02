import { describe, expect, it } from "vitest";
import {
  builderBadge,
  countsLine,
  datedItpTitle,
  defaultPdfName,
  filterRecentNames,
  isEmailAddress,
  lastSuccessfulSend,
  makePdfBlocker,
  nextAreaName,
  pdfBadge,
  pdfRowBadge,
  pendingBlocker,
  photoCapHint,
  shortWhen,
} from "./model";
import type { ItpPdf } from "./schema";

/**
 * ITP builder pure model (handoff 2026-11-02). Pins every data-driven string
 * the worker reads and the two "never" rules: never two "Area 3"s, never a
 * badge the app can't know.
 */

function pdf(over: Partial<ItpPdf> = {}): ItpPdf {
  return {
    id: "p1",
    name: "All areas",
    nameIsAuto: true,
    areaIds: ["a1"],
    areaCount: 1,
    photoCount: 3,
    url: "memory://pdf",
    madeAt: "2026-11-02T08:41:00+11:00",
    madeBy: "Sparky",
    stale: false,
    ...over,
  };
}

describe("itp model", () => {
  it("dates the title in the device timezone: ITP · Ddd D Mon", () => {
    expect(datedItpTitle(new Date(2026, 9, 30, 12))).toBe("ITP · Fri 30 Oct");
  });

  it("counts read like a leading hand", () => {
    expect(countsLine(1, 1)).toBe("1 area · 1 photo");
    expect(countsLine(4, 12)).toBe("4 areas · 12 photos");
  });

  it("names a nameless area with the next unused number", () => {
    expect(nextAreaName([])).toBe("Area 1");
    expect(nextAreaName(["Kitchen", "Area 1", "Area 2"])).toBe("Area 3");
    // Area 2 was deleted — the next one is still never a duplicate.
    expect(nextAreaName(["Area 1", "Area 3"])).toBe("Area 2");
    expect(nextAreaName(["area 1"])).toBe("Area 2");
  });

  it("recent names skip what this ITP already has and de-duplicate", () => {
    expect(filterRecentNames(["Kitchen", "Roof", "kitchen ", "Garage", ""], ["Roof"])).toEqual([
      "Kitchen",
      "Garage",
    ]);
  });

  it("default PDF name follows the ticks", () => {
    expect(defaultPdfName([{ name: "Kitchen" }, { name: "Roof" }], 2)).toBe("All areas");
    expect(defaultPdfName([{ name: "Kitchen" }], 2)).toBe("Kitchen");
    expect(defaultPdfName([{ name: "Switchboard" }, { name: "Kitchen" }], 4)).toBe(
      "Switchboard, Kitchen"
    );
    expect(defaultPdfName([], 3)).toBe("All areas");
  });

  it("badge priority: out of date › last send › last made › no PDF", () => {
    expect(pdfBadge({ staleCount: 0, lastSend: null, lastMadeAt: null })).toEqual({
      label: "No PDF yet",
      tone: "neutral",
    });
    expect(
      pdfBadge(
        { staleCount: 0, lastSend: null, lastMadeAt: "2026-10-03T00:00:00+11:00" },
        () => "3 Oct"
      )
    ).toEqual({ label: "PDF made 3 Oct", tone: "success" });
    expect(
      pdfBadge(
        {
          staleCount: 0,
          lastSend: { kind: "office", sentAt: "2026-09-21T00:00:00+10:00" },
          lastMadeAt: "2026-10-03T00:00:00+11:00",
        },
        () => "21 Sep"
      )
    ).toEqual({ label: "Sent to office 21 Sep", tone: "success" });
    expect(
      pdfBadge({
        staleCount: 1,
        lastSend: { kind: "office", sentAt: "2026-09-21T00:00:00+10:00" },
        lastMadeAt: "x",
      })
    ).toEqual({ label: "PDF out of date", tone: "warning" });
    expect(pdfBadge({ staleCount: 2, lastSend: null, lastMadeAt: "x" }).label).toBe(
      "2 PDFs out of date"
    );
  });

  it("builder badge uses time-of-day for today's sends", () => {
    const now = new Date(2026, 10, 2, 9, 0);
    const sentAt = new Date(2026, 10, 2, 8, 42).toISOString();
    expect(builderBadge([pdf()], { kind: "office", sentAt }, now).label).toBe(
      "Sent to office 8:42 am"
    );
    expect(builderBadge([pdf({ stale: true })], { kind: "office", sentAt }, now)).toEqual({
      label: "PDF out of date",
      tone: "warning",
    });
    expect(builderBadge([], null, now).label).toBe("No PDF yet");
  });

  it("per-PDF row badge", () => {
    const now = new Date(2026, 10, 2, 9, 0);
    expect(pdfRowBadge(pdf({ stale: true }), null, now)).toEqual({
      label: "Out of date",
      tone: "warning",
    });
    expect(pdfRowBadge(pdf(), null, now)).toEqual({ label: "Not sent", tone: "warning" });
    expect(
      pdfRowBadge(
        pdf(),
        { kind: "email", sentAt: new Date(2026, 10, 1, 16, 10).toISOString() },
        now
      ).label
    ).toBe("Sent 1 Nov 4:10 pm");
  });

  it("shortWhen: time today, date + time otherwise", () => {
    const now = new Date(2026, 10, 2, 9, 0);
    expect(shortWhen(new Date(2026, 10, 2, 8, 42).toISOString(), now)).toBe("8:42 am");
    expect(shortWhen(new Date(2026, 9, 30, 16, 10).toISOString(), now)).toBe("30 Oct 4:10 pm");
    expect(shortWhen(null, now)).toBe("");
  });

  it("photo cap hint appears from 100 photos", () => {
    expect(photoCapHint(99)).toBeNull();
    expect(photoCapHint(112)).toBe("112 of 120 photos — one PDF holds 120");
  });

  it("Make PDF blockers say what to do", () => {
    expect(makePdfBlocker([])).toBe("Tick at least one area.");
    expect(makePdfBlocker([{ name: "Kitchen", photoCount: 5 }])).toBeNull();
    expect(
      makePdfBlocker([
        { name: "Level 1", photoCount: 64 },
        { name: "Level 2", photoCount: 58 },
        { name: "Roof space", photoCount: 28 },
      ])
    ).toBe("150 photos — one PDF holds 120. Untick some areas. Make a second PDF for the rest.");
    expect(makePdfBlocker([{ name: "Kitchen", photoCount: 130 }])).toBe(
      "Kitchen has 130 photos — one PDF holds 120. Remove some from Kitchen."
    );
  });

  it("pending blockers for Send / Make the PDF", () => {
    expect(pendingBlocker({ waitingOrSaving: 0, failed: 0 })).toBeNull();
    expect(pendingBlocker({ waitingOrSaving: 2, failed: 0 })).toBe("Waiting on 2 photos");
    expect(pendingBlocker({ waitingOrSaving: 2, failed: 1 })).toBe(
      "1 photo didn't save — Retry or remove it first."
    );
  });

  it("email check and last successful send", () => {
    expect(isEmailAddress("sam@builder.com.au")).toBe(true);
    expect(isEmailAddress("sam@builder")).toBe(false);
    expect(isEmailAddress("not an email")).toBe(false);
    expect(
      lastSuccessfulSend([
        { result: "failed", sentAt: "2026-11-02T09:00:00Z" },
        { result: "sent", sentAt: "2026-11-01T09:00:00Z" },
        { result: "sent", sentAt: "2026-11-02T08:00:00Z" },
      ])?.sentAt
    ).toBe("2026-11-02T08:00:00Z");
  });
});
