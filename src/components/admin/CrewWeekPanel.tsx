"use client";

import { useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { fetchCrewWeek, type CrewWeekResponse, type CrewWeekDay } from "@/domains/workforce/crew-week-client";

/**
 * Weekly crew availability (#337) — who's on leave / assigned / free this week,
 * one screen. Read-only; rows link out to the job and the leave queue. Approved
 * leave only; assignment is current-state (labelled), not a dated schedule. No
 * hours/cost numbers (that's Epic 14).
 */

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CrewWeekPanel() {
  const [data, setData] = useState<CrewWeekResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchCrewWeek();
      if (cancelled) return;
      if (!res.ok) {
        setState("error");
        return;
      }
      setData(res.data);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card role="region" aria-label="Crew availability this week">
      <CardTitle>Crew this week</CardTitle>
      <CardDescription className="mt-1">
        Who&rsquo;s on leave, assigned, or free — approved leave only; the job column
        is who&rsquo;s <em>currently</em> assigned, not a forward schedule.
      </CardDescription>

      {state === "loading" ? (
        <p className="mt-3 text-sm text-text-muted">Loading…</p>
      ) : state === "error" || !data ? (
        <p className="mt-3 text-sm text-text-muted">Couldn&rsquo;t load the crew week.</p>
      ) : data.workers.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">No active tracked crew.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase tracking-wider text-text-muted">
                <th className="pb-1 pr-2 font-normal">Worker</th>
                {data.weekDays.map((d, i) => (
                  <th key={d} className="pb-1 px-1 text-center font-normal">{DOW[i]}</th>
                ))}
                <th className="pb-1 pl-2 font-normal">Currently on</th>
              </tr>
            </thead>
            <tbody>
              {data.workers.map((w) => (
                <tr key={w.id} className="border-t border-border">
                  <td className="py-1.5 pr-2 text-text">{w.name}</td>
                  {w.days.map((day) => (
                    <td key={day.date} className="py-1.5 px-1 text-center">
                      <DayCell day={day} />
                    </td>
                  ))}
                  <td className="py-1.5 pl-2 text-text-muted">
                    {w.assignedJobNames.length ? w.assignedJobNames.join(", ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function DayCell({ day }: { day: CrewWeekDay }) {
  if (day.state === "leave") {
    return (
      <span
        title={`On ${day.leaveType ?? "leave"}`}
        className="inline-flex items-center rounded-pill bg-amber-100 px-1.5 text-[10px] font-medium text-amber-800"
      >
        {(day.leaveType ?? "leave").slice(0, 4)}
      </span>
    );
  }
  if (day.state === "assigned") {
    return <span className="text-emerald-700" aria-label="assigned">●</span>;
  }
  return <span className="text-text-muted/50" aria-label="free">·</span>;
}
