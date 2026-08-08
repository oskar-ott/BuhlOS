"use client";

import { useCallback, useEffect, useState } from "react";
import { HardHat, ShieldCheck, Map as RoomMapIcon } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PhilBackLink } from "./ui/PhilBackLink";
import { PhilJobHero } from "./PhilJobHero";
import { PhilJobSiteCard } from "./PhilJobSiteCard";
import { usePhilJobRoomsBarRegistration } from "./philJobRoomsBar";
import type { PhilJobRoom } from "./philJobRooms";
import {
  confirmInduction,
  type InductionRecord,
} from "@/domains/jobs/induction";
import type { Job } from "@/domains/jobs/types";

interface Props {
  job: Job;
  /** #332: this worker's latest induction record — null = none on file. */
  initialMyInduction?: InductionRecord | null;
}

/**
 * Phil — basic job view (the "start afresh" reset).
 *
 * The job screen is deliberately just the job's basic information: hero
 * (name · status · address), key dates, and the Site details reference card
 * with the induction confirm (#332) — a worker tapping a job gets the facts
 * and nothing half-built.
 *
 * The previous work/capture/proof machinery (work-to-do tree, capture
 * section, Test & Tag panel, ITP builder link-out, rooms views) was removed
 * to be rebuilt from scratch — restore from git history if reference is
 * needed. The bottom rooms bar (Work · Proof · Site) is KEPT: the tabs are
 * honest "coming soon" placeholders (labelled, never fake controls — P7),
 * so the navigation shape workers know survives the rebuild.
 *
 * Cross-ref:
 *   src/app/phil/jobs/[jobId]/page.tsx — the (only) caller
 *   src/components/phil/philJobRoomsBar.tsx — the tab-bar binding bridge
 */
export function PhilJobBasicView({ job, initialMyInduction = null }: Props) {
  const [room, setRoom] = useState<PhilJobRoom>("now");

  // Rebind the global tab bar to the in-job rooms while this screen is
  // mounted. Badges are hard zeros — the counting machinery is gone, and an
  // invented number would be fake UI (P7).
  const register = usePhilJobRoomsBarRegistration();
  useEffect(() => {
    register({
      active: room,
      badges: { now: 0, work: 0, proof: 0 },
      onSelect: setRoom,
    });
    return () => register(null);
  }, [register, room]);

  // #332: induction completion is server truth — the tap is NON-optimistic
  // (state flips only after the API confirms; a failed save shows the error
  // inside the notice, never a phantom "done").
  const [myInduction, setMyInduction] = useState<InductionRecord | null>(
    initialMyInduction,
  );
  const [inductionSaving, setInductionSaving] = useState(false);
  const [inductionError, setInductionError] = useState<string | null>(null);
  const handleConfirmInduction = useCallback(async () => {
    setInductionSaving(true);
    setInductionError(null);
    const result = await confirmInduction(job.id);
    setInductionSaving(false);
    if (!result.ok) {
      setInductionError(result.error.message);
      return;
    }
    setMyInduction(result.data.record);
  }, [job.id]);

  return (
    <div className="space-y-4">
      <PhilBackLink href="/phil/jobs">All jobs</PhilBackLink>

      {room === "now" ? (
        <>
          <PhilJobHero job={job} />
          <JobDatesCard job={job} />
          <PhilJobSiteCard
            job={job}
            defaultOpen
            induction={
              job.inductionRequired
                ? {
                    state: myInduction ? "done" : "required",
                    completedAt: myInduction?.completedAt ?? null,
                    onConfirm: handleConfirmInduction,
                    saving: inductionSaving,
                    error: inductionError,
                  }
                : null
            }
          />
        </>
      ) : (
        <ComingSoonCard room={room} />
      )}
    </div>
  );
}

/** Start / target dates, only when the office has set either. */
function JobDatesCard({ job }: { job: Job }) {
  const start = formatDate(job.startDate);
  const due = formatDate(job.dueDate);
  if (!start && !due) return null;
  return (
    <Card>
      <CardTitle>Dates</CardTitle>
      <dl className="mt-2 space-y-1 text-sm text-text">
        {start ? <DateRow label="Starts">{start}</DateRow> : null}
        {due ? <DateRow label="Target">{due}</DateRow> : null}
      </dl>
    </Card>
  );
}

function DateRow({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-14 shrink-0 font-display text-[12px] uppercase tracking-wider text-text-muted">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

/** "12 Jun 2026" from YYYY-MM-DD; null for blank/invalid. */
function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return `${Number(m[3])} ${months[monthIndex]} ${m[1]}`;
}

const COMING_SOON: Record<
  Exclude<PhilJobRoom, "now">,
  { title: string; icon: typeof HardHat; body: string }
> = {
  work: {
    title: "Work",
    icon: HardHat,
    body: "Your task list for this job is being rebuilt.",
  },
  proof: {
    title: "Proof",
    icon: ShieldCheck,
    body: "Photo proof for this job is being rebuilt.",
  },
  site: {
    title: "Site",
    icon: RoomMapIcon,
    body: "The full site view is being rebuilt. Site details are on the job screen for now.",
  },
};

/** Honest placeholder for a room that isn't built yet — labelled, no fake
 *  controls, no invented numbers (P7). */
function ComingSoonCard({ room }: { room: Exclude<PhilJobRoom, "now"> }) {
  const def = COMING_SOON[room];
  const Icon = def.icon;
  return (
    <Card data-testid={`phil-room-coming-soon-${room}`}>
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="h-5 w-5 text-text-muted" />
        <CardTitle className="m-0">{def.title} — coming soon</CardTitle>
      </div>
      <CardDescription className="mt-2">{def.body}</CardDescription>
    </Card>
  );
}
