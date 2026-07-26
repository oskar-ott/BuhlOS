"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PhilNotice } from "./ui/PhilNotice";
import { timesheetsClient } from "@/domains/timesheets/client";
import { buildDraftSendPayload } from "./philHoursWeeks";
import type { TimeEntry } from "@/domains/timesheets/types";

type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string; status: number };

/**
 * "Send" for a DRAFT day on the /phil/hours week summary — 2026-07-26
 * owner-directed (kills the draft dead-end: "Draft — not submitted" with no
 * action). PATCHes the existing draft → submitted transition the server
 * already supports (api/time-entries.js handlePatch), via the same
 * `timesheetsClient.editOwnEntry` + `buildDraftSendPayload` pair the
 * sharpened screen's week-send uses — nothing reimplemented.
 *
 * Honest on failure (P7): the day stays a draft and the real error is shown;
 * nothing renders as sent until the server said so.
 */
export function SendDraftDayButton({ entry }: { entry: TimeEntry }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });

  async function send() {
    setState({ kind: "sending" });
    const result = await timesheetsClient.editOwnEntry(entry.date, buildDraftSendPayload(entry));
    if (result.ok) {
      setState({ kind: "sent" });
      // Re-render the server-built summary so the row shows its true new status.
      router.refresh();
      return;
    }
    setState({
      kind: "error",
      status: result.error.status || 0,
      message:
        result.error.status === 401
          ? "Session expired. Sign in again to send it."
          : result.error.message || "Couldn't send this day. It's still saved — try again in a moment.",
    });
  }

  if (state.kind === "sent") {
    return (
      <PhilNotice tone="success" role="status" title="Sent" hideIcon className="py-1">
        Off to the office for approval.
      </PhilNotice>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void send()}
        disabled={state.kind === "sending"}
        data-testid="phil-send-draft-day"
        className="shrink-0 rounded-pill border border-border px-4 py-2 text-sm font-medium text-text hover:border-brand-navy disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state.kind === "sending" ? "Sending…" : "Send"}
      </button>
      {state.kind === "error" ? (
        <PhilNotice tone="danger" role="alert" title="Didn’t go">
          {state.message}
          {state.status ? <span className="ml-1 text-xs">(HTTP {state.status})</span> : null}
        </PhilNotice>
      ) : null}
    </div>
  );
}
