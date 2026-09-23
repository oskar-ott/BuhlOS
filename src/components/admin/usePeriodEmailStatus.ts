"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * "Who gets this email, and did it already go?" for one pay period — the read
 * both timesheet-send surfaces (desktop SendTimesheetsCard, phone
 * WeeklyCloseoutSendFinale) show BEFORE the send button (2026-09-23 usability
 * audit). Sending stamps nothing on the hours (ADR #609), so without this the
 * screens said "Tia" whoever the Settings list named, and offered a second
 * send of a week accounts already had with no hint it had gone.
 *
 * Source: GET /api/time-entries-email?fromDate&toDate — the stored recipient
 * list + the newest hours.timesheets_emailed journal entry for that exact
 * period. A failed read is "unknown", never "not sent" (P7).
 */

export interface PeriodEmailSend {
  at: string;
  byName: string | null;
  recipients: string[];
  workerCount: number;
  totalHours: number;
}

export type PeriodEmailStatus =
  | { kind: "loading" }
  | { kind: "ready"; recipients: string[]; lastSent: PeriodEmailSend | null }
  | { kind: "unknown"; recipients: string[] };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function parsePeriodEmailStatus(data: unknown): PeriodEmailStatus {
  const d = (data ?? {}) as Record<string, unknown>;
  const recipients = strings(d.recipients);
  if (d.lastSentUnknown === true) return { kind: "unknown", recipients };
  const raw = d.lastSent as Record<string, unknown> | null | undefined;
  if (raw === undefined) return { kind: "unknown", recipients };
  if (raw === null) return { kind: "ready", recipients, lastSent: null };
  if (typeof raw.at !== "string") return { kind: "unknown", recipients };
  return {
    kind: "ready",
    recipients,
    lastSent: {
      at: raw.at,
      byName: typeof raw.byName === "string" && raw.byName ? raw.byName : null,
      recipients: strings(raw.recipients),
      workerCount: Number(raw.workerCount) || 0,
      totalHours: Number(raw.totalHours) || 0,
    },
  };
}

/** "Tue 22 Sep, 4:32 pm by Tom" — the journal's real timestamp and actor. */
export function formatPeriodSend(send: PeriodEmailSend): string {
  const when = new Date(send.at);
  const label = Number.isNaN(when.getTime())
    ? send.at
    : when.toLocaleString("en-AU", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      });
  return send.byName ? `${label} by ${send.byName}` : label;
}

export function usePeriodEmailStatus(fromDate: string, toDate: string) {
  const [status, setStatus] = useState<PeriodEmailStatus>({ kind: "loading" });
  const [seq, setSeq] = useState(0);
  const refresh = useCallback(() => setSeq((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams({ fromDate, toDate });
    fetch(`/api/time-entries-email?${qs.toString()}`, { cache: "no-store" })
      .then(async (res) => {
        const data = res.ok ? await res.json().catch(() => null) : null;
        if (!alive) return;
        setStatus(data ? parsePeriodEmailStatus(data) : { kind: "unknown", recipients: [] });
      })
      .catch(() => {
        if (alive) setStatus({ kind: "unknown", recipients: [] });
      });
    return () => {
      alive = false;
    };
  }, [fromDate, toDate, seq]);

  return { status, refresh };
}
