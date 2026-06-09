import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilRightNowCard, type RightNowJob } from "./PhilRightNowCard";

const job: RightNowJob = {
  id: "job-1",
  name: "Birdwood Rd — Rough-in",
  status: "active",
  siteAddress: "12 Birdwood Rd, Sydney",
};

/**
 * SSR smoke for the A·Right Now lead card: the navy accent hero linking to the
 * real job, the real status, real opt-in open-work counts, and — critically —
 * NO fabricated counts when the stats are absent (the honesty gate this whole
 * PR turns on).
 */
function render(j: RightNowJob) {
  return renderToString(createElement(PhilRightNowCard, { job: j }));
}

describe("PhilRightNowCard", () => {
  it("leads with the job as a navy accent hero linking to the real job", () => {
    const html = render(job);
    expect(html).toContain("Birdwood Rd — Rough-in");
    expect(html).toContain("12 Birdwood Rd, Sydney");
    expect(html).toContain("/phil/jobs/job-1");
    expect(html).toContain("Open job");
    // navy is used as an accent tile here (not a page background)
    expect(html).toContain("bg-brand-navy");
    // and never leaks the admin-side "Draft" word for a field-visible job
    expect(html).not.toContain("Draft");
  });

  it("shows real 'open work' counts when the job carries opt-in stats", () => {
    const html = render({ ...job, statsSnagsV2Active: 1, statsItpsActive: 2 });
    expect(html).toContain("1 snag");
    expect(html).toContain("2 ITPs");
  });

  it("renders no count chips when stats are absent (graceful, no fake state)", () => {
    const html = render(job);
    expect(html).toContain("Birdwood Rd — Rough-in");
    expect(html).not.toContain("snag");
    expect(html).not.toContain("ITP");
  });

  it("omits the address line when the job has none (no em-dash placeholder)", () => {
    const html = render({ id: "j2", name: "No-address job" });
    expect(html).toContain("No-address job");
    expect(html).not.toContain("—");
  });
});
