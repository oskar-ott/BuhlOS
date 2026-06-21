import { describe, expect, it } from "vitest";
import {
  deriveMilestoneState,
  summariseMilestones,
  sortMilestonesForDisplay,
  type Milestone,
} from "./job-milestones";

const TODAY = "2026-06-21";
const m = (id: string, targetDate: string, doneDate?: string | null): Milestone => ({
  id,
  name: id,
  targetDate,
  doneDate: doneDate ?? null,
});

describe("deriveMilestoneState", () => {
  it("done when a doneDate is set — even if the target is in the past", () => {
    expect(deriveMilestoneState(m("x", "2026-01-01", "2026-06-30"), TODAY)).toBe("done");
  });
  it("overdue when not done and target is strictly before today", () => {
    expect(deriveMilestoneState(m("x", "2026-06-20"), TODAY)).toBe("overdue");
  });
  it("target === today is NOT overdue (still upcoming)", () => {
    expect(deriveMilestoneState(m("x", TODAY), TODAY)).toBe("upcoming");
  });
  it("future target is upcoming", () => {
    expect(deriveMilestoneState(m("x", "2026-12-01"), TODAY)).toBe("upcoming");
  });
  it("an unparseable target can never be overdue → upcoming", () => {
    expect(deriveMilestoneState(m("x", "soon"), TODAY)).toBe("upcoming");
  });
});

describe("summariseMilestones", () => {
  it("counts by state and finds the soonest upcoming", () => {
    const list = [
      m("done1", "2026-05-01", "2026-05-02"),
      m("over1", "2026-06-19"),
      m("up-late", "2026-09-01"),
      m("up-soon", "2026-07-01"),
    ];
    const s = summariseMilestones(list, TODAY);
    expect(s).toMatchObject({ total: 4, done: 1, overdue: 1, upcoming: 2 });
    expect(s.nextUpcoming?.id).toBe("up-soon");
  });
  it("empty → zeros and null nextUpcoming", () => {
    expect(summariseMilestones([], TODAY)).toEqual({
      total: 0,
      done: 0,
      overdue: 0,
      upcoming: 0,
      nextUpcoming: null,
    });
  });
});

describe("sortMilestonesForDisplay", () => {
  it("overdue (earliest) → upcoming (earliest) → done (newest done)", () => {
    const list = [
      m("done-old", "2026-01-01", "2026-02-01"),
      m("up-soon", "2026-07-01"),
      m("over-late", "2026-06-20"),
      m("done-new", "2026-03-01", "2026-06-10"),
      m("over-early", "2026-06-01"),
      m("up-late", "2026-09-01"),
    ];
    expect(sortMilestonesForDisplay(list, TODAY).map((x) => x.id)).toEqual([
      "over-early",
      "over-late",
      "up-soon",
      "up-late",
      "done-new",
      "done-old",
    ]);
  });
});
