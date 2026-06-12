import { describe, expect, it } from "vitest";
import {
  buildGoToCommands,
  buildActionCommands,
  buildStaticSections,
  flattenSections,
  recentToCommand,
  moveHighlight,
  shouldOpenFromKey,
  PALETTE_MIN_CHARS,
} from "./command-palette-model";
import { ALL_ITEMS } from "./nav";
import type { RecentItem } from "@/lib/storage/recent-items";

/**
 * #215 — the ⌘K palette's logic lives in pure functions (the runner is
 * node-env, no DOM), so the behaviours the issue's ACs name are pinned here:
 * NAV-derived "Go to", navigational Actions, recents-graceful sections, the
 * keyboard highlight math, and the open-precedence rule (⌘K & Ctrl+K open;
 * suppressed under a modal; NOT suppressed while typing). The component
 * (CommandPalette.tsx) is thin chrome over exactly these.
 */

function rec(path: string, type: RecentItem["type"] = "job", title = path): RecentItem {
  return { path, title, type, at: 1 };
}

describe("buildGoToCommands (NAV-derived + explicit sub-tabs)", () => {
  const goTo = buildGoToCommands();
  const hrefs = goTo.map((c) => c.href);

  it("derives one command per live NAV item, in sidebar order, before the extras", () => {
    const navHrefs = ALL_ITEMS.map((i) => i.href);
    // The first N go-to hrefs are exactly the NAV destinations, in order.
    expect(hrefs.slice(0, navHrefs.length)).toEqual(navHrefs);
  });

  it("carries the main routes as jump commands", () => {
    for (const href of ["/command-centre", "/v2/jobs", "/hours", "/employees", "/reports"]) {
      expect(hrefs).toContain(href);
    }
  });

  it("adds the hours sub-tabs + notification settings that aren't standalone NAV items", () => {
    // EXACT routes — the in-page Hours tabs and the settings footer link.
    expect(hrefs).toContain("/hours/approvals");
    expect(hrefs).toContain("/hours/weekly");
    expect(hrefs).toContain("/settings/notifications");
  });

  it("pins the three hours/day routes to their exact paths", () => {
    const byId = Object.fromEntries(goTo.map((c) => [c.id, c.href]));
    // The day view is the NAV item; approvals + weekly are the extras.
    expect(hrefs).toContain("/hours");
    expect(byId["hours-approvals"]).toBe("/hours/approvals");
    expect(byId["hours-weekly"]).toBe("/hours/weekly");
  });

  it("has stable unique ids and non-empty labels", () => {
    expect(new Set(goTo.map((c) => c.id)).size).toBe(goTo.length);
    for (const c of goTo) expect(c.label.length).toBeGreaterThan(0);
  });
});

describe("buildActionCommands (navigational only — no mutations)", () => {
  const actions = buildActionCommands();
  const byId = Object.fromEntries(actions.map((c) => [c.id, c.href]));

  it("exposes exactly the five navigational actions at their routes", () => {
    expect(actions.map((c) => c.id)).toEqual([
      "new-job",
      "new-quote",
      "open-approvals",
      "open-reports",
      "notification-prefs",
    ]);
    expect(byId["new-job"]).toBe("/v2/jobs/new");
    expect(byId["new-quote"]).toBe("/v2/quotes");
    expect(byId["open-approvals"]).toBe("/hours/approvals");
    expect(byId["open-reports"]).toBe("/reports");
    expect(byId["notification-prefs"]).toBe("/settings/notifications");
  });

  it("has NO 'New defect' command (deferred per #215)", () => {
    expect(actions.some((c) => /defect/i.test(c.label) || /defect/i.test(c.id))).toBe(false);
  });
});

describe("buildStaticSections (recents graceful)", () => {
  it("first run (zero recents) shows Go to + Actions only — no Recent group, no scold", () => {
    const sections = buildStaticSections([]);
    expect(sections.map((s) => s.id)).toEqual(["go-to", "actions"]);
    expect(sections.map((s) => s.heading)).toEqual(["Go to", "Actions"]);
  });

  it("appends a Recent group (last) only when there are recents", () => {
    const sections = buildStaticSections([rec("/v2/jobs/j1", "job", "Magill Rd")]);
    expect(sections.map((s) => s.id)).toEqual(["go-to", "actions", "recent"]);
    const recent = sections.find((s) => s.id === "recent")!;
    expect(recent.commands.map((c) => c.href)).toEqual(["/v2/jobs/j1"]);
    expect(recent.commands[0]!.label).toBe("Magill Rd");
  });

  it("flattenSections walks Go to → Actions → Recent in order (the keyboard sequence)", () => {
    const sections = buildStaticSections([rec("/employees/u1", "employee", "Sparky")]);
    const flat = flattenSections(sections);
    // First flat command is the first NAV item; last is the recent.
    expect(flat[0]!.href).toBe(ALL_ITEMS[0]!.href);
    expect(flat[flat.length - 1]!.href).toBe("/employees/u1");
  });
});

describe("recentToCommand", () => {
  it("labels jobs and people distinctly and keeps the path as the href", () => {
    const job = recentToCommand(rec("/v2/jobs/j1", "job", "Magill Rd"));
    expect(job).toMatchObject({ href: "/v2/jobs/j1", label: "Magill Rd", hint: "Job" });
    const person = recentToCommand(rec("/employees/u1", "employee", "Sparky"));
    expect(person).toMatchObject({ href: "/employees/u1", label: "Sparky", hint: "Person" });
  });
});

describe("moveHighlight (↑/↓ with wraparound)", () => {
  it("moves down and up within range", () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, -1, 3)).toBe(1);
  });

  it("wraps at both ends", () => {
    expect(moveHighlight(2, 1, 3)).toBe(0); // past the end → first
    expect(moveHighlight(0, -1, 3)).toBe(2); // before the start → last
  });

  it("parks at -1 when there is nothing to highlight", () => {
    expect(moveHighlight(0, 1, 0)).toBe(-1);
    expect(moveHighlight(-1, -1, 0)).toBe(-1);
  });

  it("from an unset (-1) highlight, down lands on the first and up on the last", () => {
    expect(moveHighlight(-1, 1, 4)).toBe(0);
    expect(moveHighlight(-1, -1, 4)).toBe(3);
  });
});

describe("shouldOpenFromKey (⌘K / Ctrl+K open precedence)", () => {
  it("opens on ⌘K (Mac, metaKey)", () => {
    expect(shouldOpenFromKey({ key: "k", metaKey: true, ctrlKey: false }, false)).toBe(true);
    expect(shouldOpenFromKey({ key: "K", metaKey: true, ctrlKey: false }, false)).toBe(true);
  });

  it("opens on Ctrl+K (Windows/Linux, ctrlKey)", () => {
    expect(shouldOpenFromKey({ key: "k", metaKey: false, ctrlKey: true }, false)).toBe(true);
  });

  it("ignores a bare 'k' with no modifier", () => {
    expect(shouldOpenFromKey({ key: "k", metaKey: false, ctrlKey: false }, false)).toBe(false);
  });

  it("ignores other chords (⌘J)", () => {
    expect(shouldOpenFromKey({ key: "j", metaKey: true, ctrlKey: false }, false)).toBe(false);
  });

  it("is SUPPRESSED when a drawer/modal owns the screen (no double-dialog)", () => {
    expect(shouldOpenFromKey({ key: "k", metaKey: true, ctrlKey: false }, true)).toBe(false);
    expect(shouldOpenFromKey({ key: "k", metaKey: false, ctrlKey: true }, true)).toBe(false);
  });
});

describe("PALETTE_MIN_CHARS", () => {
  it("is 2 — search engages at ≥2 chars (matches the topbar search threshold)", () => {
    expect(PALETTE_MIN_CHARS).toBe(2);
  });
});
