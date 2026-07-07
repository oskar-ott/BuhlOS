import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  PhilMyDayDoThisNow,
  PhilMyDayHonestyNote,
  PhilMyDayOnJobCard,
  PhilMyDayQuickGrid,
  PhilMyDaySharpenedHeader,
  philNeedsYouBadge,
} from "./PhilMyDaySharpened";
import { CaptureLauncherProvider } from "./captureLauncherContext";
import type { PhilNeedsYouItem } from "@/domains/phil/needs-you";

/**
 * SSR smoke for the SHARPENED My Day pieces (phil_sharpened, dark — Wave 2a).
 * These render only when the server-resolved flag is on; the flag-off page is
 * pinned by the existing my-day tests. Everything asserted here is the honesty
 * contract: real values, honest absence, no fake tiles.
 */

const rejected: PhilNeedsYouItem = {
  id: "rejected-hours:e1",
  kind: "rejected-hours",
  title: "Thu 3 Jul hours need a fix",
  detail: "Lunch wasn't deducted",
  href: "/phil/my-day?fixDate=2026-07-03",
  actionLabel: "Fix hours",
  severity: "urgent",
};

const snag: PhilNeedsYouItem = {
  id: "snag:s1",
  kind: "snag",
  title: "Redo GPO heights in kitchen",
  detail: "Birdwood Estate",
  href: "/phil/jobs/job-1#phil-job-snags",
  actionLabel: "Open snag",
  severity: "warning",
};

describe("PhilMyDaySharpenedHeader", () => {
  it("renders the greeting, the real subline, and a truthful Synced pill (SSR = online)", () => {
    const html = renderToString(
      createElement(PhilMyDaySharpenedHeader, {
        heading: "Arvo, Sam",
        subline: "Mon 6 Jul · on site since 6:58",
      }),
    );
    expect(html).toContain("Arvo, Sam");
    expect(html).toContain("on site since 6:58");
    // useOnline's SSR contract is `true`, so the first paint says Synced.
    expect(html).toContain(">Synced<");
    expect(html).not.toContain(">Offline<");
  });
});

describe("PhilMyDayDoThisNow", () => {
  it("renders the most urgent item as the hero with its real destination", () => {
    const html = renderToString(
      createElement(PhilMyDayDoThisNow, { items: [rejected, snag] }),
    );
    expect(html).toContain("Do this now");
    expect(html).toContain("Thu 3 Jul hours need a fix");
    // Rejected hours get the design's verb; the link is the real fix deep link.
    expect(html).toContain("Fix &amp; resend");
    expect(html).toContain("/phil/my-day?fixDate=2026-07-03");
    expect(html).toContain("Not yet");
  });

  it("lists the remaining items under a counted Needs-you heading with badges", () => {
    const html = renderToString(
      createElement(PhilMyDayDoThisNow, { items: [rejected, snag] }),
    );
    expect(html).toContain("Needs you · 1");
    expect(html).toContain("Redo GPO heights in kitchen");
    // The snag row carries an honest Open badge, not a fabricated status.
    expect(html).toContain(">Open<");
    expect(html).toContain("/phil/jobs/job-1#phil-job-snags");
  });

  it("shows an honest all-clear when nothing needs the worker — no fake urgency", () => {
    const html = renderToString(createElement(PhilMyDayDoThisNow, { items: [] }));
    expect(html).toContain("chasing you");
    expect(html).not.toContain("Do this now");
    expect(html).not.toContain("Needs you");
  });

  it("maps needs-you kinds to honest badge words", () => {
    expect(philNeedsYouBadge(rejected)).toEqual({ label: "Rejected", tone: "danger" });
    expect(
      philNeedsYouBadge({ ...snag, kind: "calibration", severity: "urgent" }),
    ).toEqual({ label: "Expired", tone: "danger" });
    expect(
      philNeedsYouBadge({ ...snag, kind: "calibration", severity: "warning" }),
    ).toEqual({ label: "Due soon", tone: "warning" });
    expect(philNeedsYouBadge(snag)).toEqual({ label: "Open", tone: "warning" });
  });
});

describe("PhilMyDayOnJobCard", () => {
  it("renders the sole job's real code, name and address as a link to the job", () => {
    const html = renderToString(
      createElement(PhilMyDayOnJobCard, {
        job: {
          id: "job-1",
          name: "Birdwood Estate",
          ref: "IV0041",
          siteAddress: "12 Birdwood Rd",
        },
      }),
    );
    expect(html).toContain("On the job");
    expect(html).toContain("IV0041");
    expect(html).toContain("Birdwood Estate");
    expect(html).toContain("12 Birdwood Rd");
    expect(html).toContain("/phil/jobs/job-1");
  });

  it("omits code/address lines when the job has none — never a placeholder", () => {
    const html = renderToString(
      createElement(PhilMyDayOnJobCard, { job: { id: "job-2", name: "Norwood Place" } }),
    );
    expect(html).toContain("Norwood Place");
    expect(html).not.toContain("IV");
  });
});

function renderGrid(props: Parameters<typeof PhilMyDayQuickGrid>[0]) {
  return renderToString(
    createElement(CaptureLauncherProvider, null, createElement(PhilMyDayQuickGrid, props)),
  );
}

describe("PhilMyDayQuickGrid", () => {
  it("links hours to the Hours tab with a Due chip only when today is unlogged", () => {
    const html = renderGrid({ hoursDue: true, callJobId: null });
    expect(html).toContain('href="/phil/hours"');
    expect(html).toContain("Log hours now");
    expect(html).toContain(">Due<");
  });

  it("shows no Due chip when today's hours are already in", () => {
    const html = renderGrid({ hoursDue: false, callJobId: null });
    expect(html).not.toContain(">Due<");
  });

  it("offers Who-to-call only with a real job context, pointing at its contacts", () => {
    const withJob = renderGrid({ hoursDue: false, callJobId: "job-1" });
    expect(withJob).toContain("Who to call");
    expect(withJob).toContain("/phil/jobs/job-1#phil-job-contacts");

    const withoutJob = renderGrid({ hoursDue: false, callJobId: null });
    expect(withoutJob).not.toContain("Who to call");
  });

  it("keeps the real issue entry and adds NO duplicate Capture tile (the FAB is capture)", () => {
    const html = renderGrid({ hoursDue: true, callJobId: "job-1" });
    expect(html).toContain("Report an issue");
    // Capture stays the tab bar FAB — no lookalike tile in the grid.
    expect(html).not.toContain(">Capture<");
  });
});

describe("PhilMyDayHonestyNote", () => {
  it("names the deferred surfaces honestly instead of faking them", () => {
    const html = renderToString(createElement(PhilMyDayHonestyNote, {}));
    expect(html).toContain("job history aren");
    expect(html).toContain("connected yet");
    expect(html).toContain("border-dashed");
  });
});
