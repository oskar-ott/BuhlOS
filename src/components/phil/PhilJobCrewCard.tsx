"use client";

import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { PhilSkeleton } from "./ui/PhilSkeleton";
import { fetchJobCrew, type JobCrewMember } from "@/domains/jobs/job-crew";

/**
 * Phil — "On site today" card (#426).
 *
 * Shows the other crew who've logged time on THIS job today so a worker knows
 * who's around — coordination/site-awareness, the very use the existing
 * `/api/time-entries-on-site` endpoint was built for. Read-only, client-fetched
 * so it degrades on its own and never blocks the job render.
 *
 * Phil constitution: purely additive, sits in the reference/coordination zone
 * (P10 — one quiet card, not the task flow). P7 — honest states: "Just you so
 * far today" when no one else has logged, and a quiet message (not an alarm)
 * when the read fails; never a fabricated name or count. P11 — site language.
 *
 * The presentation is a pure prop-driven sub-component so the states are
 * SSR-render-testable without mocking fetch.
 */

export type CrewLoadState =
  | { status: "loading" }
  | { status: "ready"; members: ReadonlyArray<JobCrewMember> }
  | { status: "error" };

/** Pure, prop-only render of the crew states (testable without effects). */
export function PhilJobCrewBody({
  state,
  viewerId,
}: {
  state: CrewLoadState;
  viewerId: string | null;
}) {
  if (state.status === "loading") {
    return (
      <div className="mt-3 space-y-2" aria-label="Loading who's on site">
        <PhilSkeleton className="h-4 w-2/3" />
        <PhilSkeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <p className="mt-2 text-sm text-text-muted">
        Couldn&rsquo;t load who&rsquo;s on site right now.
      </p>
    );
  }

  const others = state.members.filter((m) => m.id !== viewerId);
  if (others.length === 0) {
    return <p className="mt-2 text-sm text-text-muted">Just you so far today.</p>;
  }

  return (
    <ul className="mt-3 space-y-1.5" aria-label="On site today">
      {others.map((m) => (
        <li key={m.id} className="flex items-center justify-between gap-3 text-sm">
          <span className="truncate text-text">{m.username}</span>
          <span className="shrink-0 text-text-muted">{`${m.hours}h`}</span>
        </li>
      ))}
    </ul>
  );
}

export function PhilJobCrewCard({
  jobId,
  viewerId,
}: {
  jobId: string;
  viewerId: string | null;
}) {
  const [state, setState] = useState<CrewLoadState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetchJobCrew(jobId).then((r) => {
      if (!alive) return;
      setState(r.ok ? { status: "ready", members: r.data.users } : { status: "error" });
    });
    return () => {
      alive = false;
    };
  }, [jobId]);

  return (
    <Card>
      <CardTitle className="flex items-center gap-2">
        <Users aria-hidden="true" className="h-4 w-4 text-text-muted" />
        On site today
      </CardTitle>
      <PhilJobCrewBody state={state} viewerId={viewerId} />
    </Card>
  );
}
