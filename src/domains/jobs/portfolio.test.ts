import { describe, expect, it } from "vitest";
import {
  buildJobCard,
  buildJobCardFromJob,
  buildPortfolioSummary,
  formatContractValue,
  formatPortfolioTotal,
  jobCardFacts,
  jobCardMeta,
  jobCardVerdict,
  jobNeedsAttention,
} from "./portfolio";
import { deriveJobHealth, type JobHealth } from "./job-health";
import type { Job } from "./types";

function job(over: Partial<Job> & { id: string; name: string }): Job {
  return { ...over } as Job;
}

const health = (level: JobHealth["level"]): JobHealth => ({
  level,
  reasons: [],
  total: 0,
});

describe("portfolio — jobNeedsAttention (real risk read only)", () => {
  it("counts at-risk and watch, never good or unknown", () => {
    expect(jobNeedsAttention(health("at-risk"))).toBe(true);
    expect(jobNeedsAttention(health("watch"))).toBe(true);
    expect(jobNeedsAttention(health("good"))).toBe(false);
    // unknown = no stat loaded — must NOT imply attention is needed (P7).
    expect(jobNeedsAttention(health("unknown"))).toBe(false);
  });
});

describe("portfolio — formatContractValue / formatPortfolioTotal", () => {
  it("formats whole-dollar AUD", () => {
    expect(formatContractValue(12500)).toBe("$12,500");
  });
  it("abbreviates portfolio totals: $k below a million, $M above", () => {
    expect(formatPortfolioTotal(940_000)).toBe("$940k");
    expect(formatPortfolioTotal(2_790_000)).toBe("$2.79M");
    expect(formatPortfolioTotal(12_000_000)).toBe("$12M");
    // small totals fall back to the exact figure rather than "$0k"
    expect(formatPortfolioTotal(500)).toBe("$500");
  });
});

describe("portfolio — jobCardMeta (honest omission)", () => {
  it("renders real value + crew when present", () => {
    const meta = jobCardMeta(
      job({ id: "j1", name: "A", contractValue: 250000, statsCrewCount: 4 })
    );
    expect(meta).toEqual({ value: "$250,000", valueKnown: true, crew: "4", crewKnown: true });
  });

  it('renders "—" (not 0) when value is redacted/absent and crew did not load', () => {
    const meta = jobCardMeta(job({ id: "j2", name: "B" }));
    expect(meta.value).toBe("—");
    expect(meta.valueKnown).toBe(false);
    expect(meta.crew).toBe("—");
    expect(meta.crewKnown).toBe(false);
  });

  it("treats a real zero crew as a known 0, not an em-dash", () => {
    const meta = jobCardMeta(job({ id: "j3", name: "C", statsCrewCount: 0 }));
    expect(meta.crew).toBe("0");
    expect(meta.crewKnown).toBe(true);
  });
});

describe("portfolio — buildPortfolioSummary", () => {
  it("counts need-attention from the supplied health, pluralises, and totals priced jobs", () => {
    const jobs = [
      job({ id: "a", name: "A", contractValue: 1_000_000 }),
      job({ id: "b", name: "B", contractValue: 790_000 }),
      job({ id: "c", name: "C" }), // unpriced
    ];
    const vm = buildPortfolioSummary({
      jobs,
      healthByIndex: [health("at-risk"), health("good"), health("unknown")],
    });
    expect(vm.jobCount).toBe(3);
    expect(vm.needAttentionCount).toBe(1);
    expect(vm.subline).toBe("3 jobs · 1 needs attention");
    expect(vm.totalContract).toEqual({ value: "$1.79M", hint: "across 2 priced jobs" });
  });

  it("uses the plain count subline when nothing needs attention", () => {
    const jobs = [job({ id: "a", name: "A" })];
    const vm = buildPortfolioSummary({ jobs, healthByIndex: [health("good")] });
    expect(vm.subline).toBe("1 job");
    expect(vm.needAttentionCount).toBe(0);
  });

  it("omits the total-contract readout when no job is priced (LH viewer / unpriced)", () => {
    const jobs = [job({ id: "a", name: "A" }), job({ id: "b", name: "B" })];
    const vm = buildPortfolioSummary({
      jobs,
      healthByIndex: [health("good"), health("watch")],
    });
    expect(vm.totalContract).toBeNull();
    expect(vm.subline).toBe("2 jobs · 1 needs attention");
  });

  it("pluralises a single priced job's hint", () => {
    const jobs = [job({ id: "a", name: "A", contractValue: 12500 })];
    const vm = buildPortfolioSummary({ jobs, healthByIndex: [health("good")] });
    expect(vm.totalContract).toEqual({ value: "$13k", hint: "across 1 priced job" });
  });

  it("is robust to a health array shorter than the jobs (treats missing as no-attention)", () => {
    const jobs = [job({ id: "a", name: "A" }), job({ id: "b", name: "B" })];
    const vm = buildPortfolioSummary({ jobs, healthByIndex: [health("at-risk")] });
    expect(vm.needAttentionCount).toBe(1);
  });
});

describe("portfolio — buildJobCard", () => {
  it("pairs the job, the supplied health, and the derived meta", () => {
    const j = job({ id: "j", name: "J", contractValue: 50000, statsCrewCount: 2 });
    const h = health("watch");
    const vm = buildJobCard(j, h);
    expect(vm.job).toBe(j);
    expect(vm.health).toBe(h);
    expect(vm.meta.value).toBe("$50,000");
    expect(vm.meta.crew).toBe("2");
  });

  it("buildJobCardFromJob derives health from the real stats", () => {
    // expired gear tags ⇒ at-risk via the existing deriveJobHealth engine.
    const j = job({ id: "j", name: "J", statsExpiredTags: 1 });
    const vm = buildJobCardFromJob(j);
    expect(vm.health.level).toBe(deriveJobHealth(j).level);
    expect(vm.health.level).toBe("at-risk");
  });
});

/**
 * The card's one verdict line (owner pull 2026-09-27, "an accurate overview of
 * jobs on the phone"): health words only where health is the read; otherwise
 * the phase truth in a sentence. The derivation itself is untouched.
 */
describe("portfolio — jobCardVerdict (honest per phase)", () => {
  const now = new Date("2026-09-27T09:00:00+10:00");
  const verdict = (over: Partial<Job>) => {
    const j = job({ id: "j", name: "J", ...over });
    return jobCardVerdict(j, deriveJobHealth(j), now);
  };

  it("leads with the top backlog reason on ANY phase — a paused job with evidence waiting still reads Watch", () => {
    expect(verdict({ status: "on_hold", statsEvidenceV2Pending: 3, statsExpiredTags: 0 })).toEqual({
      label: "Watch",
      tone: "warning",
      caption: "3 evidence to review",
    });
    expect(verdict({ status: "draft", statsExpiredTags: 1 }).label).toBe("At risk");
  });

  it("counts the reason in plain English — one tag is a tag, not 'tags'", () => {
    expect(verdict({ status: "active", statsExpiredTags: 1 }).caption).toBe("1 expired gear tag");
    expect(verdict({ status: "active", statsExpiredTags: 2 }).caption).toBe("2 expired gear tags");
  });

  it("an active job with nothing outstanding is On track · nothing needs you", () => {
    expect(verdict({ status: "active", statsEvidenceV2Pending: 0, statsExpiredTags: 0 })).toEqual({
      label: "On track",
      tone: "success",
      caption: "nothing needs you",
    });
  });

  it("an active job with no stat loaded is No data, never an invented all-clear", () => {
    const v = verdict({ status: "active" });
    expect(v.label).toBe("No data");
    expect(v.tone).toBe("neutral");
    expect(v.caption).toBe("health starts when hours or photos come in");
  });

  it("a draft is never 'on track' — it says it isn't published", () => {
    const v = verdict({ status: "draft", statsEvidenceV2Pending: 0, statsExpiredTags: 0 });
    expect(v.label).toBeNull();
    expect(v.tone).toBe("neutral");
    expect(v.caption).toBe("Not published yet — the crew can't see it");
  });

  it("a paused job says so in the warning tone, not 'nothing needs you'", () => {
    const v = verdict({ status: "on_hold", statsEvidenceV2Pending: 0, statsExpiredTags: 0 });
    expect(v).toEqual({ label: null, tone: "warning", caption: "Paused — nothing to review" });
  });

  it("a finished job names its callback window; a closed job its close date", () => {
    const finishing = verdict({
      status: "complete",
      completedAt: "2026-09-21T10:00:00Z",
      statsEvidenceV2Pending: 0,
      statsExpiredTags: 0,
    });
    expect(finishing.label).toBeNull();
    expect(finishing.caption).toMatch(/^Finished 21 Sept? · crew can log until 21 Oct$/);
    const closed = verdict({
      status: "complete",
      completedAt: "2026-08-13T10:00:00Z",
      statsEvidenceV2Pending: 0,
      statsExpiredTags: 0,
    });
    expect(closed.caption).toBe("Closed 13 Aug · still takes callback hours");
    expect(verdict({ status: "archived", statsExpiredTags: 0 }).caption).toBe(
      "Archived — office history only"
    );
  });
});

describe("portfolio — jobCardFacts (the phone line: real facts only)", () => {
  const now = new Date("2026-09-27T09:00:00+10:00");

  it("prints every real fact in reading order and skips what isn't there", () => {
    const j = job({
      id: "j",
      name: "J",
      contractValue: 48500,
      statsCrewCount: 3,
      statsTasksTotal: 10,
      statsTasksComplete: 4,
      updatedAt: "2026-09-25T09:00:00+10:00",
    });
    expect(jobCardFacts(j, { now })).toEqual(["$48,500", "Crew 3", "Tasks 40%", "Updated 2d ago"]);
  });

  it("a lean, unpriced job with no crew reads just 'No crew' — no '$—', no 'Tasks —'", () => {
    const j = job({
      id: "j",
      name: "J",
      statsCrewCount: 0,
      statsTasksTotal: 0,
      statsTasksComplete: 0,
    });
    expect(jobCardFacts(j, { now })).toEqual(["No crew"]);
  });

  it("nothing loaded at all → an empty line, never dashes", () => {
    expect(jobCardFacts(job({ id: "j", name: "J" }), { now })).toEqual([]);
  });

  it("streamed extras fill the statsOnly gaps; the object's own figures win", () => {
    const j = job({ id: "j", name: "J", contractValue: 1000, statsCrewCount: 1 });
    expect(jobCardFacts(j, { now, contractValue: 999, tasksTotal: 4, tasksComplete: 1 })).toEqual([
      "$1,000",
      "Crew 1",
      "Tasks 25%",
    ]);
  });
});
