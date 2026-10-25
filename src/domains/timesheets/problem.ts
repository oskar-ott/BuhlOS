/**
 * What went wrong, why, and what to do — in plain words — for every hours and
 * timesheet action that can fail (owner pull 2026-10-11: "I want clear
 * instructions to pop up if there is an error — simple explanations of what
 * went wrong and why").
 *
 * Before this, a refused save showed the browser's status word — "Bad
 * Request", "Conflict", "Forbidden" — because src/lib/http.ts puts
 * `res.statusText` in `error.message` and the server's real reason sits in
 * `error.body`. This module reads the body (the server's `error` text, its
 * `code`, a 409's `currentStatus`) plus the network failure kind, and answers
 * in site language (P11): a short title, one sentence of why, one or two of
 * what to do. Never a code, never a status number, never the server's raw
 * sentence (P7: honest, but in words the crew use).
 *
 * PURE — no React, no I/O — so every mapping is pinned by tests and the
 * worker's phone, the boss's closeout and the send screens all say the same
 * thing about the same failure.
 */

export type HoursAction =
  | "log" // a worker logging a new day
  | "change" // a worker changing or fixing a day they sent
  | "fix" // the office fixing a day and approving it
  | "approve"
  | "sendBack"
  | "undo"
  | "send" // emailing the week's timesheets to accounts
  | "download" // the payroll PDF / CSV from the office
  | "takeBack" // the office taking a sent-back day back to decide it
  | "sendIn"; // the office sending a worker's saved draft in for them

export interface HoursProblem {
  /** What didn't happen — "Fix not saved". Small caption above the title. */
  caption: string;
  /** What went wrong — one short line, the pop-up's heading. */
  title: string;
  /** Why it happened — one plain sentence. */
  why: string;
  /** What to do next — one or two plain sentences. */
  todo: string;
  /** Trying again straight away can work, so the pop-up offers "Try again". */
  canRetry: boolean;
}

/** The parts of a failed request this needs — `HttpError` fits as-is. */
export interface ProblemInput {
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  /** For status 0: the request timed out, or never connected. */
  kind?: "timeout" | "network";
  /** The server's JSON body: { error, code, currentStatus, … }. */
  body?: unknown;
}

const CAPTION: Record<HoursAction, string> = {
  log: "Hours not saved",
  change: "Change not sent",
  fix: "Fix not saved",
  approve: "Not approved",
  sendBack: "Not sent back",
  undo: "Not undone",
  send: "Timesheets not sent",
  download: "Download didn't start",
  takeBack: "Not taken back",
  sendIn: "Not sent in",
};

/** "Nothing was saved." — in the right verb for the action. */
function nothingHappened(action: HoursAction): string {
  if (action === "send") return "Nothing was sent.";
  if (action === "download") return "Nothing was downloaded.";
  if (action === "takeBack") return "The day is still waiting on the worker.";
  if (action === "sendIn") return "The day is still a draft.";
  if (action === "approve") return "Nothing was approved.";
  if (action === "sendBack") return "Nothing was sent back.";
  if (action === "undo") return "Nothing was undone.";
  return "Nothing was saved.";
}

const OFFICE_ACTIONS: ReadonlySet<HoursAction> = new Set([
  "fix",
  "approve",
  "sendBack",
  "undo",
  "takeBack",
  "sendIn",
]);

/** How many days a payroll refusal named (its structured `days`), or 0. */
function namedDayCount(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const days = (body as Record<string, unknown>).days;
  return Array.isArray(days) ? days.length : 0;
}

function field(body: unknown, key: string): string {
  if (!body || typeof body !== "object") return "";
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

export function explainHoursProblem(action: HoursAction, input: ProblemInput): HoursProblem {
  const caption = CAPTION[action];
  const office = OFFICE_ACTIONS.has(action);
  const status = Number(input.status) || 0;
  const error = field(input.body, "error").toLowerCase();
  const code = field(input.body, "code");
  const currentStatus = field(input.body, "currentStatus");
  const say = (title: string, why: string, todo: string, canRetry = false): HoursProblem => ({
    caption,
    title,
    why,
    todo,
    canRetry,
  });

  // ── No answer at all ────────────────────────────────────────────────
  if (status === 0) {
    if (input.kind === "timeout") {
      return say(
        "No answer — it may not have gone through",
        "Your phone didn't hear back in time, usually because of weak signal.",
        action === "send"
          ? "Check whether the week shows as emailed. If it doesn't, try again when you've got signal."
          : "Check the day. If it hasn't changed, try again when you've got signal.",
        true,
      );
    }
    return say(
      "No connection",
      "Your phone couldn't reach BuhlOS — usually no signal or Wi-Fi.",
      `${nothingHappened(action)} Try again when you've got signal.`,
      true,
    );
  }

  // ── Sending the week to accounts / downloading the sheet ────────────
  if (action === "send" || action === "download") {
    const again = action === "send" ? "press Send again" : "download it again";
    if (code === "settling") {
      return say(
        "Hours are still saving",
        "Some days in this week changed in the last minute and are still settling.",
        `${nothingHappened(action)} It's safe to ${again} in a minute.`,
        true,
      );
    }
    // A day that waiting won't clear (2026-10-12): never a dead end — the
    // screen names the days and offers to leave them off, named on the sheet.
    if (code === "unreadable") {
      const n = namedDayCount(input.body);
      const days = n === 1 ? "1 day" : n > 1 ? `${n} days` : "some days";
      return say(
        `${n === 1 ? "A day" : "Some days"} couldn't be read`,
        `BuhlOS couldn't open ${days} in this week cleanly — usually a storage hiccup that clears in a few minutes.`,
        action === "send"
          ? `${nothingHappened(action)} Try again in a few minutes — or send without ${n === 1 ? "it" : "them"}: ${n === 1 ? "it's" : "they're"} named on the sheet so Tia checks ${n === 1 ? "it" : "them"} before paying.`
          : `${nothingHappened(action)} Try again in a few minutes — or download without ${n === 1 ? "it" : "them"}: the sheet names ${n === 1 ? "it" : "them"} so ${n === 1 ? "it isn't" : "they aren't"} missed.`,
        true,
      );
    }
  }
  if (action === "download") {
    if (status === 422 || code === "empty_period") {
      return say(
        "Nothing approved yet",
        "This week has no approved hours, so there's nothing to put on the sheet.",
        "Approve the days first, then download.",
      );
    }
  }

  if (action === "send") {
    if (code === "not_configured") {
      return say(
        "No one to send it to",
        "There's no accounts email set up for timesheets yet.",
        "Add the accounts email in Settings → Timesheet emails, then send again.",
      );
    }
    if (code === "empty_period" || status === 422) {
      return say(
        "Nothing approved yet",
        "This week has no approved hours, so there's nothing to put on the sheet.",
        "Approve the days first, then send.",
      );
    }
    // The email provider's refusal always names its reason in `code`. A 502
    // without one is the hours read failing (answered below), not the email.
    if (status === 502 && code) {
      return say(
        "The email didn't go",
        "The email service turned it down just then.",
        "Nothing reached accounts. Try again in a few minutes — or download the PDF and email it to Tia yourself. It's the same sheet.",
        true,
      );
    }
    if (status === 503 && error.includes("refused")) {
      return say(
        "Some hours couldn't be read",
        "BuhlOS couldn't read every day in this week cleanly, so it stopped rather than send a short sheet.",
        "Nothing was sent. Wait a minute, then press Send again.",
        true,
      );
    }
  }

  // ── The day moved underneath the action ─────────────────────────────
  if (code === "stale_read" || error === "conflict" || (status === 409 && !currentStatus && !error.includes("already exists"))) {
    return office
      ? say(
          "This day just changed",
          "It was changed moments ago — maybe by the worker on their phone.",
          `${nothingHappened(action)} Refresh, check the day, then try again.`,
        )
      : say(
          "This day just changed",
          "It was saved moments ago — maybe from another phone.",
          `${nothingHappened(action)} Wait a minute, then try again.`,
        );
  }
  if (code === "read_failed" || error.includes("blob list")) {
    return say(
      "Couldn't reach the hours",
      "BuhlOS's storage didn't answer just then.",
      `${nothingHappened(action)} Try again in a minute.`,
      true,
    );
  }

  // ── The day isn't in a state this action works on ───────────────────
  if (error.includes("cannot reopen entry with status")) {
    return say(
      "This day isn't sent back any more",
      "The worker may have fixed it and sent it in again since this screen loaded.",
      "Refresh to see where it's at.",
    );
  }
  if (error.includes("status can only change to submitted")) {
    return say(
      "This day isn't a draft any more",
      "It was sent in or decided since this screen loaded.",
      "Refresh to see where it's at.",
    );
  }
  if (error.includes("not submitted") || currentStatus) {
    if (currentStatus === "approved") {
      return say(
        "This day's already approved",
        "It was approved before this went through.",
        action === "fix"
          ? "To change it, reopen it first, then fix it."
          : "Nothing to do — it's already approved.",
      );
    }
    if (currentStatus === "rejected") {
      return say(
        "This day was sent back",
        "It's waiting for the worker to fix it.",
        "Wait for them to send it again.",
      );
    }
    if (currentStatus === "draft") {
      return say(
        "This day hasn't been sent in",
        "The worker hasn't sent it to the office yet.",
        "Ask them to send it.",
      );
    }
    return say(
      "This day isn't waiting for approval",
      "Someone has already dealt with it.",
      "Refresh to see where it's at.",
    );
  }
  if (error.includes("approved entry") || error.includes("exported")) {
    return say(
      "This day's already approved",
      "Approved days are locked so pay can't change by accident.",
      "Ask the office to reopen it, then change it.",
    );
  }
  if (error.includes("undo window") || error.includes("rejectedat")) {
    return say(
      "Too late to undo",
      "Undo only works for 30 seconds after sending it back.",
      "Reopen the day from This week instead.",
    );
  }
  if (error.includes("only the admin who rejected")) {
    return say(
      "Only the person who sent it back can undo it",
      "Undo belongs to whoever sent the day back.",
      "Ask them, or reopen the day from This week.",
    );
  }

  // ── Who may do what ─────────────────────────────────────────────────
  if (error.includes("your own hours")) {
    return say(
      "You can't do this to your own hours",
      action === "fix"
        ? "Nobody fixes their own pay from the office side."
        : "Only the owner signs off their own pay.",
      action === "fix"
        ? "Change it from your own phone (Hours → Change these hours), or ask someone else in the office."
        : "Ask someone else in the office to do it.",
    );
  }
  if (error.includes("only the office can change") || (action === "fix" && status === 403)) {
    return say(
      "Only the office can fix hours",
      "Leading hands can approve or send back, but changing someone's pay is the office's call.",
      "Send it back to them with a reason instead.",
    );
  }
  if (error.includes("jobs you run") || error.includes("other leading hands") || error.includes("job you run")) {
    return say(
      "That's not one of your jobs",
      "Leading hands can only act on hours for jobs they run.",
      "Ask the office to do it.",
    );
  }

  // ── What was entered ────────────────────────────────────────────────
  if (error.includes("logged against") || error.includes("live or finished") || error.includes("active job")) {
    return say(
      "That job can't take hours",
      "It's archived, still a draft, or you're not on it.",
      "Pick another job, or ask the office to put you on it.",
    );
  }
  if (error.includes("14 days")) {
    return say(
      "That day's too far back",
      "Days more than 14 days ago can't be added or changed from the phone.",
      "Ask the office to sort it.",
    );
  }
  if (error.includes("future")) {
    return say(
      "That day hasn't happened yet",
      "Hours can only go on today or an earlier day.",
      "Pick today or an earlier day.",
    );
  }
  if (error.includes("already exists")) {
    return say(
      "This day's already logged",
      "There's one entry per day.",
      "Open the day and use Change these hours instead.",
    );
  }
  if (error.includes("pick the job")) {
    return say(
      "Pick a job",
      "A job day needs a job.",
      "Send it back so they can pick the job.",
    );
  }
  if (error.includes("reason required")) {
    return say(
      "Add a reason",
      "The worker sees why their day changed.",
      "Type a short reason, then save.",
    );
  }
  if (error.includes("for this role") || error.includes("role cannot")) {
    return say(
      "This account can't log hours",
      "Only crew accounts log hours.",
      "Ask the office to check your account.",
    );
  }
  if (
    status === 400 &&
    (error.includes("hours") || error.includes("allocation") || error.includes("total"))
  ) {
    return say(
      "Those hours don't add up",
      "The time has to be more than 0 and no more than 16 hours, and the parts have to match the total.",
      "Check the hours and try again.",
    );
  }

  // ── Everything else, by status ──────────────────────────────────────
  if (status === 401) {
    return say(
      "You've been signed out",
      "Your sign-in ran out.",
      `Sign in again. ${nothingHappened(action)}`,
    );
  }
  if (status === 404) {
    return say(
      "This day isn't there any more",
      "It was removed or moved since this screen loaded.",
      "Refresh to see the latest.",
    );
  }
  if (status === 403) {
    return say(
      "You can't do that here",
      "Your account doesn't have permission for this.",
      "Ask the office.",
    );
  }
  if (status >= 500) {
    return say(
      "Something went wrong on our side",
      "BuhlOS hit a problem just then.",
      `${nothingHappened(action)} Try again in a minute.`,
      true,
    );
  }
  return say(
    "That didn't work",
    "BuhlOS couldn't do that just then.",
    `${nothingHappened(action)} Try again — if it keeps happening, tell the office.`,
    true,
  );
}
