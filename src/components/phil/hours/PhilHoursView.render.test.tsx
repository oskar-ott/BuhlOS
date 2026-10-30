import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The view reads useRouter — stub next/navigation for SSR (the Phil render-test pattern).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { PhilHoursView, type PhilHoursViewProps } from "./PhilHoursView";
import { FindJobSheet } from "./FindJobSheet";
import { autoSplitOT } from "@/domains/timesheets/service";
import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * SSR smoke for the Hours screen (docs/phil-hours.md). renderToString gives
 * the first paint: the week rows, the summary that counts only what's logged,
 * the panel's primary action naming the whole decision, the fix line, and the
 * three different screens for loading-failed / loaded-empty. Interaction and
 * the save rules are covered as pure logic in hours-view.test.ts and
 * hours-save.test.ts.
 */

/** 2026-10-15 is a Thursday: the week is Mon 12 – Sun 18 Oct. */
const TODAY = "2026-10-15";

let seq = 0;
function entry(over: Partial<TimeEntry> & Pick<TimeEntry, "date">): TimeEntry {
  seq += 1;
  const totalHours = over.totalHours ?? 7.6;
  const split = autoSplitOT(totalHours, over.date);
  return {
    id: `e${seq}`,
    userId: "u1",
    date: over.date,
    totalHours,
    ordinaryHours: split.ordinary,
    overtimeHours: split.overtime,
    status: over.status ?? "submitted",
    allocations: over.allocations ?? [{ jobId: "bondi", hours: totalHours }],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    notes: null,
    rejectedReason: over.rejectedReason ?? null,
    ...(over.dayType ? { dayType: over.dayType } : {}),
  } as TimeEntry;
}

const JOBS = [
  { id: "bondi", name: "Bondi switchboard", address: "12 Campbell Pde, Bondi" },
  { id: "mascot", name: "Mascot warehouse", address: "4 Bourke Rd, Mascot" },
];

/** Nine jobs: the grid must not grow with them. */
const NINE = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => ({
  id,
  name: `Job ${id.toUpperCase()}`,
  address: `${id} Street, Suburb ${id.toUpperCase()}`,
}));

const tileCount = (html: string) => (html.match(/data-testid="hours-job-tile-/g) ?? []).length;
const findCount = (html: string) => (html.match(/data-testid="hours-find-job"/g) ?? []).length;

/** Visible words only: tags stripped, both apostrophe encodings normalised. */
function words(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|’/g, "'")
    .replace(/\s+/g, " ");
}

function render(over: Partial<PhilHoursViewProps> = {}) {
  return renderToString(
    createElement(PhilHoursView, {
      entries: [],
      loadFailed: false,
      todayISO: TODAY,
      jobs: [JOBS[0]!],
      jobsError: false,
      viewerId: "u1",
      canLogTafe: false,
      ...over,
    })
  );
}

describe("PhilHoursView — this week", () => {
  it("one job, nothing logged: Monday is picked and the primary names day, job and hours", () => {
    const html = render();
    expect(html).toContain("Nothing logged yet this week");
    expect(html).toContain('data-testid="hours-day-2026-10-12"');
    expect(html).toContain("Picked to log");
    expect(html).toContain("Log Monday · 7h 36m");
    expect(html).toContain("Bondi switchboard · sends to the office");
    // Beyond tomorrow is "Not yet"; nothing counts days the app doesn't know about.
    expect(html).toContain("Sat 17 Oct · Not yet");
    expect(html).not.toMatch(/ of \d+ days/);
    expect(html).not.toMatch(/to go/);
    // One job: no Split button, no job grid — a field with Change.
    expect(html).not.toContain("hours-action-split");
    expect(html).toContain('data-testid="hours-job-field"');
    expect(html).not.toContain("Phil");
  });

  it("mid-week: logged rows carry hours, job and the status word; the summary counts what's logged", () => {
    const html = render({
      entries: [
        entry({ date: "2026-10-12", status: "approved" }),
        entry({ date: "2026-10-13", totalHours: 8.6 }),
        entry({ date: "2026-10-14", dayType: "sick", allocations: [{ jobId: null, hours: 7.6 }] }),
      ],
    });
    expect(html).toContain("3 days logged · 23h 48m");
    expect(html).toContain("7h 36m + 1h OT");
    expect(html).toContain("Waiting on the office");
    expect(html).toContain("Approved");
    expect(html).toContain("tap to change");
    expect(html).toContain("Sick day");
    // Today is the next unlogged weekday → picked.
    expect(html).toContain("Log Thursday · 7h 36m");
    expect(html).not.toContain("Today · not logged"); // picked reads "Picked to log"
  });

  it("a sent-back day leads the screen: the alert line, the office's reason, and Fix as the only route", () => {
    const html = render({
      entries: [
        entry({
          date: "2026-10-13",
          status: "rejected",
          rejectedReason: "Wrong job — this was the Bondi switchboard, not Mascot",
          allocations: [{ jobId: "mascot", hours: 7.6 }],
        }),
      ],
      jobs: JOBS,
    });
    expect(html).toContain("1 day needs fixing · Tue");
    expect(html).toContain("Fix needed");
    expect(html).toContain("this was the Bondi switchboard, not Mascot");
    expect(html).toContain("You sent 7h 36m · Mascot warehouse");
    expect(html).toContain("Fix Tuesday");
  });

  it("several jobs, never logged: no default — the reason replaces the button, leave stays reachable", () => {
    const html = render({ jobs: JOBS });
    expect(html).toContain("Pick which job these hours are for");
    expect(html).toContain("You&#x27;re on 2 jobs and haven&#x27;t logged one yet");
    expect(html).not.toContain('data-testid="hours-log-primary"');
    expect(html).toContain('data-testid="hours-action-sick"');
    expect(html).toContain('data-testid="hours-action-holiday"');
    expect(html).not.toContain('data-testid="hours-action-tafe"');
  });

  it("several jobs with a last job: tiles with the last job picked, Split jobs offered, TAFE for apprentices only", () => {
    const html = render({
      jobs: JOBS,
      entries: [entry({ date: "2026-10-09", allocations: [{ jobId: "mascot", hours: 7.6 }] })],
      canLogTafe: true,
    });
    expect(html).toContain("Your last job");
    expect(html).toContain("Log Monday · 7h 36m");
    expect(html).toContain("Mascot warehouse · sends to the office");
    expect(html).toContain('data-testid="hours-action-split"');
    expect(html).toContain('data-testid="hours-action-tafe"');
    expect(html).toContain("Find another job");
  });

  it("two jobs: two tiles plus the Find tile, no 'more' line", () => {
    const html = render({
      jobs: JOBS,
      entries: [entry({ date: "2026-10-09", allocations: [{ jobId: "mascot", hours: 7.6 }] })],
    });
    expect(tileCount(html)).toBe(2);
    expect(findCount(html)).toBe(1);
    expect(html).not.toContain("more of yours");
    expect(html).toContain('aria-label="Find another job"');
    expect(html).toContain('role="radiogroup" aria-label="Job for Monday"');
  });

  it("three jobs: three tiles plus the Find tile, no 'more' line", () => {
    const html = render({
      jobs: NINE.slice(0, 3),
      entries: [entry({ date: "2026-10-09", allocations: [{ jobId: "b", hours: 7.6 }] })],
    });
    expect(tileCount(html)).toBe(3);
    expect(findCount(html)).toBe(1);
    expect(html).not.toContain("more of yours");
  });

  it("nine jobs: still exactly three tiles plus Find · 6 more of yours — the same grid as for three", () => {
    const html = render({
      jobs: NINE,
      entries: [
        entry({ date: "2026-10-09", allocations: [{ jobId: "g", hours: 7.6 }] }),
        entry({ date: "2026-10-08", allocations: [{ jobId: "b", hours: 7.6 }] }),
        entry({ date: "2026-10-07", allocations: [{ jobId: "c", hours: 7.6 }] }),
        entry({ date: "2026-10-01", allocations: [{ jobId: "a", hours: 7.6 }] }),
      ],
    });
    expect(tileCount(html)).toBe(3);
    expect(findCount(html)).toBe(1);
    // The last logged job leads and is the default; one tap logs to it.
    expect(html).toMatch(/hours-job-tile-g"[^>]*/);
    expect(html.indexOf("hours-job-tile-g")).toBeLessThan(html.indexOf("hours-job-tile-b"));
    expect(html.indexOf("hours-job-tile-b")).toBeLessThan(html.indexOf("hours-job-tile-c"));
    expect(html).toContain("Your last job");
    expect(html).toContain("Log Monday · 7h 36m");
    expect(html).toContain("Job G · sends to the office");
    expect(html).toContain("6 more of yours");
    expect(html).toContain('aria-label="Find another job, 6 more of yours"');
    // Not a tile: the other six are behind Find, never in the dock.
    expect(html).not.toContain("hours-job-tile-a");
    expect(html).not.toContain("hours-job-tile-i");
  });

  it("the tile grid is the same shape for three jobs and for nine — never more than four cells", () => {
    const three = render({
      jobs: NINE.slice(0, 3),
      entries: [entry({ date: "2026-10-09", allocations: [{ jobId: "b", hours: 7.6 }] })],
    });
    const nine = render({
      jobs: NINE,
      entries: [entry({ date: "2026-10-09", allocations: [{ jobId: "b", hours: 7.6 }] })],
    });
    expect(tileCount(three) + findCount(three)).toBe(4);
    expect(tileCount(nine) + findCount(nine)).toBe(4);
  });

  it("no assigned job: the reason in words plus Sick day · Holiday", () => {
    const html = render({ jobs: [] });
    expect(html).toContain("No active assigned job");
    expect(html).toContain("Ask the office to assign you to a job");
    expect(html).not.toContain('data-testid="hours-log-primary"');
    expect(html).toContain('data-testid="hours-action-sick"');
  });

  it("jobs failed to load: a danger block with its own Try again, no greyed-out button", () => {
    const html = render({ jobs: [], jobsError: true });
    expect(words(html)).toContain("Couldn't load your jobs");
    expect(html).toContain("Try again · load your jobs");
    expect(html).not.toContain('data-testid="hours-log-primary"');
  });

  it("a Saturday picked: no standard day — the primary sets the hours and says it's all OT", () => {
    const sat = "2026-10-17";
    const week = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((d) =>
      entry({ date: d })
    );
    const html = render({ entries: week, todayISO: sat });
    expect(html).toContain("Set Saturday&#x27;s hours →");
    expect(html).toContain("all of it counts as OT");
    expect(html).not.toContain('data-testid="hours-action-ot"');
  });

  it("?fix= opens the Fix sheet with the office's reason and 'Nothing changed yet'", () => {
    const html = render({
      entries: [entry({ date: "2026-10-13", status: "rejected", rejectedReason: "Wrong job" })],
      jobs: JOBS,
      launchFixDate: "2026-10-13",
    });
    expect(html).toContain('data-testid="hours-sheet-fix"');
    expect(html).toContain("Fix needed · the office says");
    expect(html).toContain("“Wrong job”");
    expect(html).toContain("What you sent");
    expect(html).toContain("Nothing changed yet");
    expect(html).toContain("What you sent"); // the sent job's chip caption
  });
});

describe("PhilHoursView — failed load is its own screen", () => {
  it("shows the block and the retry, and NO numbers, counts or rows", () => {
    const html = render({ loadFailed: true, entries: [entry({ date: "2026-10-12" })] });
    const text = words(html);
    expect(html).toContain('data-testid="hours-view-failed"');
    expect(text).toContain("Couldn't load your hours");
    expect(text).toContain("usually no signal or Wi-Fi");
    expect(text).toContain("Days you already sent are safe with the office");
    expect(html).toContain('data-testid="hours-load-retry"');
    expect(text).toContain("Your week shows here once it loads");
    // No numbers at all in what the worker reads: no hours, no counts, no zeros.
    expect(text).not.toMatch(/\d/);
    expect(html).not.toContain('data-testid="hours-week-card"');
    expect(html).not.toContain('data-testid="hours-panel"');
  });
});

describe("FindJobSheet — the job sheet behind the Find tile", () => {
  const sheet = (over: Partial<Parameters<typeof FindJobSheet>[0]> = {}) =>
    renderToString(
      createElement(FindJobSheet, {
        open: true,
        onClose: () => {},
        date: TODAY,
        tiles: JOBS,
        jobs: JOBS,
        currentJobId: "bondi",
        entries: [entry({ date: "2026-10-13", allocations: [{ jobId: "mascot", hours: 7.6 }] })],
        onPick: () => {},
        ...over,
      })
    );

  it("search at the top, the tiled jobs under 'On your week now' with the picked one ticked", () => {
    const html = sheet();
    expect(html).toContain("Search all jobs, finished ones too");
    expect(html).toContain('placeholder="Job name or address, finished too"');
    expect(html).toContain("On your week now");
    expect(html).toContain("Bondi switchboard");
    expect(html).toMatch(/aria-current="true"[^>]*hours-job-row-bondi"/);
    expect(html).toContain("Picked · Bondi · not logged yet");
    expect(html).toContain("Mascot · Logged Tue 13 Oct");
    // Two jobs, both tiled: there is no "Your other jobs" section at all.
    expect(html).not.toContain("Your other jobs");
  });

  it("nine jobs: the three tiled, then 'Your other jobs · 6' with suburb and last-logged date", () => {
    const html = sheet({
      tiles: [NINE[6]!, NINE[1]!, NINE[2]!],
      jobs: [NINE[6]!, NINE[1]!, NINE[2]!, ...NINE.filter((j) => !["g", "b", "c"].includes(j.id))],
      currentJobId: "g",
      entries: [entry({ date: "2026-10-09", allocations: [{ jobId: "g", hours: 7.6 }] })],
    });
    expect(html).toContain("Your other jobs · 6");
    const others = html.slice(html.indexOf('data-testid="hours-find-others"'));
    expect(others).toContain("hours-job-row-a");
    expect(others).toContain("Suburb A · not logged yet");
    expect(others).not.toContain("hours-job-row-g");
    const onWeek = html.slice(
      html.indexOf('data-testid="hours-find-on-week"'),
      html.indexOf('data-testid="hours-find-others"')
    );
    expect(onWeek).toContain("Picked · Suburb G · Logged Fri 9 Oct");
  });

  it("lists jobs by name and address only; Sick day / Holiday / TAFE never appear", () => {
    const html = sheet();
    // The job list holds jobs only — no leave row can be tapped by someone
    // looking for a job (the footer merely NAMES the Sick day / Holiday buttons).
    const list = html.slice(
      html.indexOf('<section aria-label="On your week now"'),
      html.indexOf("</section>")
    );
    expect(list).toContain("hours-job-row-bondi");
    expect(list).not.toContain("Sick day");
    expect(list).not.toContain("Holiday");
    expect(list).not.toContain("TAFE");
    expect(html).not.toContain('data-testid="hours-leave-group"');
    expect(html).not.toMatch(/data-testid="hours-leave-(sick|holiday|tafe)"/);
  });
});
