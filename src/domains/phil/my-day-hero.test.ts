import { describe, expect, it } from "vitest";
import { buildMyDayHero, type MyDayHeroInput } from "./my-day-hero";
import type { PhilNeedsYouItem } from "./needs-you";

/**
 * #422 — the My Day hero state machine. Pure model; pins the priority order
 * (fix-rejected > log-today > submit-draft > next-job > all-clear) and that
 * every input resolves to exactly one hero.
 */

function rejected(n: number): PhilNeedsYouItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `rej_${i}`,
    kind: "rejected-hours" as const,
    title: `Tuesday's hours`,
    detail: "wrong job",
    href: `/phil/my-day?fixDate=2026-06-0${i + 1}`,
    actionLabel: "Fix",
    severity: "urgent" as const,
  }));
}

function input(over: Partial<MyDayHeroInput> = {}): MyDayHeroInput {
  return { todayStatus: null, needsYouItems: [], soleJob: null, ...over };
}

describe("buildMyDayHero — priority order", () => {
  it("rejected hours win over everything, even with today logged + a job", () => {
    const hero = buildMyDayHero(
      input({
        todayStatus: "approved",
        needsYouItems: rejected(1),
        soleJob: { id: "j1", name: "Magill Rd" },
      })
    );
    expect(hero.kind).toBe("fix-rejected");
    expect(hero.tone).toBe("danger");
    expect(hero.href).toContain("fixDate="); // deep-links to the fix flow
  });

  it("multiple rejected days read as a count", () => {
    const hero = buildMyDayHero(input({ needsYouItems: rejected(3) }));
    expect(hero.kind).toBe("fix-rejected");
    expect(hero.title).toContain("3 days");
  });

  it("nothing logged today → log-today, action is the inline sheet (no href)", () => {
    const hero = buildMyDayHero(input({ todayStatus: null }));
    expect(hero.kind).toBe("log-today");
    expect(hero.href).toBeNull();
    expect(hero.actionLabel).toBeNull();
    expect(hero.tone).toBe("action");
  });

  it("a draft today → submit-draft nudge (the silent gap)", () => {
    const hero = buildMyDayHero(input({ todayStatus: "draft" }));
    expect(hero.kind).toBe("submit-draft");
    expect(hero.href).toBeNull();
  });

  it("today submitted + one job → next-job deep link", () => {
    const hero = buildMyDayHero(
      input({ todayStatus: "submitted", soleJob: { id: "j1", name: "Magill Rd" } })
    );
    expect(hero.kind).toBe("next-job");
    expect(hero.href).toBe("/phil/jobs/j1");
    expect(hero.title).toContain("Magill Rd");
  });

  it("today approved, no job, nothing pending → all-clear", () => {
    const hero = buildMyDayHero(input({ todayStatus: "approved" }));
    expect(hero.kind).toBe("all-clear");
    expect(hero.tone).toBe("success");
    expect(hero.href).toBeNull();
  });

  it("draft outranks next-job (submit before moving on)", () => {
    const hero = buildMyDayHero(
      input({ todayStatus: "draft", soleJob: { id: "j1", name: "X" } })
    );
    expect(hero.kind).toBe("submit-draft");
  });
});
