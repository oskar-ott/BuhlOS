import { describe, expect, it } from "vitest";
import { explainHoursProblem, type HoursAction } from "./problem";

/**
 * Owner pull 2026-10-11: "I want clear instructions to pop up if there is an
 * error — simple explanations of what went wrong and why." Every case below
 * is a REAL response the hours APIs send (the strings are copied from
 * api/time-entries*.js), and each must come out as plain words: what went
 * wrong, why, what to do — never "Bad Request", a code or a status number.
 */

const err = (status: number, error: string, extra: Record<string, unknown> = {}) => ({
  status,
  body: { error, ...extra },
});

function words(action: HoursAction, input: Parameters<typeof explainHoursProblem>[1]) {
  const p = explainHoursProblem(action, input);
  return [p.title, p.why, p.todo].join(" | ");
}

describe("explainHoursProblem — no answer", () => {
  it("a dropped connection says nothing was saved and to try again with signal", () => {
    const p = explainHoursProblem("log", { status: 0, kind: "network", body: null });
    expect(p.title).toBe("No connection");
    expect(p.todo).toBe("Nothing was saved. Try again when you've got signal.");
    expect(p.canRetry).toBe(true);
  });
  it("a timeout never claims it didn't go — check first", () => {
    const p = explainHoursProblem("change", { status: 0, kind: "timeout", body: null });
    expect(p.title).toBe("No answer — it may not have gone through");
    expect(p.todo).toMatch(/^Check the day/);
  });
  it("a lost send says to check 'already emailed' before sending again", () => {
    const p = explainHoursProblem("send", { status: 0, kind: "timeout" });
    expect(p.todo).toMatch(/emailed/);
  });
});

describe("explainHoursProblem — the boss's Fix", () => {
  it("fixing your own hours: why, and where to do it instead", () => {
    const p = explainHoursProblem("fix", err(403, "cannot amend your own hours"));
    expect(p.caption).toBe("Fix not saved");
    expect(p.title).toBe("You can't do this to your own hours");
    expect(p.why).toBe("Nobody fixes their own pay from the office side.");
    expect(p.todo).toMatch(/Change these hours/);
    expect(p.canRetry).toBe(false);
  });
  it("a leading hand trying to fix: send it back instead", () => {
    expect(words("fix", err(403, "forbidden — only the office can change someone’s hours"))).toMatch(
      /^Only the office can fix hours .* Send it back to them with a reason instead\.$/,
    );
  });
  it("a day approved meanwhile: reopen it first", () => {
    const p = explainHoursProblem(
      "fix",
      err(409, "entry is not submitted — only hours waiting on a decision can be fixed here", {
        currentStatus: "approved",
      }),
    );
    expect(p.title).toBe("This day's already approved");
    expect(p.todo).toBe("To change it, reopen it first, then fix it.");
  });
  it("a day sent back meanwhile / never sent in", () => {
    expect(explainHoursProblem("fix", err(409, "entry is not submitted", { currentStatus: "rejected" })).title).toBe(
      "This day was sent back",
    );
    expect(explainHoursProblem("fix", err(409, "entry is not submitted", { currentStatus: "draft" })).title).toBe(
      "This day hasn't been sent in",
    );
  });
  it("the worker changed it a moment ago (CAS conflict / stale read): refresh first", () => {
    for (const input of [
      err(409, "conflict", { currentRev: "r9" }),
      err(409, "conflict", { code: "stale_read", message: "This day changed moments ago — try again in a minute." }),
    ]) {
      const p = explainHoursProblem("fix", input);
      expect(p.title).toBe("This day just changed");
      expect(p.todo).toBe("Nothing was saved. Refresh, check the day, then try again.");
    }
  });
  it("a job day needs a job; a reason is required", () => {
    expect(explainHoursProblem("fix", err(400, "pick the job these hours are for")).title).toBe("Pick a job");
    expect(explainHoursProblem("fix", err(400, "reason required")).title).toBe("Add a reason");
  });
});

describe("explainHoursProblem — approve, send back, undo", () => {
  it("approving your own hours / a leading hand outside their jobs", () => {
    expect(explainHoursProblem("approve", err(403, "cannot approve your own hours")).todo).toBe(
      "Ask someone else in the office to do it.",
    );
    expect(explainHoursProblem("approve", err(403, "you can only approve hours for jobs you run")).title).toBe(
      "That's not one of your jobs",
    );
    expect(
      explainHoursProblem("sendBack", err(403, "leading hands cannot act on other leading hands — admin only")).title,
    ).toBe("That's not one of your jobs");
  });
  it("approving a day nobody's waiting on", () => {
    const p = explainHoursProblem("approve", err(400, "entry is not submitted"));
    expect(p.title).toBe("This day isn't waiting for approval");
  });
  it("undo after the 30 seconds", () => {
    expect(explainHoursProblem("undo", err(400, "undo window expired (30s)")).title).toBe("Too late to undo");
    expect(explainHoursProblem("undo", err(400, "no rejectedAt stamp — undo window expired")).title).toBe(
      "Too late to undo",
    );
  });
});

describe("explainHoursProblem — the worker logging and changing", () => {
  it("a day that's already approved is locked: ask the office to reopen it", () => {
    const p = explainHoursProblem("change", err(403, "cannot edit approved entry — ask admin to reopen it"));
    expect(p.caption).toBe("Change not sent");
    expect(p.title).toBe("This day's already approved");
    expect(p.todo).toBe("Ask the office to reopen it, then change it.");
  });
  it("a job that can't take hours", () => {
    expect(
      explainHoursProblem(
        "log",
        err(403, "forbidden — hours can only be logged against a job that is live or finished, not archived or draft"),
      ).title,
    ).toBe("That job can't take hours");
    expect(explainHoursProblem("change", err(403, "forbidden — hours can only be logged against an active job")).title).toBe(
      "That job can't take hours",
    );
  });
  it("too far back / the future / already logged", () => {
    expect(explainHoursProblem("log", err(400, "cannot log more than 14 days in the past")).title).toBe(
      "That day's too far back",
    );
    expect(explainHoursProblem("log", err(400, "cannot log future dates")).title).toBe("That day hasn't happened yet");
    expect(explainHoursProblem("log", err(409, "entry already exists for that date — edit it instead")).title).toBe(
      "This day's already logged",
    );
  });
  it("a day saved moments ago from another phone: wait a minute (not 'refresh' — that's the office's word)", () => {
    const p = explainHoursProblem("change", err(409, "conflict", { code: "stale_read" }));
    expect(p.todo).toBe("Nothing was saved. Wait a minute, then try again.");
  });
  it("hours that don't add up", () => {
    expect(
      explainHoursProblem("log", err(400, "totalHours must be ≤ 16; allocation hours must sum to totalHours")).title,
    ).toBe("Those hours don't add up");
  });
  it("an account that can't log hours is not 'bad hours'", () => {
    expect(explainHoursProblem("change", err(400, "cannot edit hours for this role")).title).toBe(
      "This account can't log hours",
    );
  });
  it("signed out", () => {
    const p = explainHoursProblem("log", { status: 401, body: { error: "unauthorised" } });
    expect(p.title).toBe("You've been signed out");
    expect(p.todo).toBe("Sign in again. Nothing was saved.");
  });
});

describe("explainHoursProblem — sending the week to accounts", () => {
  it.each([
    [err(503, "x", { code: "settling", retryAfterMs: 4000 }), "Hours are still saving"],
    [err(503, "No recipients yet", { code: "not_configured" }), "No one to send it to"],
    [err(422, "No approved hours in this period — nothing was sent.", { code: "empty_period" }), "Nothing approved yet"],
    [err(502, "The email provider refused the send (rate_limited)", { code: "rate_limited" }), "The email didn't go"],
    [err(503, "payroll read refused — 2 day record(s) could not be read consistently"), "Some hours couldn't be read"],
  ])("%o → %s", (input, title) => {
    const p = explainHoursProblem("send", input);
    expect(p.title).toBe(title);
    expect(p.caption).toBe("Timesheets not sent");
  });
  it("a 502 from reading the hours (no code) never blames the email", () => {
    const p = explainHoursProblem("send", { status: 502, body: { error: "blob list failed: fetch failed" } });
    expect(p.title).toBe("Couldn't reach the hours");
    expect(p.todo).toBe("Nothing was sent. Try again in a minute.");
    expect(p.canRetry).toBe(true);
  });
});

describe("explainHoursProblem — never jargon", () => {
  const cases: Array<[HoursAction, Parameters<typeof explainHoursProblem>[1]]> = [
    ["log", { status: 400, body: "Bad Request" }],
    ["fix", { status: 500, body: null }],
    ["approve", { status: 418, body: { error: "teapot" } }],
    ["send", { status: 0 }],
    ["undo", err(404, "not found")],
  ];
  it.each(cases)("%s %o — no status words, codes or numbers", (action, input) => {
    const all = words(action, input);
    expect(all).not.toMatch(/Bad Request|Conflict|Forbidden|status|HTTP|\b[45]\d\d\b|null|undefined/i);
    const p = explainHoursProblem(action, input);
    expect(p.title.length).toBeGreaterThan(0);
    expect(p.why.length).toBeGreaterThan(0);
    expect(p.todo.length).toBeGreaterThan(0);
  });
});

describe("explainHoursProblem — the pay run never dead-ends (2026-10-12)", () => {
  it("a day that can't be read names how many and offers to send without it", () => {
    const p = explainHoursProblem("send", {
      status: 503,
      body: { error: "payroll read refused — …", code: "unreadable", days: [{ userId: "u1", date: "2026-10-09" }] },
    });
    expect(p.title).toBe("A day couldn't be read");
    expect(p.why).toContain("1 day");
    expect(p.todo).toContain("send without it");
    expect(p.todo).toContain("named on the sheet");
    expect(p.canRetry).toBe(true);
  });

  it("the email service refusing points at the PDF as the way through", () => {
    const p = explainHoursProblem("send", { status: 502, body: { error: "…", code: "rate_limited" } });
    expect(p.todo).toContain("download the PDF and email it to Tia yourself");
  });

  it("a download speaks download, not send", () => {
    const settling = explainHoursProblem("download", { status: 503, body: { code: "settling", retryAfterMs: 5000 } });
    expect(settling.caption).toBe("Download didn't start");
    expect(settling.todo).toContain("download it again");
    expect(explainHoursProblem("download", { status: 422, body: { code: "empty_period" } }).todo).toBe(
      "Approve the days first, then download.",
    );
  });

  it("taking back a day the worker already re-sent says so in site words", () => {
    const p = explainHoursProblem("takeBack", {
      status: 400,
      body: { error: 'cannot reopen entry with status "submitted" — only approved or rejected entries can be reopened' },
    });
    expect(p.title).toBe("This day isn't sent back any more");
  });

  it("sending in a day that's no longer a draft says so in site words", () => {
    const p = explainHoursProblem("sendIn", {
      status: 403,
      body: { error: "status can only change to submitted after editing draft or rejected hours" },
    });
    expect(p.title).toBe("This day isn't a draft any more");
  });
});

