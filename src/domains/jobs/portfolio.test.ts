import { describe, expect, it } from "vitest";
import {
  buildJobCard,
  buildJobCardFromJob,
  buildPortfolioSummary,
  formatContractValue,
  formatPortfolioTotal,
  jobCardMeta,
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
    const meta = jobCardMeta(job({ id: "j1", name: "A", contractValue: 250000, statsCrewCount: 4 }));
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
    // a soft backlog at the documented threshold ⇒ at-risk via the existing
    // deriveJobHealth engine. (The expired-tags hard signal left with the
    // Test & Tag teardown.)
    const j = job({ id: "j", name: "J", statsEvidenceV2Pending: 10 });
    const vm = buildJobCardFromJob(j);
    expect(vm.health.level).toBe(deriveJobHealth(j).level);
    expect(vm.health.level).toBe("at-risk");
  });
});
